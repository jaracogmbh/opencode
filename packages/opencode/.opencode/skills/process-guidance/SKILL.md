---
name: process-guidance
description: Guide BPMN and knowledge-graph-backed user workflows without creating runtime process state or executing business actions
---

## When to use me
Use this skill when the user asks about:
- BPMN process definitions or process bindings
- resolving a user goal to a process or step
- evidence, role, policy, tool, or data-product context for a workflow step
- assistant behavior for process-guided work

## Phase 1 boundaries
- The local repository may not be mounted in the user-facing runtime.
- BPMN process specs are authored under `specs/processes/` in source control and exposed at runtime through KG MCP.
- `process-bindings.yaml` binds BPMN steps to roles, tools, evidence, policies, and data products in source control.
- The knowledge graph is a derived read-only Neo4j projection.
- KG MCP does not store runtime process instances, advance BPMN tokens, mutate Jira/GitHub, or execute approvals.

## Workflow
1. Resolve likely process context from the user goal and optional business key.
2. Fetch ordered process steps before explaining flow.
3. Fetch step context before recommending evidence, tools, roles, or next action.
4. If the step requires approval, draft the approval request or update but do not execute it.
5. State clearly when a workflow is guidance-only versus executable automation.

## Output style
- For developers, include process IDs, step IDs, binding files, and MCP routing.
- For product owners, produce user-facing process outcomes, acceptance criteria, and non-goals.
- For executives, summarize operating-model value, controls, and automation limits.
