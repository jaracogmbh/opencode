# OpenCode Persona Deployment

This `.opencode` directory is the source bundle for Jaraco persona agents and skills.

If the end-user runtime does not have this repository mounted, project-local `.opencode` files will not load. Install the agents and skills into an OpenCode config location that is available to the user runtime.

## Recommended Runtime Layout

Use a global or managed OpenCode config directory:

```text
~/.config/opencode/
  opencode.jsonc
  agents/
    developer-persona.md
    product-owner-persona.md
    executive-persona.md
    data-mesh-assistant.md
    data-platform-agent.md
  skills/
    data-mesh/SKILL.md
    developer/SKILL.md
    product-owner/SKILL.md
    executive/SKILL.md
    contract-governance/SKILL.md
    process-guidance/SKILL.md
```

For containerized or centrally managed runtimes, place the same structure in a dedicated directory and start OpenCode with:

```bash
OPENCODE_CONFIG_DIR=/opt/jaraco-opencode opencode
```

Keep MCP server configuration and permissions in the runtime `opencode.jsonc`.

## Runtime Assumption

The personas are designed for an MCP-only runtime:

- no local repository reads
- no local file edits
- no local shell commands
- product, contract, Jira, GitHub, OpenMetadata, and BPMN facts come from MCP servers

When source changes are requested, the personas should produce implementation guidance, expected file changes, acceptance criteria, or pseudo-patches. A developer with repository access must apply and verify those changes.

## Primary Personas

- `developer-persona`: technical implementation and engineering guidance
- `product-owner-persona`: requirements, backlog, acceptance criteria, and user outcomes
- `executive-persona`: strategy, risk, governance, investment, and operating-model decisions

## Support Subagents

- `data-mesh-assistant`: focused metadata, contract, lineage, and governance research
- `data-platform-agent`: deeper data-platform engineering research

## Skills

- `data-mesh`: MCP source-of-truth routing
- `developer`: engineering guidance in MCP-only runtime
- `product-owner`: product and backlog workflow
- `executive`: executive decision support
- `contract-governance`: schema, versioning, classification, and governance rules
- `process-guidance`: BPMN and KG-backed workflow guidance
