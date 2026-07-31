# ADR: Keycloak Login For MCP Bearer Authentication

Status: Proposed

## Summary

Add support for logging the OpenCode CLI into Keycloak once and reusing that bearer token for outbound remote MCP server calls.

This should allow multiple MCP servers to share the same global Keycloak-backed CLI identity instead of requiring static bearer headers or separate OAuth flows per server.

## Problem

OpenCode already supports:

- static `Authorization` headers for remote MCP servers
- MCP-native OAuth when a remote MCP server advertises its own OAuth flow

But it does not support this workflow:

1. log into Keycloak once from the CLI
2. keep that OAuth2 session refreshed
3. automatically attach the current bearer token to remote MCP requests
4. reuse the same identity across multiple MCP servers

This gap makes it difficult to integrate OpenCode with enterprise MCP deployments that expect a user bearer token issued by a central identity provider.

## Requested Behavior

OpenCode should support one global Keycloak login for the CLI and allow remote MCP servers to opt into using that login for bearer authentication.

Expected behavior:

1. A user logs into Keycloak once from OpenCode.
2. OpenCode stores access and refresh tokens securely enough for normal CLI reuse.
3. A remote MCP server can declare that its `Authorization` header should come from the global Keycloak login.
4. OpenCode refreshes the token when needed.
5. Multiple MCP servers can reuse the same login.

## Proposed UX

Representative commands:

- `opencode auth login keycloak`
- `opencode auth logout keycloak`
- `opencode auth list`

The UX should make it clear that this is a global login, not a per-MCP-server OAuth session.

## Proposed Config Shape

Remote MCP config needs a first-class way to request bearer auth from the global Keycloak login instead of only allowing static string headers.

Representative shape:

```jsonc
{
  "mcp": {
    "servers": {
      "jira": {
        "type": "remote",
        "url": "https://mcp.example.com",
        "auth": {
          "type": "bearer",
          "provider": "keycloak"
        }
      }
    }
  }
}
```

The final field name does not need to be `auth`, but the feature should provide a runtime auth source instead of encoding this only as a static `headers.Authorization` string.

## Implementation Expectations

### Login flow

Use OAuth2 Authorization Code with PKCE for interactive login.

Stored data should include:

- issuer or realm base URL
- client ID
- optional client secret if required
- access token
- refresh token
- token expiry
- granted scopes

### Separation of concerns

Keycloak login state should live in the global auth system, not in the MCP-specific OAuth store.

Per-MCP OAuth state should remain reserved for MCP-native flows such as:

- dynamically registered MCP client credentials
- MCP code verifier and OAuth state
- MCP access and refresh tokens obtained through the MCP SDK auth provider

### MCP header injection

When creating remote MCP transports, OpenCode should:

1. resolve configured static headers
2. resolve the current Keycloak access token when requested by config
3. set `Authorization: Bearer <token>` on the transport request headers

If both a literal `Authorization` header and a Keycloak bearer source are configured, the runtime bearer token should win by default.

### Refresh behavior

Minimum acceptable behavior:

- refresh the Keycloak token before creating a remote MCP transport when the token is expired or near expiry
- fail MCP connection with a clear typed auth-needed status when no valid Keycloak login exists

Preferred follow-up behavior:

- reconnect or recover cleanly when an already-connected MCP transport later fails due to token expiry

## Why This Matters

- supports enterprise SSO-backed MCP deployments
- reduces duplicated authentication across MCP servers
- avoids hardcoding bearer tokens into config
- creates a reusable foundation for other outbound integrations that may need the same global identity

## Alternatives And Limitations

### Static config headers only

This is not enough because token rotation and expiry handling become manual and external.

### Reusing MCP-native OAuth storage

This would mix two different concerns:

- global user identity
- per-server MCP OAuth negotiation

That makes shared login reuse awkward and harder to reason about.

### Separate login per MCP server

This does not satisfy the main requirement of logging in once and reusing the same Keycloak identity across multiple MCP servers.

## Related Issues

This request is related to existing issues, but it is not a duplicate.

### `#27161` dynamic MCP `headersHelper`

This is the closest related issue.

That request is about a generic command-based runtime header generator for remote MCP servers. It is intentionally broad and helper-driven.

This request is narrower and product-level:

- one built-in global Keycloak login
- managed OAuth2 token persistence and refresh
- reuse of one user identity across multiple MCP servers

If `headersHelper` is implemented, it could help solve dynamic header injection in a generic way, but it still would not define:

- a native Keycloak login flow
- shared global identity semantics
- expected refresh and reuse behavior for one login across many MCP servers

So `#27161` is adjacent infrastructure, while this request is a specific end-user feature built on top of the same general problem space.

### `#24084` provider `client_credentials`

This is not a duplicate.

That request targets configured LLM providers and non-interactive machine-to-machine OAuth using `grant_type=client_credentials`.

This request targets remote MCP authentication and an interactive user login reused across MCP servers.

Key differences:

- provider fetch layer vs MCP transport layer
- machine credential flow vs user login flow
- no refresh token expected vs refreshable user session expected
- provider auth for model traffic vs bearer forwarding for MCP traffic

The enterprise identity domain overlaps, but the runtime surface and auth lifecycle are different.

### `#34582` remote MCP OAuth refresh bug

This is also not a duplicate.

That issue is a bug in existing remote MCP OAuth refresh behavior after the server-specific OAuth flow has already been set up.

This request is for a new capability:

- global Keycloak login
- explicit reuse across multiple MCP servers
- first-class config support for using that global identity as MCP bearer auth

`#34582` is relevant because refresh behavior should be correct for any Keycloak-based solution, but fixing that bug alone would not add the global-login feature requested here.

## Security Notes

- use PKCE for interactive login
- request least-privilege scopes
- never log access or refresh tokens
- persist tokens with restrictive file permissions
- document that initial storage is file-based unless later moved to an OS keychain

## Likely Implementation Areas

- `packages/opencode/src/auth/`
- `packages/opencode/src/cli/cmd/`
- `packages/opencode/src/mcp/index.ts`
- `packages/core/src/v1/config/mcp.ts`
- `packages/core/src/config/mcp.ts`

## Implementation Plan

### Phase 1: Config and schema

Add a runtime auth source for remote MCP servers in both current and v2 config schemas.

Scope:

- extend `packages/core/src/v1/config/mcp.ts`
- extend `packages/core/src/config/mcp.ts`
- keep static `headers` support unchanged
- validate a Keycloak bearer source as an explicit typed config option

Representative shape for implementation:

```jsonc
{
  "type": "remote",
  "url": "https://mcp.example.com",
  "auth": {
    "type": "bearer",
    "provider": "keycloak"
  }
}
```

Deliverables:

- typed schema for remote MCP auth source
- config migration decision for v1 to v2 naming if needed
- docs/examples updated after runtime support lands

### Phase 2: Global Keycloak auth service

Add a dedicated Keycloak-backed login flow in the general auth system rather than in MCP auth storage.

Scope:

- add a new auth module under `packages/opencode/src/auth/`
- reuse existing login patterns already used by interactive account and provider auth flows where possible
- support Authorization Code + PKCE
- persist `access`, `refresh`, `expires`, issuer metadata, client metadata, and scope
- expose one effectful method that returns a fresh access token, refreshing when needed

Suggested service surface:

- `login(config)`
- `logout()`
- `status()`
- `token()`

The `token()` method should be the only runtime dependency MCP needs.

### Phase 3: CLI command surface

Expose Keycloak login management in the CLI.

Scope:

- add or extend auth commands in `packages/opencode/src/cli/cmd/`
- provide login, logout, and status/listing output
- make the UX clearly global rather than per-MCP-server

Expected behavior:

- browser-based login opens automatically when possible
- fallback instructions are printed when opening the browser fails
- status output shows whether the stored session is valid or expired without printing secrets

### Phase 4: MCP transport integration

Integrate the global Keycloak bearer token into remote MCP transport creation.

Scope:

- update `packages/opencode/src/mcp/index.ts`
- resolve static headers first
- resolve the Keycloak bearer token only when the remote server opts into it
- inject `Authorization: Bearer <token>` into `requestInit.headers`

Implementation notes:

- do not mix this with MCP-native OAuth provider state
- prefer one narrow helper for resolved remote headers rather than scattering logic across transport constructors
- keep local MCP transport behavior unchanged

### Phase 5: Failure handling and refresh semantics

Define the first implementation boundary clearly.

Required in first pass:

- refresh the Keycloak token before transport creation when it is stale
- return a clear auth-needed failure when no valid Keycloak login exists
- preserve existing MCP status reporting for unrelated failures

Follow-up, but not required for the first pass:

- retry or reconnect behavior when a connected remote MCP server later rejects a token
- automatic recovery after mid-session expiry without a manual reconnect

### Phase 6: Tests

Add focused tests around config decoding, auth persistence, token refresh, and MCP header injection.

Expected test coverage:

- config schema accepts the new auth shape
- Keycloak auth state persists and refreshes correctly
- remote MCP transports receive the resolved bearer header
- static headers are preserved and runtime `Authorization` overrides a literal configured one
- missing login produces a typed auth failure
- unrelated MCP OAuth flows keep working

Likely test files:

- `packages/opencode/test/config/`
- `packages/opencode/test/mcp/`
- `packages/opencode/test/cli/`
- `packages/opencode/test/server/httpapi-mcp*.test.ts`

### Phase 7: Documentation

After the runtime implementation lands, update user-facing docs.

Scope:

- remote MCP documentation
- auth/login documentation
- example config for enterprise Keycloak-backed MCP deployments

## Out Of Scope For First Iteration

- generic arbitrary dynamic header helpers
- machine-to-machine `client_credentials` provider auth
- OS-native keychain storage
- multi-provider bearer source selection beyond the initial Keycloak case
- mid-request token mutation for already-open MCP transports

## Acceptance Criteria

1. A user can log into Keycloak once from the CLI.
2. OpenCode can refresh the stored Keycloak tokens.
3. A remote MCP server can be configured to use the global Keycloak bearer token.
4. The bearer token is attached to outbound remote MCP transport requests.
5. Multiple MCP servers can reuse the same Keycloak login.
6. Missing or expired login state produces a clear auth-related failure mode.
