# UI Extensions Reference

Use this reference for TUI plugin, built-in TUI feature, UI state, keymap, route, dialog, slot, or mini UI work.

## Main Surfaces

- Full TUI CLI entrypoint: `packages/opencode/src/cli/cmd/tui.ts`
- Full TUI worker/server bridge: `packages/opencode/src/cli/tui/worker.ts`
- OpenCode TUI wrapper layer: `packages/opencode/src/cli/tui/layer.ts`
- Host-side TUI plugin runtime: `packages/opencode/src/plugin/tui/runtime.ts`
- Public plugin API types: `packages/plugin/src/tui.ts`
- TUI runtime and slots: `packages/tui/src/plugin/runtime.tsx`, `packages/tui/src/plugin/slots.tsx`, `packages/tui/src/plugin/api.ts`
- Built-in TUI plugins: `packages/tui/src/feature-plugins/builtins.ts`
- TUI contexts: `packages/tui/src/context/*`
- Mini UI: `packages/opencode/src/cli/cmd/run/*`

## Choosing the Right Surface

- Add or change a full-screen legacy/full TUI extension by using the plugin API, slots, routes, keymaps, dialogs, or a built-in plugin under `packages/tui/src/feature-plugins`.
- Add external plugin capability by changing `packages/plugin/src/tui.ts` first, then host/runtime implementation in `packages/opencode/src/plugin/tui/runtime.ts`.
- Add a new built-in UI area by registering it in `packages/tui/src/feature-plugins/builtins.ts`.
- Change `opencode --mini` behavior under `packages/opencode/src/cli/cmd/run`. The mini UI does not use the full TUI plugin host.
- Change web/app UI separately under `packages/app`; do not assume full TUI plugin APIs apply there.

## Full TUI Startup Flow

`packages/opencode/src/cli/cmd/tui.ts` starts the full TUI unless `--mini` is set.

The full TUI:

1. Resolves and validates the project directory.
2. Starts `packages/opencode/src/cli/tui/worker.ts` in a Worker.
3. Uses RPC to call the in-process server through `createWorkerFetch`, unless network flags request an external server.
4. Loads `TuiConfig.get()`.
5. Calls `run(...)` from `packages/opencode/src/cli/tui/layer.ts`.
6. Passes `createLegacyTuiPluginHost()` into the TUI runtime.

When debugging full TUI UI state, inspect `packages/tui/src/context/sdk.tsx` for SDK/event connection behavior and `packages/tui/src/context/sync.tsx` for bootstrapped server state.

## TUI Plugin Runtime

`packages/opencode/src/plugin/tui/runtime.ts` is the host boundary. It resolves configured plugins, creates scoped APIs, activates/deactivates plugins, syncs themes, and tracks cleanup.

Important behavior:

- `ensureRuntimePluginSupport` enables OpenTUI/Solid runtime plugin support.
- `TuiConfig` provides plugin origins and config.
- `PluginLoader.loadExternal({ kind: "tui" })` resolves npm and file plugins.
- Built-ins come from `internalTuiPlugins(...)`.
- Plugin IDs are resolved through shared plugin metadata helpers.
- `plugin_enabled` comes from TUI config and is overridden by host KV state.
- `createPluginScope` provides `api.lifecycle.signal` and `api.lifecycle.onDispose`.
- Scoped APIs auto-track disposers for route, event, keymap, mode, attention sound packs, and slots.
- Activation calls `plugin.plugin(api, options, plugin.meta)`.
- Deactivation disposes registered resources in reverse order with a timeout.

Do not add unscoped global registrations from plugins. Route, event, slot, keymap, mode, and attention registrations should return disposers and be tracked by the scope.

## Public Plugin Contract

`packages/plugin/src/tui.ts` defines the external contract:

- `TuiPluginModule = { id?: string; tui: TuiPlugin; server?: never }`
- `TuiPlugin = (api, options, meta) => Promise<void>`
- `TuiPluginApi` includes `app`, `attention`, deprecated `command`, `keys`, `keymap`, `mode`, `route`, `ui`, `tuiConfig`, `kv`, `state`, `theme`, `client`, `event`, `renderer`, `slots`, `plugins`, and `lifecycle`.

When extending plugin capabilities:

1. Add public types in `packages/plugin/src/tui.ts`.
2. Implement or expose the capability in `packages/opencode/src/plugin/tui/runtime.ts` or `packages/tui/src/plugin/*`.
3. Update fixtures in `packages/opencode/test/fixture/tui-plugin.ts` or `tui-runtime.ts` if tests need the new API.
4. Add focused runtime tests under `packages/opencode/test/cli/tui`.

## Slots and Routes

Slot rendering is hosted by `packages/tui/src/plugin/slots.tsx`.

The built-in host slot names live in `TuiHostSlotMap` in `packages/plugin/src/tui.ts`, including:

- `app`, `app_bottom`
- `home_logo`, `home_prompt`, `home_prompt_right`, `home_bottom`, `home_footer`
- `session_prompt`, `session_prompt_right`
- `sidebar_title`, `sidebar_content`, `sidebar_footer`

Plugins register slots with `api.slots.register({ order, slots: { slot_name() { ... } } })`. The host assigns plugin IDs and auto-disposes slot registrations.

Routes are managed by `packages/tui/src/plugin/api.ts`. `api.route.register(...)` stacks route renderers by name and returns a disposer. `api.route.navigate(...)` uses the host route context exposed through the API.

## Built-In Plugin Examples

Use existing built-ins as local patterns:

- `packages/tui/src/feature-plugins/sidebar/mcp.tsx`: reads `api.state.mcp()`, renders MCP status in `sidebar_content`.
- `packages/tui/src/feature-plugins/system/plugins.tsx`: plugin manager behavior.
- `packages/tui/src/feature-plugins/system/which-key.tsx`: keymap/command discovery.
- `packages/tui/src/feature-plugins/system/notifications.ts`: attention/notification behavior.

Register new built-ins in `packages/tui/src/feature-plugins/builtins.ts`. Host-side built-ins are exposed through `packages/opencode/src/plugin/tui/internal.ts`.

## TUI State and SDK Access

Use `api.state` and contexts rather than importing server services into TUI code.

- `packages/tui/src/context/sdk.tsx` creates `@opencode-ai/sdk/v2` clients and batches global events.
- `packages/tui/src/context/sync.tsx` bootstraps providers, commands, LSP, MCP, resources, formatter, sessions, and other server state.
- `packages/tui/src/context/local.tsx` owns local UI behavior, such as `local.mcp.toggle(name)` calling SDK `mcp.connect` or `mcp.disconnect`.
- `packages/tui/src/component/dialog-mcp.tsx` shows a concrete SDK plus sync refresh pattern for MCP toggling.

If a UI feature needs new server state, prefer adding a typed HTTP API/SDK path, then syncing it through context.

## Keymaps and Commands

Use `api.keymap.registerLayer(...)` for plugin commands and bindings. `api.command` is deprecated and retained only as a v1 shim.

When adding keybind config, update the TUI keybind config in `packages/tui/src/config/keybind.ts` and account for `TuiConfig` dropping unknown keybinds. Existing tests under `packages/opencode/test/config/tui.test.ts` cover TUI config migration and keybind parsing.

## Mini UI Notes

The mini UI is under `packages/opencode/src/cli/cmd/run` and is selected by `opencode --mini`.

Key files:

- `runtime.ts`, `runtime.lifecycle.ts`, `runtime.queue.ts`, `stream.transport.ts`
- Footer components: `footer.ts`, `footer.view.tsx`, `footer.prompt.tsx`, `footer.command.tsx`, `footer.permission.tsx`, `footer.question.tsx`
- Rendering and scrollback: `scrollback.surface.ts`, `scrollback.writer.tsx`, `entry.body.ts`, `tool.ts`, `theme.ts`

Mini UI changes should not assume the TUI plugin runtime exists. Use the local types in `packages/opencode/src/cli/cmd/run/types.ts` and adjacent test fixtures.

## Validation

Run from `packages/opencode`:

- `bun typecheck`
- `bun test test/cli/tui/plugin-loader.test.ts`
- `bun test test/cli/tui/plugin-toggle.test.ts`
- `bun test test/cli/tui/plugin-install.test.ts`
- `bun test test/config/tui.test.ts`
- For mini UI, use adjacent `test/cli/run/*` or `test/cli/cmd/tui/*` suites.
