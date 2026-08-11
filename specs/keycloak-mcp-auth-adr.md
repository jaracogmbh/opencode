# ADR: Keycloak Login For MCP Bearer Authentication

Status: Proposed

## Summary

OpenCode supports a global Keycloak login that can be reused as the bearer token source for remote MCP servers.

The login can complete through browser callback PKCE or OAuth device authorization. This keeps OpenCode responsible for token exchange, refresh, storage, and MCP bearer-token injection instead of pushing those concerns into deployment wrappers.

## Problem

Enterprise MCP deployments often expect a user bearer token from a central Keycloak realm. Static `Authorization` headers are not enough because tokens expire, rotate, and are user-specific. MCP-native OAuth is also a different concern because it is negotiated per MCP server.

OpenCode needs one global user identity that can be shared by many remote MCP servers.

## Decision

Add Keycloak as a first-class global auth provider with:

- Authorization Code + PKCE login
- browser callback completion for hosted sessions
- OAuth device authorization for remote/containerized sessions
- access-token refresh using the stored refresh token
- remote MCP bearer injection for `auth.provider = "keycloak"`

## Login Flow Selection

Keycloak login accepts `auth.keycloak.flow` or `OPENCODE_KEYCLOAK_FLOW`:

- `pkce`: use browser authorization with PKCE
- `device`: use OAuth device authorization and polling
- `auto`: prefer device flow when the issuer advertises support, otherwise use PKCE

The default remains `pkce` to preserve existing behavior.

## Browser Callback Semantics

For browser-hosted sessions, PKCE login can use OpenCode's HTTP callback endpoint:

```text
GET /identity/keycloak/login/callback
```

The callback validates the pending state, resolves the authorization code, exchanges tokens, persists identity, and reconnects enabled Keycloak bearer MCP servers.

Deployment wrappers should proxy this endpoint to OpenCode. They should not exchange Keycloak codes or write OpenCode auth storage directly.

## Device Flow Semantics

For device flow, OpenCode starts device authorization through Keycloak discovery metadata, stores a pending device login, and polls the token endpoint until the user approves or the device code expires.

The `login/start` response includes device-specific fields:

- `verificationUri`
- `verificationUriComplete`
- `userCode`
- `expiresInSeconds`
- `intervalSeconds`

Clients display these details and call `login/finish` with the returned `state` to wait for completion.

## MCP Config Shape

Remote MCP servers opt into the global Keycloak login with:

```jsonc
{
  "mcp": {
    "example": {
      "type": "remote",
      "url": "https://mcp.example.com",
      "auth": {
        "type": "bearer",
        "provider": "keycloak"
      },
      "oauth": false
    }
  }
}
```

`oauth: false` keeps these servers out of MCP-native OAuth negotiation. They receive a normal HTTP bearer token from the global Keycloak identity.

## Runtime Behavior

For Keycloak bearer MCP servers, OpenCode:

1. loads the global Keycloak identity,
2. refreshes the access token when it is expired or close to expiry,
3. removes stale static `Authorization` headers,
4. injects `Authorization: Bearer <token>`,
5. reconnects enabled Keycloak bearer MCP servers after successful login.

## Out Of Scope

- generic dynamic header commands
- machine-to-machine `client_credentials` provider auth
- OS keychain storage
- per-server MCP OAuth token reuse
- automatic mid-request token mutation for already-open MCP transports

## Acceptance Criteria

1. A user can log into Keycloak once from OpenCode.
2. OpenCode can complete login through browser callback PKCE or device flow.
3. OpenCode can refresh stored Keycloak tokens.
4. Remote MCP servers can opt into the global Keycloak bearer token.
5. Missing or expired login state produces a clear auth-related failure mode.
