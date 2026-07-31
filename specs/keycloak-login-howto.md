# Keycloak Login How-To

## Goal

Use one global Keycloak login in OpenCode and forward its bearer token to remote MCP servers.

## What This Feature Does

- logs the CLI into Keycloak once
- stores the Keycloak access and refresh tokens in OpenCode auth storage
- refreshes the token when needed
- injects `Authorization: Bearer <token>` into remote MCP server requests
- allows multiple remote MCP servers to reuse the same Keycloak login

## Prerequisites

Before using this flow, make sure:

- your Keycloak realm is reachable from the machine running OpenCode
- you have a Keycloak client that allows the login flow you plan to use
- the client is configured for loopback redirect URIs if you use PKCE
- the client supports device authorization if you use device flow
- the client can request `offline_access` if you want refresh-token based reuse
- your remote MCP server accepts a bearer token issued by that Keycloak realm

## Choose A Login Flow

OpenCode now supports three Keycloak login flow modes:

- `pkce`: browser-based OAuth Authorization Code with PKCE and a localhost callback
- `device`: device authorization flow with a verification URL and user code
- `auto`: try device flow when the issuer supports it, otherwise fall back to PKCE

Recommended usage:

- use `device` when OpenCode runs in a container, VM, or remote shell where localhost callbacks are awkward
- use `pkce` when OpenCode runs directly on your workstation and can receive the loopback callback
- use `auto` when you want OpenCode to prefer the best non-callback option automatically

Example config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "auth": {
    "keycloak": {
      "issuer": "https://sso.example.com/realms/engineering",
      "clientId": "opencode-cli",
      "flow": "device"
    }
  }
}
```

You can also set the flow with:

```bash
export OPENCODE_KEYCLOAK_FLOW=device
```

## Step 1: Log In To Keycloak

Run:

```bash
opencode auth login keycloak
```

OpenCode will prompt for:

- Keycloak issuer URL
- Keycloak client ID
- optional client secret
- scopes
- redirect URI for PKCE-based login

Example values:

```text
Keycloak issuer URL: https://sso.example.com/realms/engineering
Keycloak client ID: opencode-cli
Scopes: openid profile email offline_access
Redirect URI: http://127.0.0.1:19877
Client secret: <optional>
```

### If You Use `device`

OpenCode will:

- request a device authorization from Keycloak
- print a verification URL
- print or display a user code when Keycloak requires one
- wait for you to complete login in any browser
- store the resulting session after approval

This flow does not require OpenCode to listen on `127.0.0.1`.

### If You Use `pkce`

For Keycloak, prefer the loopback redirect URI:

```text
http://127.0.0.1:19877
```

Keycloak treats `http://127.0.0.1` as a special native-app redirect and allows any port when the client is configured correctly.

OpenCode then:

- starts a local callback listener
- opens the browser to the Keycloak authorization page
- waits for the OAuth callback
- stores the resulting session

If the browser does not open automatically, OpenCode prints the authorization URL so you can open it manually.

### If You Use `auto`

OpenCode checks Keycloak discovery metadata first:

- if `device_authorization_endpoint` is advertised, it uses device flow
- otherwise it uses PKCE

## Step 2: Configure A Remote MCP Server To Use Keycloak

Add a remote MCP entry that requests bearer auth from the global Keycloak login.

Example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
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
```

This tells OpenCode to:

- load the stored Keycloak session
- refresh the access token if necessary
- send `Authorization: Bearer <token>` to that MCP server

## Step 3: Combine Static Headers If Needed

You can still configure other static headers.

Example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "jira": {
      "type": "remote",
      "url": "https://mcp.example.com",
      "headers": {
        "X-Tenant": "engineering",
        "X-Client": "opencode"
      },
      "auth": {
        "type": "bearer",
        "provider": "keycloak"
      }
    }
  }
}
```

In this case OpenCode keeps the static headers and adds the Keycloak `Authorization` header.

If you also configure a literal `Authorization` header, the runtime Keycloak bearer token wins.

## Step 4: Use The MCP Server

Once configured, use the MCP server normally.

Useful commands:

```bash
opencode mcp list
opencode mcp auth <server-name>
```

For the Keycloak-backed flow, the main command you usually need is:

```bash
opencode mcp list
```

If the Keycloak session is valid, the remote MCP server should connect normally.

## Expected Runtime Behavior

When a remote MCP server is configured with:

```json
"auth": {
  "type": "bearer",
  "provider": "keycloak"
}
```

OpenCode will:

1. read the global Keycloak login state
2. check whether the access token is still valid
3. refresh it if it is close to expiry and a refresh token is available
4. create the remote MCP transport with the resolved bearer token

## Troubleshooting

### `needs_auth` or authentication-required status

This usually means:

- you have not logged in yet
- the stored login has expired and cannot be refreshed
- the Keycloak refresh token is missing or invalid

Fix:

```bash
opencode auth login keycloak
```

### Browser opens but login does not complete

Check:

- the Keycloak client redirect URI configuration
- whether the client is configured to allow the loopback redirect `http://127.0.0.1`
- whether loopback redirects are allowed
- whether local callbacks on `127.0.0.1` are blocked

If OpenCode is running in a container or remote environment, switch to:

```jsonc
{
  "auth": {
    "keycloak": {
      "flow": "device"
    }
  }
}
```

### Device flow starts but never completes

Check:

- the Keycloak realm exposes `device_authorization_endpoint`
- the Keycloak client is allowed to use device authorization
- the verification URL is reachable from the browser you are using
- the login was completed before the device code expired
- the user code was entered exactly if Keycloak asked for it

### Remote MCP server still rejects the token

Check:

- the MCP server trusts the same Keycloak issuer
- the token audience/resource configuration matches what the MCP server expects
- the requested scopes are sufficient
- the user account is allowed to access that MCP service

### Keycloak discovery fails

Check:

- the issuer URL is correct
- the issuer exposes `/.well-known/openid-configuration`
- the machine running OpenCode can reach the Keycloak server

## Security Notes

- prefer least-privilege scopes
- use `offline_access` only if you need persistent refresh behavior
- avoid sharing the local OpenCode auth storage across users
- do not hardcode bearer tokens in config when this Keycloak flow is available

## Example End-To-End Flow

1. Log in:

```bash
opencode auth login keycloak
```

2. Add MCP config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "docs": {
      "type": "remote",
      "url": "https://docs.example.com/mcp",
      "auth": {
        "type": "bearer",
        "provider": "keycloak"
      }
    }
  }
}
```

3. Verify:

```bash
opencode mcp list
```

4. Use the MCP server from OpenCode as usual.
