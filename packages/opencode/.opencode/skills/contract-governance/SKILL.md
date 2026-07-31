---
name: contract-governance
description: Guide data contract, schema versioning, compatibility, classification, and governance decisions using MCP-visible metadata
---

## When to use me
Use this skill when the user asks about:
- adding or changing data contracts, output ports, topics, or schema files
- compatibility, breaking changes, versioning, or CI/CD validation rules
- Jaramesh access classification and RBAC implications
- OpenMetadata or Confluent reconciliation readiness

## Workflow
1. Identify the product, output port, contract name, and version involved.
2. Check MCP metadata before recommending changes; ask for spec snippets if required details are not exposed.
3. Classify the change as additive, compatible, breaking, operational, or governance-only.
4. If breaking, recommend a new versioned contract path instead of modifying the existing version in place.
5. Include acceptance criteria for schema validation, compatibility checks, metadata sync, RBAC, and consumer impact.

## Spec rules to communicate
- Product specs are expected under `specs/domains/<domain>/<product>/data-product.yaml` in the source repo.
- Contract specs are expected under `contracts/<output-port>/<version>/data-contract.yaml`.
- The checked-in payload schema should be `schema.json` next to the contract.
- `specs/catalog.yaml` is the validation and sync entrypoint.
- In MCP-only runtime, present these as required source changes, not as files you edited.
- Product, output-port, and contract classifications should use `jaramesh-public`, `jaramesh-internal`, `jaramesh-confidential`, or `jaramesh-restricted`.
- Existing contract versions must not be changed incompatibly in place.

## Output style
- For engineering users, give exact files, validation commands, and risk notes.
- For product users, give scope, acceptance criteria, rollout risks, and ownership impacts.
- For executive users, summarize governance, consumer risk, and readiness gates.
