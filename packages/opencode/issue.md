# MCP Keycloak Bearer Token Expiry Issue

doc

## Summary

Remote Jaraco Data Mesh MCP calls could start successfully, then later fail with `Token validation failed` after calling a different MCP server that returned an expected authorization error.

The observed sequence was:

1. Start opencode from the repository with `bun run dev`.
2. Log in to Keycloak with valid credentials.
3. Ask `main-mcp-server` for data products. This succeeds.
4. Ask `jira_mcp_server` for recent tickets. This returns `Access denied for resource classification`, which is expected for the current user permissions.
5. Ask `main-mcp-server` for contracts or products again. This can fail with `Token validation failed`.

At first glance this looked like the Jira MCP denial was poisoning the auth state for the main MCP server. That was not the actual root cause.

## Expected Behavior

`jira_mcp_server` may deny access to Jira operational data when the user lacks the required classification role. That denial should be isolated to the Jira tool call.

Subsequent calls to `main-mcp-server` should continue to work as long as the user's Keycloak session can provide or refresh a valid access token.

## Actual Behavior

After some time, subsequent `main-mcp-server` requests failed with:

```text
Streamable HTTP error: Error POSTing to endpoint: {"detail":"Token validation failed"}
```

The logs showed bursts of `401 Unauthorized` from `main-mcp-server`, followed by successful requests after reconnect or re-authentication. This indicated that the server was healthy and the client was sending an invalid or expired bearer token.


## Root Cause

In opencode, remote MCP bearer auth was resolved only once when the MCP transport was created.

The old flow was:

1. `connectRemote` called `keycloakAuth.token()` once.
2. The returned access token was stored in `requestInit.headers.Authorization`.
3. The MCP SDK transport reused that static `Authorization` header for all future HTTP requests.

This meant the MCP transport kept using the original Keycloak access token after it expired. `KeycloakAuth.token()` already knows how to refresh tokens, but the MCP transport was not calling it for later requests.

The Jira classification denial was only correlated with the issue. It did not corrupt the token. The real trigger was that enough time had passed for the originally captured access token to become invalid.

## Fix

The fix was made in:

```text
packages/opencode/src/mcp/index.ts
```

The remote MCP bearer-auth path now uses the MCP SDK transport's `fetch` hook instead of a static `Authorization` header.

For Keycloak bearer-auth MCP servers, opencode now:

1. Validates at connection time that a token is available.
2. Installs a custom `fetch` function on the MCP transport.
3. Calls `keycloakAuth.token()` for each outgoing MCP HTTP request.
4. Sets `Authorization: Bearer <fresh-token>` immediately before sending the request.
5. Coalesces concurrent token lookups so parallel MCP requests do not all refresh at once.

This keeps the transport connected while ensuring each request uses a current Keycloak token.


## Verification

The following checks were run from `packages/opencode`:

```bash
bun typecheck
bun test test/server/httpapi-mcp.test.ts test/server/httpapi-mcp-oauth.test.ts
```

Both passed.

Manual verification should use this sequence:

1. Start opencode with `bun run dev`.
2. Log in through Keycloak.
3. Ask `main-mcp-server` for data products.
4. Ask `jira_mcp_server` for recent tickets and confirm the expected classification denial.
5. Ask `main-mcp-server` for contracts or products again.

The Jira request may still return `Access denied for resource classification`, but subsequent `main-mcp-server` requests should no longer fail with `Token validation failed` because of a stale bearer token.

## Notes For Future Developers

If a similar issue appears again, check whether the failing request is an authentication failure or an authorization failure:

- `Token validation failed` means the server could not validate the bearer JWT. Check token expiry, issuer, JWKS, audience, and client token refresh behavior.
- `Access denied for resource classification` means the token was valid, but the authenticated principal lacked the required Data Mesh classification role.

Do not treat classification denials as token corruption. They are expected authorization outcomes for some users and resources.
