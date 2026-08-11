# Keycloak Browser Login And Bearer MCP Integration

This document records the OpenCode-side design for browser-hosted Keycloak login, device-flow Keycloak login, and MCP servers that use the logged-in user's Keycloak bearer token.

It was added after debugging the `jarasite-mgmt` Kubernetes deployment, where OpenCode runs in a pod, the browser runs on the user's machine, and Jaramesh MCP servers require per-user Keycloak authorization.

## Goal

OpenCode should own authentication and MCP token usage:

1. A browser user starts Keycloak login from OpenCode.
2. Keycloak either redirects back to OpenCode's browser callback endpoint or the user completes OAuth device authorization in a separate browser.
3. OpenCode exchanges the authorization code and persists the user's tokens in its normal auth store.
4. OpenCode auto-connects enabled MCP servers that are configured to use Keycloak bearer auth.
5. OpenCode injects the current user's Keycloak access token into outgoing MCP HTTP requests.

Deployment wrappers, such as `jarasite-mgmt`, should only host and proxy OpenCode. They should not exchange Keycloak codes or write OpenCode auth files once this OpenCode implementation is deployed.

## Relevant Code

| Area | File |
| --- | --- |
| Keycloak OAuth and auth storage | `src/auth/keycloak.ts` |
| Keycloak identity HTTP API | `src/server/routes/instance/httpapi/groups/identity.ts` |
| Keycloak identity handlers | `src/server/routes/instance/httpapi/handlers/identity.ts` |
| MCP service and bearer-token injection | `src/mcp/index.ts` |
| Web MCP toggle behavior | `../app/src/context/global-sync/mcp.ts` |
| Web MCP toggle call site | `../app/src/context/server-sync.tsx` |

## Keycloak Browser Callback

OpenCode exposes this browser callback endpoint:

```text
GET /identity/keycloak/login/callback
```

The callback accepts:

```text
state
code
error
error_description
```

The route is registered in `groups/identity.ts` as `keycloakLoginCallback`, and handled in `handlers/identity.ts` by `keycloak.completeCallback(...)`.

The callback flow is:

```text
POST /identity/keycloak/login/start
  -> OpenCode creates state and PKCE verifier
  -> browser opens Keycloak authorization URL
  -> Keycloak redirects to /identity/keycloak/login/callback?state=...&code=...
  -> OpenCode validates pending state
  -> OpenCode exchanges code with Keycloak token endpoint
  -> OpenCode writes provider "keycloak" to auth.json
  -> OpenCode reports Keycloak identity as authenticated
```

The callback completes login itself. Browser-hosted deployments should not require a manual `POST /identity/keycloak/login/finish` call after the callback.

## Keycloak Device Flow

OpenCode can also start Keycloak OAuth device authorization when `auth.keycloak.flow` or `OPENCODE_KEYCLOAK_FLOW` is `device`, or when `flow` is `auto` and Keycloak discovery advertises `device_authorization_endpoint`.

The flow is:

```text
POST /identity/keycloak/login/start
  -> OpenCode requests a device code from Keycloak
  -> OpenCode returns verification URL, user code, polling interval, expiry, and state
  -> user opens the verification URL and approves login
  -> POST /identity/keycloak/login/finish waits for token polling to complete
  -> OpenCode writes provider "keycloak" to auth.json
  -> OpenCode reports Keycloak identity as authenticated
```

This is useful when OpenCode runs in a pod, container, VM, or remote shell where the user's browser cannot reliably reach a localhost callback listener.

Supported flow values:

| Flow | Behavior |
| --- | --- |
| `pkce` | Authorization Code + PKCE using loopback or browser-hosted callback support |
| `device` | OAuth device authorization with verification URL, user code, and token polling |
| `auto` | Prefer device flow when Keycloak advertises support; otherwise use PKCE |

The default remains `pkce` unless config, environment, or request payload selects a different flow.

## Auth Storage

The Keycloak auth entry is stored under provider ID `keycloak` in OpenCode's normal auth store:

```json
{
  "keycloak": {
    "type": "keycloak",
    "issuer": "https://keycloak.example.com/realms/example",
    "clientId": "opencode-client",
    "access": "...",
    "refresh": "...",
    "expires": 1786379776413,
    "scope": "openid profile email offline_access"
  }
}
```

This is intentionally owned by OpenCode. External hosting apps should not write this file directly except as a temporary migration workaround.

## Keycloak Bearer MCP Config

Remote MCP servers that expect the user's Keycloak JWT use this config shape:

```jsonc
{
  "mcp": {
    "example-main": {
      "type": "remote",
      "url": "http://example-mcp.example.svc.cluster.local:9000/mcp",
      "auth": {
        "type": "bearer",
        "provider": "keycloak"
      },
      "oauth": false,
      "enabled": true
    }
  }
}
```

`oauth: false` is important. These servers do not use MCP OAuth negotiation. They receive an ordinary HTTP bearer token:

```text
Authorization: Bearer <current-user-keycloak-access-token>
```

## Token Injection

`src/mcp/index.ts` resolves the current Keycloak token for remote MCP configs where:

```ts
mcp.auth?.type === "bearer" && mcp.auth.provider === "keycloak"
```

For these servers, OpenCode:

1. calls `keycloakAuth.token()` before connecting,
2. returns `needs_auth` when no usable Keycloak token exists,
3. strips any static configured `Authorization` header,
4. sets `Authorization: Bearer <token>` in request headers,
5. installs a custom fetch that refreshes/reloads the token for outgoing MCP requests.

The static `Authorization` stripping is deliberate. Configured stale credentials must not override the logged-in user's Keycloak token.

## Auto-Connect After Login

After Keycloak login succeeds, `handlers/identity.ts` calls:

```ts
mcp.connectKeycloakBearerServers()
```

This method is implemented in `src/mcp/index.ts`. It generically reconnects enabled remote MCP servers that use Keycloak bearer auth. It does not know about Jaramesh or any deployment-specific server names.

The selection rule is:

```ts
mcp.type === "remote" &&
mcp.enabled !== false &&
mcp.auth?.type === "bearer" &&
mcp.auth.provider === "keycloak"
```

This solves the browser flow where MCPs are initialized before the user logs in and initially show `needs_auth`. Once Keycloak authentication completes, those MCPs are reconnected and their tools become available to chat.

## MCP Toggle Behavior

The web UI toggle is intentionally selective:

| MCP Type | `needs_auth` Toggle Action |
| --- | --- |
| Keycloak bearer MCP with `oauth: false` | `POST /mcp/<name>/connect` |
| OAuth MCP | `POST /mcp/<name>/auth/authenticate` |

This prevents Keycloak bearer MCPs from entering the MCP OAuth path while preserving the existing OAuth behavior for real OAuth MCP servers.

The implementation lives in:

```text
../app/src/context/global-sync/mcp.ts
../app/src/context/server-sync.tsx
```

## Deliberately Not Implemented

`POST /mcp/<name>/auth/authenticate` does not silently connect Keycloak bearer MCPs.

That endpoint remains OAuth-specific. If a client calls it for a Keycloak bearer MCP with `oauth: false`, the server should return the normal unsupported OAuth error. The correct endpoint for Keycloak bearer MCPs is:

```text
POST /mcp/<name>/connect
```

This keeps API semantics clear and avoids hiding client bugs.

## Deployment Boundary

OpenCode owns:

1. Keycloak OAuth state and PKCE handling.
2. Keycloak token exchange.
3. Keycloak token persistence in `auth.json`.
4. MCP bearer-token injection.
5. Auto-connect of enabled Keycloak bearer MCPs after login.
6. UI behavior that chooses connect instead of OAuth authenticate for Keycloak bearer MCPs.

Hosting applications, such as `jarasite-mgmt`, own:

1. reverse proxying to OpenCode,
2. per-browser-session OpenCode process isolation,
3. deployment-specific config mounts,
4. outer access gates such as nginx basic auth.

After this OpenCode implementation is deployed, remove temporary hosting-app code that exchanges Keycloak codes, writes OpenCode `auth.json`, or hardcodes MCP auto-connect server names.

## Verification

Focused tests for this behavior:

```bash
bun test test/mcp/lifecycle.test.ts test/auth/keycloak.test.ts test/mcp/oauth-auto-connect.test.ts test/server/httpapi-mcp.test.ts
```

Web toggle test:

```bash
bun test src/context/global-sync/mcp.test.ts
```

Scoped typechecks:

```bash
# packages/opencode
bun run typecheck

# packages/app
bun run typecheck
```

Useful manual checks after deployment:

```js
await fetch("/opencode/identity/keycloak").then((r) => r.json())
await fetch("/opencode/mcp").then((r) => r.json())
```

Expected after login:

```json
{
  "provider": "keycloak",
  "status": "authenticated"
}
```

and Keycloak bearer MCPs should be `connected`.

## Historical Context

The `jarasite-mgmt` deployment temporarily implemented Keycloak code exchange and MCP auto-connect outside OpenCode because the deployed OpenCode image did not include the browser callback route. That workaround proved the desired behavior and unblocked the deployment, but the long-term architecture is to keep auth and MCP behavior inside OpenCode.

The key debugging signal was that the deployed OpenCode process returned SPA HTML for:

```text
/identity/keycloak/login/callback?state=test
```

and the live OpenAPI document did not list `/identity/keycloak/login/callback`. A rebuilt OpenCode image from this code should include that route in `/doc`.
