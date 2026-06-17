# airtable-mcp

Reliability-focused Airtable MCP server for the Command Center workflow.

## Environment

Required:

- `AIRTABLE_API_KEY`
- `AIRTABLE_BASE_ID`

Optional safety switches:

- `ENABLE_SCHEMA_WRITES=true` enables table and field creation/update tools.
- `ENABLE_COMMENTS=true` enables record comment tools after Airtable comment API access is verified.

By default, schema writes and comments are disabled so the MCP reports a structured, recoverable capability error instead of failing unpredictably.

## Useful checks

```bash
npm install
npm run check
npm start
```

Health endpoint:

```text
/health
```

## New MCP tools

- `get_capabilities`: reports configured read/write/comment/schema/attachment capabilities.
- `resolve_record`: searches one table across multiple fields, scores matches, and flags duplicate risk.
- `upsert_record_by_field`: idempotently updates by a stable key field or creates a record when safe.

## Important boundary

Attachment support is URL-based only. This MCP does not upload binary files directly into Airtable.
