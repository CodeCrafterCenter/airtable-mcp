import express from "express";
import Airtable from "airtable";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = process.env.PORT || 3000;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const ENABLE_SCHEMA_WRITES = process.env.ENABLE_SCHEMA_WRITES === "true";
const ENABLE_COMMENTS = process.env.ENABLE_COMMENTS === "true";
const ATTACHMENT_INTAKE_TABLE_NAME = process.env.ATTACHMENT_INTAKE_TABLE_NAME || "Attachment Intake Queue";
const ATTACHMENT_INTAKE_ATTACHMENT_FIELD = process.env.ATTACHMENT_INTAKE_ATTACHMENT_FIELD || "Attachments";
const ATTACHMENT_INTAKE_STATUS_FIELD = process.env.ATTACHMENT_INTAKE_STATUS_FIELD || "Status";
const ATTACHMENT_INTAKE_SOURCE_URL_FIELD = process.env.ATTACHMENT_INTAKE_SOURCE_URL_FIELD || "Source URL";
const ATTACHMENT_INTAKE_FILENAME_FIELD = process.env.ATTACHMENT_INTAKE_FILENAME_FIELD || "Filename";
const ATTACHMENT_INTAKE_NOTES_FIELD = process.env.ATTACHMENT_INTAKE_NOTES_FIELD || "Notes";

if (!AIRTABLE_API_KEY) throw new Error("Missing AIRTABLE_API_KEY");
if (!AIRTABLE_BASE_ID) throw new Error("Missing AIRTABLE_BASE_ID");

const airtable = new Airtable({ apiKey: AIRTABLE_API_KEY });
const base = airtable.base(AIRTABLE_BASE_ID);
const mcpServer = new McpServer({ name: "airtable-mcp", version: "6.1.0" });
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
let schemaCache = { fetchedAt: 0, tables: null };

function jsonContent(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function normalizeRecords(records) {
  return records.map((record) => ({ id: record.id, fields: record.fields }));
}

function classifyError(error) {
  const message = error?.message || String(error);
  const statusCode = error?.statusCode || error?.status || error?.error?.statusCode || null;
  const lower = message.toLowerCase();
  const auth_issue = statusCode === 401 || statusCode === 403 || lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("authentication") || lower.includes("permission");
  const missing_capability = lower.includes("disabled") || lower.includes("not supported") || lower.includes("missing capability");
  const validation_issue = lower.includes("unknown field") || (lower.includes("field") && lower.includes("not found")) || (lower.includes("table") && lower.includes("not found"));
  return { message, statusCode, auth_issue, missing_capability, validation_issue, recoverable: auth_issue || missing_capability || validation_issue };
}

function failure(action, error, safeFallback = "No write was confirmed. Verify the source and retry after fixing the reported issue.") {
  const classified = classifyError(error);
  return jsonContent({ success: false, action_attempted: action, ...classified, safe_fallback: safeFallback, raw_error: classified.message });
}

function safeTool(name, description, schema, handler) {
  mcpServer.tool(name, description, schema, async (args) => {
    try {
      return await handler(args || {});
    } catch (error) {
      console.error(`[airtable-mcp] ${name} failed:`, error);
      return failure(name, error);
    }
  });
}

function escapeFormulaString(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeFieldName(fieldName) {
  return String(fieldName).replace(/}/g, "\\}");
}

function buildSearchFormula(fieldNames, query) {
  const safeQuery = escapeFormulaString(query).toLowerCase();
  const clauses = fieldNames.map((fieldName) => `FIND("${safeQuery}", LOWER({${escapeFieldName(fieldName)}} & ""))`);
  return clauses.length === 1 ? clauses[0] : `OR(${clauses.join(", ")})`;
}

async function airtableMetaFetch(path, options = {}) {
  const response = await fetch(`https://api.airtable.com/v0/meta${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Airtable Meta API failed: ${response.status} ${text}`);
    error.statusCode = response.status;
    throw error;
  }
  if (response.status === 204) return {};
  return response.json();
}

async function fetchTablesFresh() {
  const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables`);
  schemaCache = { fetchedAt: Date.now(), tables: data.tables ?? [] };
  return schemaCache.tables;
}

async function getTables({ forceRefresh = false } = {}) {
  const isFresh = schemaCache.tables && Date.now() - schemaCache.fetchedAt < SCHEMA_CACHE_TTL_MS;
  if (!forceRefresh && isFresh) return schemaCache.tables;
  return fetchTablesFresh();
}

async function getTableOrThrow(tableName, options = {}) {
  const tables = await getTables(options);
  const table = tables.find((candidate) => candidate.name === tableName);
  if (!table) throw new Error(`Table not found: ${tableName}`);
  return table;
}

function compactTable(table, includeOptions = true) {
  return {
    id: table.id,
    name: table.name,
    description: table.description ?? null,
    fields: (table.fields ?? []).map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      description: field.description ?? null,
      ...(includeOptions ? { options: field.options ?? null } : {})
    }))
  };
}

async function validateFields(tableName, fields, { requireAll = true } = {}) {
  const table = await getTableOrThrow(tableName);
  const existing = new Set((table.fields ?? []).map((field) => field.name));
  const requested = Array.isArray(fields) ? fields : Object.keys(fields ?? {});
  const unknownFields = requested.filter((fieldName) => !existing.has(fieldName));
  if (requireAll && unknownFields.length) throw new Error(`Field(s) not found in ${tableName}: ${unknownFields.join(", ")}`);
  return { table, unknownFields, validFields: requested.filter((fieldName) => existing.has(fieldName)) };
}

async function resolveRecordId({ tableName, recordId, lookupField, lookupValue }) {
  if (recordId) return recordId;
  if (!tableName || !lookupField || lookupValue === undefined) throw new Error("Provide either recordId or all of: tableName, lookupField, lookupValue");
  await validateFields(tableName, [lookupField]);
  const formula = `{${escapeFieldName(lookupField)}} = "${escapeFormulaString(lookupValue)}"`;
  const records = await base(tableName).select({ filterByFormula: formula, maxRecords: 1 }).all();
  if (!records.length) throw new Error(`No record found in "${tableName}" where ${lookupField} = "${lookupValue}"`);
  return records[0].id;
}

async function createRecords(tableName, records) {
  const created = await base(tableName).create(records);
  return normalizeRecords(created);
}

async function updateRecords(tableName, records) {
  const updated = await base(tableName).update(records);
  return normalizeRecords(updated);
}

function requireSchemaWrites() {
  if (!ENABLE_SCHEMA_WRITES) throw new Error("Schema writes are disabled. Set ENABLE_SCHEMA_WRITES=true only after confirming the Airtable token has schema scopes.");
}

function requireComments() {
  if (!ENABLE_COMMENTS) throw new Error("Comments are disabled. Set ENABLE_COMMENTS=true only after confirming the Airtable token has comment scopes.");
}

safeTool("get_capabilities", "Report which optional features are enabled on this MCP server", {}, async () => jsonContent({ success: true, version: "6.1.0", capabilities: { schemaWrites: ENABLE_SCHEMA_WRITES, comments: ENABLE_COMMENTS, railwayIntakeEndpoint: true } }));

safeTool("list_tables", "List all tables in the Airtable base", {}, async () => {
  const tables = await getTables();
  return jsonContent({ success: true, action_attempted: "list_tables", data: tables.map((table) => ({ id: table.id, name: table.name, description: table.description ?? null })) });
});

safeTool("get_table_schema", "Get schema for one table or all tables in the Airtable base", { tableName: z.string().optional(), forceRefresh: z.boolean().optional() }, async ({ tableName, forceRefresh = false }) => {
  const tables = await getTables({ forceRefresh });
  if (tableName) {
    const table = tables.find((candidate) => candidate.name === tableName);
    if (!table) throw new Error(`Table not found: ${tableName}`);
    return jsonContent({ success: true, action_attempted: "get_table_schema", data: compactTable(table) });
  }
  return jsonContent({ success: true, action_attempted: "get_table_schema", data: tables.map((table) => compactTable(table, false)) });
});

safeTool("list_records", "List records from an Airtable table", { tableName: z.string(), maxRecords: z.number().int().min(1).max(100).optional() }, async ({ tableName, maxRecords = 20 }) => {
  await getTableOrThrow(tableName);
  const records = await base(tableName).select({ maxRecords }).all();
  return jsonContent({ success: true, action_attempted: "list_records", data: normalizeRecords(records) });
});

safeTool("get_record", "Get one Airtable record by record ID", { tableName: z.string(), recordId: z.string() }, async ({ tableName, recordId }) => {
  await getTableOrThrow(tableName);
  const record = await base(tableName).find(recordId);
  return jsonContent({ success: true, action_attempted: "get_record", data: { id: record.id, fields: record.fields } });
});

safeTool("resolve_record", "Resolve a record ID by looking up a field value, or confirm an existing record ID", { tableName: z.string(), recordId: z.string().optional(), lookupField: z.string().optional(), lookupValue: z.any().optional() }, async ({ tableName, recordId, lookupField, lookupValue }) => {
  const id = await resolveRecordId({ tableName, recordId, lookupField, lookupValue });
  const record = await base(tableName).find(id);
  return jsonContent({ success: true, action_attempted: "resolve_record", data: { id: record.id, fields: record.fields } });
});

safeTool("search_records", "Search Airtable records by plain text in one chosen field", { tableName: z.string(), fieldName: z.string(), query: z.string(), maxRecords: z.number().int().min(1).max(100).optional() }, async ({ tableName, fieldName, query, maxRecords = 20 }) => {
  await validateFields(tableName, [fieldName]);
  const formula = buildSearchFormula([fieldName], query);
  const records = await base(tableName).select({ filterByFormula: formula, maxRecords }).all();
  return jsonContent({ success: true, action_attempted: "search_records", formula, data: normalizeRecords(records) });
});

safeTool("find_records_across_tables", "Search across multiple Airtable tables", { tableNames: z.array(z.string()).min(1).max(10), fieldName: z.string(), query: z.string(), maxPerTable: z.number().int().min(1).max(50).optional() }, async ({ tableNames, fieldName, query, maxPerTable = 10 }) => {
  const results = [];
  for (const tableName of tableNames) {
    await validateFields(tableName, [fieldName]);
    const formula = buildSearchFormula([fieldName], query);
    const records = await base(tableName).select({ filterByFormula: formula, maxRecords: maxPerTable }).all();
    results.push({ tableName, formula, records: normalizeRecords(records) });
  }
  return jsonContent({ success: true, action_attempted: "find_records_across_tables", data: results });
});

safeTool("create_record", "Create one Airtable record", { tableName: z.string(), fields: z.record(z.any()) }, async ({ tableName, fields }) => {
  const { unknownFields } = await validateFields(tableName, fields);
  const records = await createRecords(tableName, [{ fields }]);
  return jsonContent({ success: true, action_attempted: "create_record", data: unknownFields.length ? { records, warnings: { unknownFields } } : records });
});

safeTool("update_record", "Update one Airtable record", { tableName: z.string(), recordId: z.string().optional(), lookupField: z.string().optional(), lookupValue: z.any().optional(), fields: z.record(z.any()) }, async ({ tableName, recordId, lookupField, lookupValue, fields }) => {
  const id = await resolveRecordId({ tableName, recordId, lookupField, lookupValue });
  const { unknownFields } = await validateFields(tableName, fields);
  const records = await updateRecords(tableName, [{ id, fields }]);
  return jsonContent({ success: true, action_attempted: "update_record", data: unknownFields.length ? { records, warnings: { unknownFields } } : records });
});

safeTool("delete_record", "Delete one Airtable record", { tableName: z.string(), recordId: z.string() }, async ({ tableName, recordId }) => {
  await getTableOrThrow(tableName);
  const deleted = await base(tableName).destroy([recordId]);
  return jsonContent({ success: true, action_attempted: "delete_record", data: deleted });
});

safeTool("upsert_record_by_field", "Idempotently update one Airtable record by a unique field, or create it if missing", { tableName: z.string(), lookupField: z.string(), lookupValue: z.any(), fields: z.record(z.any()) }, async ({ tableName, lookupField, lookupValue, fields }) => {
  await validateFields(tableName, [lookupField, ...Object.keys(fields)]);
  const formula = `{${escapeFieldName(lookupField)}} = "${escapeFormulaString(lookupValue)}"`;
  const existing = await base(tableName).select({ filterByFormula: formula, maxRecords: 2 }).all();
  if (existing.length > 1) throw new Error(`Multiple records found in ${tableName} for ${lookupField} = ${lookupValue}`);
  const mergedFields = { ...fields, [lookupField]: lookupValue };
  if (existing.length === 1) {
    const records = await updateRecords(tableName, [{ id: existing[0].id, fields: mergedFields }]);
    return jsonContent({ success: true, action_attempted: "upsert_record_by_field", mode: "updated", data: records });
  }
  const records = await createRecords(tableName, [{ fields: mergedFields }]);
  return jsonContent({ success: true, action_attempted: "upsert_record_by_field", mode: "created", data: records });
});

safeTool("batch_create_records", "Create multiple Airtable records", { tableName: z.string(), records: z.array(z.record(z.any())).min(1).max(10) }, async ({ tableName, records }) => {
  for (const fields of records) await validateFields(tableName, fields);
  const created = await createRecords(tableName, records.map((fields) => ({ fields })));
  return jsonContent({ success: true, action_attempted: "batch_create_records", data: created });
});

safeTool("batch_update_records", "Update multiple Airtable records", { tableName: z.string(), records: z.array(z.object({ recordId: z.string(), fields: z.record(z.any()) })).min(1).max(10) }, async ({ tableName, records }) => {
  for (const record of records) await validateFields(tableName, record.fields);
  const updated = await updateRecords(tableName, records.map(({ recordId, fields }) => ({ id: recordId, fields })));
  return jsonContent({ success: true, action_attempted: "batch_update_records", data: updated });
});

safeTool("batch_delete_records", "Delete multiple Airtable records", { tableName: z.string(), recordIds: z.array(z.string()).min(1).max(10) }, async ({ tableName, recordIds }) => {
  await getTableOrThrow(tableName);
  const deleted = await base(tableName).destroy(recordIds);
  return jsonContent({ success: true, action_attempted: "batch_delete_records", data: deleted });
});

safeTool("batch_upsert_records", "Idempotent upsert: update records that have a recordId, create those that do not", { tableName: z.string(), records: z.array(z.object({ recordId: z.string().optional(), fields: z.record(z.any()) })).min(1).max(10) }, async ({ tableName, records }) => {
  for (const record of records) await validateFields(tableName, record.fields);
  const toCreate = records.filter((record) => !record.recordId);
  const toUpdate = records.filter((record) => record.recordId);
  const result = { created: [], updated: [] };
  if (toCreate.length) result.created = await createRecords(tableName, toCreate.map((record) => ({ fields: record.fields })));
  if (toUpdate.length) result.updated = await updateRecords(tableName, toUpdate.map((record) => ({ id: record.recordId, fields: record.fields })));
  return jsonContent({ success: true, action_attempted: "batch_upsert_records", data: result });
});

safeTool("list_record_comments", "List comments on an Airtable record (requires ENABLE_COMMENTS=true)", { tableName: z.string(), recordId: z.string() }, async ({ tableName, recordId }) => {
  requireComments();
  const table = await getTableOrThrow(tableName);
  const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables/${table.id}/records/${recordId}/comments`);
  return jsonContent({ success: true, action_attempted: "list_record_comments", data });
});

safeTool("create_record_comment", "Create a comment on an Airtable record (requires ENABLE_COMMENTS=true)", { tableName: z.string(), recordId: z.string(), text: z.string() }, async ({ tableName, recordId, text }) => {
  requireComments();
  const table = await getTableOrThrow(tableName);
  const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables/${table.id}/records/${recordId}/comments`, { method: "POST", body: JSON.stringify({ text }) });
  return jsonContent({ success: true, action_attempted: "create_record_comment", data });
});

safeTool("create_table", "Create a new Airtable table (requires ENABLE_SCHEMA_WRITES=true)", { tableName: z.string(), fields: z.array(z.object({ name: z.string(), type: z.string() })).min(1) }, async ({ tableName, fields }) => {
  requireSchemaWrites();
  const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables`, { method: "POST", body: JSON.stringify({ name: tableName, fields }) });
  schemaCache.fetchedAt = 0;
  return jsonContent({ success: true, action_attempted: "create_table", data });
});

safeTool("create_field", "Create a field in an Airtable table (requires ENABLE_SCHEMA_WRITES=true)", { tableId: z.string(), fieldName: z.string(), fieldType: z.string() }, async ({ tableId, fieldName, fieldType }) => {
  requireSchemaWrites();
  const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables/${tableId}/fields`, { method: "POST", body: JSON.stringify({ name: fieldName, type: fieldType }) });
  schemaCache.fetchedAt = 0;
  return jsonContent({ success: true, action_attempted: "create_field", data });
});

safeTool("update_field", "Update an Airtable field (requires ENABLE_SCHEMA_WRITES=true)", { tableId: z.string(), fieldId: z.string(), name: z.string().optional(), description: z.string().optional() }, async ({ tableId, fieldId, name, description }) => {
  requireSchemaWrites();
  const body = {};
  if (name !== undefined) body.name = name;
  if (description !== undefined) body.description = description;
  const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables/${tableId}/fields/${fieldId}`, { method: "PATCH", body: JSON.stringify(body) });
  schemaCache.fetchedAt = 0;
  return jsonContent({ success: true, action_attempted: "update_field", data });
});

safeTool("attach_file_to_record", "Replace an attachment field with one file URL", { tableName: z.string(), recordId: z.string(), attachmentFieldName: z.string(), fileUrl: z.string().url(), filename: z.string().optional() }, async ({ tableName, recordId, attachmentFieldName, fileUrl, filename }) => {
  await validateFields(tableName, [attachmentFieldName]);
  const fields = { [attachmentFieldName]: [filename ? { url: fileUrl, filename } : { url: fileUrl }] };
  const updated = await updateRecords(tableName, [{ id: recordId, fields }]);
  return jsonContent({ success: true, action_attempted: "attach_file_to_record", data: updated });
});

safeTool("append_attachment_to_record", "Append a file URL to an existing attachment field", { tableName: z.string(), recordId: z.string(), attachmentFieldName: z.string(), fileUrl: z.string().url(), filename: z.string().optional() }, async ({ tableName, recordId, attachmentFieldName, fileUrl, filename }) => {
  await validateFields(tableName, [attachmentFieldName]);
  const record = await base(tableName).find(recordId);
  const existing = Array.isArray(record.fields[attachmentFieldName]) ? record.fields[attachmentFieldName] : [];
  const newAttachment = filename ? { url: fileUrl, filename } : { url: fileUrl };
  const updated = await updateRecords(tableName, [{ id: recordId, fields: { [attachmentFieldName]: [...existing, newAttachment] } }]);
  return jsonContent({ success: true, action_attempted: "append_attachment_to_record", data: updated });
});

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, name: "airtable-mcp", version: "6.1.0", message: "Airtable MCP server is running", capabilities: { schemaWrites: ENABLE_SCHEMA_WRITES, comments: ENABLE_COMMENTS, railwayIntakeEndpoint: true } });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, version: "6.1.0", schemaCacheAgeMs: schemaCache.tables ? Date.now() - schemaCache.fetchedAt : null, capabilities: { schemaWrites: ENABLE_SCHEMA_WRITES, comments: ENABLE_COMMENTS, railwayIntakeEndpoint: true } });
});

app.post("/process-intake-record", async (req, res) => {
  try {
    const { tableName = ATTACHMENT_INTAKE_TABLE_NAME, recordId, attachmentFieldName = ATTACHMENT_INTAKE_ATTACHMENT_FIELD, fileUrl, filename, statusFieldName = ATTACHMENT_INTAKE_STATUS_FIELD, status = "Proposed", notesFieldName = ATTACHMENT_INTAKE_NOTES_FIELD, notes, sourceUrlFieldName = ATTACHMENT_INTAKE_SOURCE_URL_FIELD, filenameFieldName = ATTACHMENT_INTAKE_FILENAME_FIELD } = req.body ?? {};
    if (!recordId) throw new Error("Missing recordId");
    if (!fileUrl) throw new Error("Missing fileUrl");
    const fields = { [attachmentFieldName]: [filename ? { url: fileUrl, filename } : { url: fileUrl }] };
    const optionalFields = { [statusFieldName]: status, [sourceUrlFieldName]: fileUrl, [filenameFieldName]: filename, [notesFieldName]: notes };
    const { validFields } = await validateFields(tableName, [attachmentFieldName, statusFieldName, sourceUrlFieldName, filenameFieldName, notesFieldName], { requireAll: false });
    for (const [fieldName, value] of Object.entries(optionalFields)) {
      if (value !== undefined && value !== null && validFields.includes(fieldName)) fields[fieldName] = value;
    }
    const updated = await updateRecords(tableName, [{ id: recordId, fields }]);
    res.json({ success: true, action_attempted: "process_intake_record", tableName, recordId, updatedFields: Object.keys(fields), data: updated });
  } catch (error) {
    console.error("[airtable-mcp] process-intake-record failed:", error);
    res.status(400).json({ success: false, action_attempted: "process_intake_record", ...classifyError(error), raw_error: error?.message || String(error) });
  }
});

app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) res.status(500).json({ success: false, action_attempted: "mcp_http_request", ...classifyError(error), raw_error: error?.message || "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Airtable MCP v6.1.0 listening on port ${PORT}`);
  console.log(`Schema writes: ${ENABLE_SCHEMA_WRITES ? "ENABLED" : "disabled"}`);
  console.log(`Comments: ${ENABLE_COMMENTS ? "ENABLED" : "disabled"}`);
});
