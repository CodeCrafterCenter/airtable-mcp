# airtable-mcp

A Model Context Protocol (MCP) server for Airtable, designed to run on Railway.

## Features

- **Structured error responses** — all tool errors return `{ isError: true, content: [{ type: "text", text: "{\"error\": \"...\"}" }] }` so MCP clients can handle failures gracefully instead of receiving unhandled exceptions.
- **Capability reporting** — call `get_capabilities` to discover which optional features are enabled at runtime.
- **Safer field validation** — `create_record` and `update_record` validate field names against the cached table schema and surface unknown fields as warnings rather than silently sending them to Airtable.
- **Record resolution** — `update_record`, `delete_record`, `clear_record_fields`, and the new `resolve_record` tool accept either a bare `recordId` or a `lookupField` + `lookupValue` pair, so callers don't need to know record IDs in advance.
- **Dedicated field clearing** — `clear_record_fields` clears stale operational values by sending Airtable `null`, which avoids invalid empty-string writes for date and other typed fields.
- **Idempotent upsert** — `batch_upsert_records` creates records without a `recordId` and updates those that have one, making it safe to call repeatedly.
- **Command Center hygiene tools** — clean Contracts feeds hide legacy evidence pointers, and daily hygiene scans can detect clutter, normalize obvious evidence placeholders, and delete only fully blank rows when explicitly applied.
- **Command Center reconciliation tools** — daily scans can now generate a dry-run operating queue across Airtable tables and a cockpit-ready payload for the future web app.
- **Schema writes disabled by default** — `create_table`, `create_field`, and `update_field` require `ENABLE_SCHEMA_WRITES=true`.
- **Comments disabled by default** — `list_record_comments` and `create_record_comment` require `ENABLE_COMMENTS=true`.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|
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
| `clear_record_fields` | Clear one or more field values by setting them to `null`; useful for stale dates and optional operational fields |
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

### Command Center Hygiene
| Tool | Description |
|---|---|
| `list_clean_contract_records` | Return a clean Contracts feed for app/default-view use, excluding blank rows and legacy evidence pointers while preserving them in Airtable for retrieval. |
| `run_command_center_hygiene_scan` | Scan Command Center tables for blank rows, Contracts legacy pointers, and obvious PDF-ready evidence placeholders. Defaults to dry-run. In apply mode, can delete fully blank rows and normalize obvious non-contract evidence placeholders. |

Daily automation should use `run_command_center_hygiene_scan` in dry-run mode by default. Low-risk auto-apply is limited to fully blank rows and obvious placeholder normalization. Human review is required before deleting legacy pointers, deleting fields/columns, changing legal/coverage/payment/claim status, or moving evidence when match confidence is not high.

Airtable API clients should use `list_clean_contract_records` for a clean Contracts experience. Native Airtable UI view filters are not edited by this server; use the returned filter formula or a future UI/backend layer to hide legacy pointer rows in Airtable itself.

### Command Center Reconciliation
| Tool | Description |
|---|---|
| `run_command_center_reconciliation_queue` | Build a dry-run operating queue across Tasks, Missing Documents, Attachment Intake Queue, disputes, claims, evidence, dashboard, and waiting-reply tables. Buckets records into Ready to execute, Waiting external, Needs source, Needs review, Done / do not repeat, and Superseded. Optional audit persistence writes only to AI Action Runs. |
| `get_command_center_cockpit_payload` | Return a compact read-only payload for the future web cockpit, including summary cards, queue sections, approval actions, blocked actions, and the next best step. |

Reconciliation is intentionally conservative. It can auto-surface stale/noisy/done/superseded records and propose high-confidence uploader actions, but it must not delete non-empty records, delete fields/columns, change legal/coverage/payment/claim status, move ambiguous evidence, or send communications without human review.

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

## Deployment Notes

- 2026-06-23: Added `clear_record_fields` v6.4.1 for safe typed-field clearing, especially stale date fields that reject empty strings.
- 2026-06-21: Added Command Center reconciliation tools v6.4.0 for dry-run queue generation and cockpit payloads.
- 2026-06-20: Deployment marker for Command Center hygiene tools v6.3.0.