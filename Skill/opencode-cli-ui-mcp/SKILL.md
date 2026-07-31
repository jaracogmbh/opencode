---
name: opencode-cli-ui-mcp
description: Guide for modifying the OpenCode CLI codebase when working on TUI/UI extensions, plugin surfaces, MCP server configuration, MCP transports, OAuth, MCP tool/resource/prompt integration, or the HTTP API and SDK paths that expose MCP state. Use when Codex needs repo-specific orientation for packages/opencode, packages/tui, packages/plugin, or MCP-related tests and config.
---

# OpenCode CLI UI and MCP

## Overview

Use this skill to change OpenCode CLI UI extension surfaces and MCP server communication without rediscovering the package boundaries. Start from the repo maps below, then load only the focused reference file needed for the task.

## First Steps

1. Read the repo root `AGENTS.md` before editing.
2. Confirm the target surface:
   - Full TUI plugin or built-in UI extension: read `references/ui-extensions.md`.
   - Mini CLI UI under `opencode --mini`: read `references/ui-extensions.md`, especially the mini-run notes.
   - MCP config, connection, OAuth, tools, prompts, resources, or MCP HTTP API: read `references/mcp-communication.md`.
3. Search before editing. Prefer `rg` and inspect the nearest tests under `packages/opencode/test`.
4. Keep generated code untouched. If public Protocol or Server `HttpApi` changes require regeneration, run the repo-prescribed generator instead of editing generated files.

## Package Boundaries

- `packages/opencode`: CLI entrypoints, server/runtime services, config loading, MCP service, TUI host integration.
- `packages/tui`: OpenTUI/Solid UI runtime, routes, contexts, built-in TUI plugins, slots, dialogs, keymaps.
- `packages/plugin`: public plugin contracts. Change exported types here when extending the external plugin API.
- `packages/core/src/v1/config`: shared v1 config schemas, including MCP and plugin config shapes.
- `packages/schema`: event schemas such as `mcp-event` and `tui-event`.
- `packages/sdk/js` and `packages/sdk-next`: generated/client SDK surfaces. Regenerate from the proper package when API shapes change.

Respect the dependency direction from the repo instructions: Schema -> Core/Protocol -> Server; client runtime may depend on Schema and Protocol but not Core or Server.

## Workflow

Use the existing Effect service pattern in `packages/opencode`: bind services to named variables before calling methods, keep instance-local state in `InstanceState`, and use `LayerNode.make` for node wiring. In UI code, follow Solid/OpenTUI patterns already present in adjacent files.

Prefer extending existing contracts over introducing parallel ones:

- TUI plugin behavior should flow through `TuiPluginApi`, slots, routes, keymap, lifecycle, or built-in plugin registration.
- MCP behavior should flow through `MCP.Service`, `McpCatalog`, config schemas, and HttpApi handlers rather than ad hoc clients.
- UI state should come from `packages/tui/src/context/sync.tsx`, `local.tsx`, SDK client calls, or event subscriptions instead of direct server imports.

## Validation

Run commands from package directories, not the repo root.

- Typecheck OpenCode changes from `packages/opencode` with `bun typecheck`.
- For TUI plugin/config work, start with targeted tests such as `bun test test/cli/tui/plugin-loader.test.ts`, `bun test test/cli/tui/plugin-toggle.test.ts`, `bun test test/cli/tui/plugin-install.test.ts`, and `bun test test/config/tui.test.ts`.
- For MCP work, start with targeted tests such as `bun test test/server/httpapi-mcp.test.ts`, `bun test test/server/httpapi-mcp-oauth.test.ts`, `bun test test/mcp/lifecycle.test.ts`, `bun test test/mcp/auth.test.ts`, and `bun test test/cli/mcp-add.test.ts`.
- If a public HTTP API or SDK contract changes, run the required generator from the package specified by `AGENTS.md`.

## References

- `references/ui-extensions.md`: TUI plugin host, slots, built-in plugins, route/keymap/dialog/state surfaces, and mini UI notes.
- `references/mcp-communication.md`: MCP config schema, transports, OAuth, tool/resource/prompt catalog, events, HTTP API, CLI command, and tests.
