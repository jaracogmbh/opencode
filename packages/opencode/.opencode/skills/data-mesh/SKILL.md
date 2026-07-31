---
name: data-mesh
description: Handle Jaraco Data Mesh questions using MCP tools as the runtime source of truth
---

## When to use me
Use this skill when the user asks about:
- data products, output ports, domains, owners, or support teams
- data contracts, schema versions, compatibility, or lineage
- catalog discovery, governance metadata, OpenMetadata, or Confluent reconciliation intent
- Jira, GitHub, deployment, or process context that should be grounded in MCP tools

## Source of truth
- The local repository may not be mounted in the user-facing runtime.
- Registered/runtime metadata lives behind the main MCP server and control plane.
- Operational Jira and GitHub data lives behind their dedicated MCP servers.
- BPMN process context lives behind the KG MCP server and is read-only in Phase 1.
- OpenMetadata is for catalog, glossary, lineage, tags, and governance metadata outside the control plane.
- If checked-in spec contents are required but not exposed through MCP, ask the user to provide the relevant spec or request repo-backed follow-up work.

## Workflow
1. Investigate first.
2. For broad product or contract questions, list first, extract concrete IDs or names, then fetch details.
3. For process questions, resolve the likely process, fetch process steps, then fetch step context.
4. For operational questions, query Jira or GitHub MCP only after identifying the relevant issue key, repository, commit, branch, or Jira reference.
5. Only answer after checking the authoritative MCP source available for the request.

## Routing
- Use `jaraco_main_mcp_server_*` for control-plane metadata, contracts, products, lineage, effective contracts, and startup config.
- Use `jira_mcp_server_*` for Jira issue state, blockers, dependencies, status history, and PR links.
- Use `github_mcp_server_*` for GitHub events, commits, pull requests, branches, deployments, releases, and Jira correlation.
- Use `kg_mcp_server_*` or `kg-mcp-server` tools for BPMN-derived process guidance.
- Use `openmetadata_*` for catalog, glossary, tags, lineage, and governance metadata.

## Response style
- Use Markdown tables for lists and comparisons.
- State when data is unavailable or when a source was not checked.
- Never fabricate IDs, schema fields, versions, owners, lineage, or governance status.

## Safety
- Verify user intent before mutating operations, reconciliation, or writes.
- Treat OpenCode permissions as UX controls only; backend OIDC/RBAC and Jaramesh classification are the security boundary.
- Prefer read-first validation before any write action.
