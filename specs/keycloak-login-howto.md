# Keycloak Login How-To

## Goal

Use one global Keycloak login in OpenCode and forward its bearer token to remote MCP servers.

## Supported Login Flows

OpenCode supports three Keycloak login flow modes:

- `pkce`: OAuth Authorization Code with PKCE. Loopback redirect URIs use a local callback listener; browser-hosted deployments can use OpenCode's `/identity/keycloak/login/callback` endpoint.
- `device`: OAuth device authorization flow. OpenCode prints or displays a verification URL and user code, then polls Keycloak until approval completes.
- `auto`: uses device flow when Keycloak discovery advertises `device_authorization_endpoint`; otherwise falls back to PKCE.

The default remains `pkce` unless `auth.keycloak.flow`, `OPENCODE_KEYCLOAK_FLOW`, or an explicit login request selects another mode.

## Configure Keycloak Login

Example config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "auth": {
    "keycloak": {
      "issuer": "https://sso.example.com/realms/engineering",
      "clientId": "opencode-cli",
      "scope": "openid profile email offline_access",
      "flow": "device"
    }
  }
}
```

Equivalent environment variables:

```bash
export OPENCODE_KEYCLOAK_ISSUER=https://sso.example.com/realms/engineering
export OPENCODE_KEYCLOAK_CLIENT_ID=opencode-cli
export OPENCODE_KEYCLOAK_SCOPE="openid profile email offline_access"
export OPENCODE_KEYCLOAK_FLOW=device
```

## CLI Login

Run:

```bash
opencode auth login keycloak
```

For `pkce`, OpenCode opens the authorization URL and waits for the configured callback.

For `device`, OpenCode displays:

- the verification URL
- the user code when Keycloak returns one
- a waiting state until the browser approval completes

Device flow is the recommended mode for containers, remote shells, and other environments where a localhost callback cannot reliably reach OpenCode.

## Browser-Hosted Login

Browser-hosted OpenCode sessions can start login through:

```text
POST /identity/keycloak/login/start
```

The response includes `flow`, `authorizationUrl`, `state`, and device-specific fields when applicable.

For browser callback PKCE, Keycloak redirects to:

```text
GET /identity/keycloak/login/callback?state=...&code=...
```

The callback completes the pending login, stores the tokens, and reconnects enabled Keycloak bearer MCP servers.

For device flow, clients should call:

```text
POST /identity/keycloak/login/finish
```

with the returned `state`; the request waits until the user completes authorization or the device code expires.

## MCP Bearer Configuration

Remote MCP servers can opt into the global Keycloak token:

```jsonc
{
  "mcp": {
    "jira": {
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

OpenCode resolves the current Keycloak access token, refreshes it when possible, and sends:

```text
Authorization: Bearer <current-user-keycloak-access-token>
```

Static headers remain supported. If static config also contains `Authorization`, the runtime Keycloak bearer token wins for Keycloak-backed MCP servers.

## Troubleshooting

If browser callback login does not complete, check the redirect URI, reverse proxy routing to `/identity/keycloak/login/callback`, and Keycloak client redirect settings.

If device flow does not start, check that Keycloak discovery exposes `device_authorization_endpoint` and that the client is allowed to use device authorization.

If device flow starts but never completes, verify the approval was completed before expiry and that the user code was entered exactly when required.

If remote MCP servers show `needs_auth`, log in again with `opencode auth login keycloak` and verify the MCP config uses `auth.type = "bearer"` and `auth.provider = "keycloak"`.
