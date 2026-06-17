# airtable-mcp

A Model Context Protocol (MCP) server for Airtable, designed to run on Railway.

## Features

- **Structured error responses** — all tool errors return `{ isError: true, content: [{ type: "text", text: "{\"error\": \"...\"}" }] }` so MCP clients can handle failures gracefully instead of receiving unhandled exceptions.
- **Capability reporting** — call `get_capabilities` to discover which optional features are enabled at runtime.
- **Safer field validation** — `create_record` and `update_record` validate field names against the cached table schema and surface unknown fields as warnings rather than silently sending them to Airtable.
- **Record resolution** — `update_record`, `delete_record`, and the new `resolve_record` tool accept either a bare `recordId` or a `lookupField` + `lookupValue` pair, so callers don't need to know record IDs in advance.
- **Idempotent upsert** — `batch_upsert_records` creates records without a `recordId` and updates those that have one, making it safe to call repeatedly.
- **Schema writes disabled by default** — `create_table`, `create_field`, and `update_field` require `ENABLE_SCHEMA_WRITES=true`.
- **Comments disabled by default** — `list_record_comments` and `create_record_comment` require `ENABLE_COMMENTS=true`.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AIRTABLE_API_KEY` | ✅ | — | Airtable personal access token |
| `AIRTABLE_BASE_ID` | ✅ | — | Airtable base ID (starts with `app`) |
| `PORT` | | `3000` | HTTP port to listen on |
| `ENABLE_SCHEMA_WRITES` | | `false` | Set to `true` to enable `create_table`, `create_field`, `update_field` |
| `ENABLE_COMMENTS` | | `false` | Set to `true` to enable `list_record_comments`, `create_record_comment` |

## MCP Endpoint

```
POST /mcp
```

## Tools

### Schema / Tables
| Tool | Description |
|---|---|
| `get_capabilities` | Report which optional features are enabled |
| `list_tables` | List all tables in the base |
| `get_table_schema` | Get field schema for one or all tables |

### Record Read
| Tool | Description |
|---|---|
| `list_records` | List records from a table |
| `get_record` | Get one record by ID |
| `resolve_record` | Resolve a record by field-value lookup or confirm an existing ID |
| `search_records` | Search records by text in a field |
| `find_records_across_tables` | Search across multiple tables |

### Record Write
| Tool | Description |
|---|---|
| `create_record` | Create one record |
| `update_record` | Update one record (by ID or field lookup) |
| `delete_record` | Delete one record (by ID or field lookup) |

### Batch Write
| Tool | Description |
|---|---|
| `batch_create_records` | Create up to 10 records |
| `batch_update_records` | Update up to 10 records |
| `batch_delete_records` | Delete up to 10 records |
| `batch_upsert_records` | Idempotent upsert up to 10 records |

### Attachments
| Tool | Description |
|---|---|
| `attach_file_to_record` | Replace an attachment field with a file URL |
| `append_attachment_to_record` | Append a file URL to an attachment field |

### Comments _(requires `ENABLE_COMMENTS=true`)_
| Tool | Description |
|---|---|
| `list_record_comments` | List comments on a record |
| `create_record_comment` | Add a comment to a record |

### Schema Writes _(requires `ENABLE_SCHEMA_WRITES=true`)_
| Tool | Description |
|---|---|
| `create_table` | Create a new table |
| `create_field` | Add a field to a table |
| `update_field` | Rename or update a field description |

## Health Check

```
GET /health
```

Returns `{ ok: true, version, schemaCacheAgeMs, capabilities }`.
