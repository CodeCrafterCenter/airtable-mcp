# System-Wide Update Propagation Policy

Command Center changes should behave like professional product releases, not one-off chat corrections.

## Rule

When a behavior correction, product update, or tool fix reveals a durable rule, check the full connected system and update every relevant safe surface.

Relevant surfaces can include:

- Airtable records, queues, knowledge rules, and audit records
- MCP/tool behavior and tool descriptions
- GitHub code and docs
- Railway deployment and live capability readback
- Memory and handoff notes
- Tests, syntax checks, readback, and operational verification

Apply only surfaces that are actually relevant to the change. Do not create schema churn, duplicate records, unsafe writes, or broad refactors just to appear thorough.

## Reporting Contract

After each material update, report:

- systems read
- systems updated
- code/docs/config changed
- deployment status
- verification performed
- remaining blockers or staged work

If a connector or deployment action fails, record the exact blocker and next action. Never imply the live system has changed when only code or documentation is staged.
