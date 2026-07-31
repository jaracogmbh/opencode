# MCP Communication Reference

Use this reference for MCP config, lifecycle, transports, OAuth, tool/resource/prompt exposure, CLI commands, TUI MCP status, and MCP HTTP API work.

## Main Surfaces

- MCP service: `packages/opencode/src/mcp/index.ts`
- MCP auth store: `packages/opencode/src/mcp/auth.ts`
- MCP OAuth provider/callback: `packages/opencode/src/mcp/oauth-provider.ts`, `packages/opencode/src/mcp/oauth-callback.ts`
- MCP tool/resource/prompt adapter: `packages/opencode/src/mcp/catalog.ts`
- MCP CLI command: `packages/opencode/src/cli/cmd/mcp.ts`
- MCP config schema: `packages/core/src/v1/config/mcp.ts`
- MCP events: `packages/schema/src/mcp-event.ts`
- TUI events used by MCP: `packages/schema/src/tui-event.ts`
- HTTP API group/handlers: `packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/mcp.ts`
- TUI MCP consumers: `packages/tui/src/feature-plugins/sidebar/mcp.tsx`, `packages/tui/src/component/dialog-mcp.tsx`, `packages/tui/src/context/local.tsx`, `packages/tui/src/context/sync.tsx`

## Config Shape

`packages/core/src/v1/config/mcp.ts` defines two server types:

- Local: `{ type: "local", command: string[], cwd?, environment?, enabled?, timeout? }`
- Remote: `{ type: "remote", url, enabled?, headers?, auth?, oauth?, timeout? }`

Remote `auth` currently supports runtime bearer tokens from Keycloak. Remote `oauth` can be an object with `clientId`, `clientSecret`, `scope`, `callbackPort`, or `redirectUri`; `oauth: false` disables OAuth auto-detection.

When adding config fields, update schema annotations and all places that pass config into transport creation, CLI add flows, and tests.

## MCP Service Flow

`MCP.Service` is an Effect service with `InstanceState`-scoped state:

- `config`: dynamically added runtime configs.
- `status`: server status by name.
- `clients`: connected MCP SDK clients.
- `defs`: cached MCP tool definitions.
- `instructions`: server instructions from connected clients.

Startup loads `cfg.mcp`, skips invalid entries, marks disabled entries, and connects enabled servers concurrently.

Statuses are:

- `connected`
- `disabled`
- `failed`
- `needs_auth`
- `needs_client_registration`

Use `MCP.Service` methods instead of opening direct MCP clients from UI or handlers.

## Client Creation and Capabilities

`createClient(directory)` creates an MCP SDK `Client` named `opencode` and registers `roots` support. The roots request returns the current instance directory as a file URL.

Client options deliberately leave several capabilities commented out. Do not enable sampling, elicitation, or tasks without designing the surrounding behavior and tests.

## Local Transport

Local MCP uses `StdioClientTransport`.

Important details:

- `command` is split as `[cmd, ...args]` from config.
- `cwd` resolves relative to `InstanceState.directory`.
- Environment merges `process.env`, `BUN_BE_BUN=1` for `opencode`, and configured `environment`.
- `stderr` is piped.
- Connection timeout comes from server config or the default.

On shutdown, stdio child descendants are discovered with `pgrep -P` on non-Windows and terminated before closing clients.

## Remote Transport

Remote MCP tries transports in order:

1. `StreamableHTTPClientTransport`
2. `SSEClientTransport`

`remoteURL` validates the URL. Headers come from config and may include runtime Keycloak bearer tokens when `auth.type === "bearer"` and `auth.provider === "keycloak"`.

OAuth is enabled by default for remote servers unless `oauth: false`. Auth failures set pending transports and publish TUI toast events with next-step hints.

## OAuth Flow

Auth storage lives in `Global.Path.data/mcp-auth.json` and is protected with `EffectFlock`.

`McpOAuthProvider` stores tokens, dynamic client registration info, code verifier, state, and server URL through `McpAuth`. URL matching matters: `getForUrl` rejects credentials saved for another server URL.

Flow:

1. `startAuth(name)` validates remote OAuth support.
2. It starts the local callback server with default `http://127.0.0.1:19876/mcp/oauth/callback` or configured redirect URI.
3. It creates state and a pending OAuth provider.
4. If connection needs browser auth, it returns `authorizationUrl` and stores a pending transport.
5. `authenticate(name)` opens the browser, waits for callback, verifies state, then calls `finishAuth`.
6. `finishAuth(name, code)` completes transport auth, commits pending credentials, reconnects, and stores the client.

For API-driven auth, preserve and return `oauthState`; see `test/server/httpapi-mcp-oauth.test.ts`.

## Tools, Prompts, Resources, and Instructions

`packages/opencode/src/mcp/catalog.ts` adapts MCP capabilities:

- `defs(client, timeout)` lists tools and tolerates certain invalid `outputSchema` errors by falling back to a relaxed `tools/list`.
- `convertTool(...)` wraps MCP tools as AI SDK `dynamicTool`.
- `toolName(clientName, name)` sanitizes as `client_tool`.
- `prompts`, `resources`, and `resourceTemplates` paginate with cursor cycle detection and a hard page limit.
- `fetch(...)` prefixes results with sanitized or escaped client names and logs warning on failures.

`MCP.tools()` returns connected tools only. Request timeout is resolved from dynamic config, static config, or `config.experimental.mcp_timeout`.

Tool execution passes `resetTimeoutOnProgress`, the abort signal, a timeout, and an `onprogress` hook. If an MCP tool returns `structuredContent` without text content, OpenCode turns it into a text JSON content item.

`MCP.instructions()` returns connected server instructions sorted by server name and includes the exposed tool names.

## Notifications and Events

`watch(...)` handles:

- `client.onclose`: marks status failed, clears cached client/defs/instructions, publishes `mcp.tools.changed`.
- `LoggingMessageNotificationSchema`: logs server messages at matching log levels.
- `ToolListChangedNotificationSchema`: refreshes cached defs and publishes `mcp.tools.changed`.

Event schemas live in `packages/schema/src/mcp-event.ts`. MCP also publishes TUI toast events through `TuiEvent.ToastShow` for auth problems.

If adding event types, update the schema inventory and any manifest tests that cover events.

## HTTP API

The MCP HttpApi group lives in `packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts`; handlers live in `handlers/mcp.ts`.

Paths:

- `GET /mcp` -> status map
- `POST /mcp` -> dynamically add a server config
- `POST /mcp/:name/auth` -> start OAuth
- `POST /mcp/:name/auth/callback` -> finish OAuth with code
- `POST /mcp/:name/auth/authenticate` -> start OAuth and wait for callback
- `DELETE /mcp/:name/auth` -> remove auth
- `POST /mcp/:name/connect` -> connect or retry
- `POST /mcp/:name/disconnect` -> disconnect and mark disabled

Handlers should translate `MCP.NotFoundError` into `McpServerNotFoundError` and unsupported OAuth into `UnsupportedOAuthError`.

Routes use `InstanceContextMiddleware`, `WorkspaceRoutingMiddleware`, and `Authorization`.

If changing public API contracts, follow repo instructions for client generation from `packages/client` and do not edit generated SDK files directly.

## CLI Command

`packages/opencode/src/cli/cmd/mcp.ts` implements:

- `opencode mcp list`
- `opencode mcp add`
- `opencode mcp auth`
- `opencode mcp auth list`
- `opencode mcp logout`
- `opencode mcp debug`

Non-interactive `mcp add` writes global config using `jsonc-parser` edits. Preserve comments and existing formatting. For local servers, argv after `--` must be preserved exactly. For remote servers, `--header KEY=VALUE` can include additional `=` in the value. `--env` applies only to local servers.

Interactive add can write project-local or global config depending on VCS/project context.

## TUI MCP State

TUI sync bootstraps `sdk.client.mcp.status({ workspace })` into `sync.data.mcp`.

Consumers:

- `packages/tui/src/feature-plugins/sidebar/mcp.tsx` displays status in the sidebar.
- `packages/tui/src/component/dialog-mcp.tsx` toggles MCP connections and refreshes status.
- `packages/tui/src/context/local.tsx` maps connected status to `disconnect`, otherwise `connect`.

Keep UI code using SDK/context boundaries rather than importing `MCP.Service`.

## Validation

Run from `packages/opencode`:

- `bun typecheck`
- `bun test test/server/httpapi-mcp.test.ts`
- `bun test test/server/httpapi-mcp-oauth.test.ts`
- `bun test test/mcp/lifecycle.test.ts`
- `bun test test/mcp/auth.test.ts`
- `bun test test/cli/mcp-add.test.ts`
- Additional OAuth suites: `test/mcp/oauth-callback.test.ts`, `test/mcp/oauth-provider.test.ts`, `test/mcp/oauth-browser.test.ts`, `test/mcp/oauth-auto-connect.test.ts`, `test/mcp/session-recovery.test.ts`
