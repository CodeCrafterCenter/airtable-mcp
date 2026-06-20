import crypto from "crypto";
import express from "express";
import Airtable from "airtable";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const VERSION = "6.3.0";
const PORT = process.env.PORT || 3000;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const ENABLE_SCHEMA_WRITES = process.env.ENABLE_SCHEMA_WRITES === "true";
const ENABLE_COMMENTS = process.env.ENABLE_COMMENTS === "true";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || "";
const PDF_UPLOADER_TOKEN = process.env.PDF_UPLOADER_TOKEN || "";
const MAX_PDF_UPLOAD_BYTES = Number(process.env.MAX_PDF_UPLOAD_BYTES || 15 * 1024 * 1024);
const UPLOADED_FILE_TTL_MS = Number(process.env.UPLOADED_FILE_TTL_MS || 20 * 60 * 1000);
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
const mcpServer = new McpServer({ name: "airtable-mcp", version: VERSION });
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
let schemaCache = { fetchedAt: 0, tables: null };
const uploadedFiles = new Map();

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

function sanitizeFilename(filename = "upload.pdf") {
  const cleaned = String(filename).replace(/[\\/\0\r\n]/g, "_").trim();
  return cleaned || "upload.pdf";
}

function normalizeBase64(input) {
  const value = String(input || "").trim();
  const comma = value.indexOf(",");
  return value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
}

function getPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL.startsWith("http") ? PUBLIC_BASE_URL.replace(/\/$/, "") : `https://${PUBLIC_BASE_URL.replace(/\/$/, "")}`;
  }
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}

function requireUploaderAuth(req) {
  if (!PDF_UPLOADER_TOKEN) return;
  const provided = req.get("x-uploader-token") || req.body?.uploaderToken || "";
  if (provided !== PDF_UPLOADER_TOKEN) {
    const error = new Error("PDF uploader token is missing or invalid");
    error.statusCode = 403;
    throw error;
  }
}

function cleanupUploadedFiles() {
  const now = Date.now();
  for (const [id, file] of uploadedFiles.entries()) {
    if (file.expiresAt <= now) uploadedFiles.delete(id);
  }
}

function stageUploadedPdf({ buffer, filename }) {
  cleanupUploadedFiles();
  if (!buffer.length) throw new Error("Uploaded PDF is empty");
  if (buffer.length > MAX_PDF_UPLOAD_BYTES) throw new Error(`Uploaded PDF exceeds limit of ${MAX_PDF_UPLOAD_BYTES} bytes`);
  if (buffer.subarray(0, 4).toString("utf8") !== "%PDF") throw new Error("Uploaded file does not look like a PDF");
  const fileId = crypto.randomUUID();
  const safeFilename = sanitizeFilename(filename);
  uploadedFiles.set(fileId, {
    buffer,
    filename: safeFilename,
    contentType: "application/pdf",
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + UPLOADED_FILE_TTL_MS
  });
  return { fileId, filename: safeFilename };
}

function attachmentFilename(attachment) {
  return String(attachment?.filename || attachment?.name || "").trim();
}

function hasAttachmentFilename(attachments, filename) {
  const wanted = sanitizeFilename(filename).toLowerCase();
  return attachments.some((attachment) => attachmentFilename(attachment).toLowerCase() === wanted);
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

async function updateOptionalFields(tableName, recordId, candidateFields) {
  const entries = Object.entries(candidateFields).filter(([, value]) => value !== undefined && value !== null);
  if (!entries.length) return null;
  const { validFields } = await validateFields(tableName, entries.map(([fieldName]) => fieldName), { requireAll: false });
  const fields = {};
  for (const [fieldName, value] of entries) {
    if (validFields.includes(fieldName)) fields[fieldName] = value;
  }
  if (!Object.keys(fields).length) return null;
  return updateRecords(tableName, [{ id: recordId, fields }]);
}

async function appendOrSkipAttachment({ tableName, recordId, attachmentFieldName, fileUrl, filename, skipDuplicates = true }) {
  await validateFields(tableName, [attachmentFieldName]);
  const record = await base(tableName).find(recordId);
  const existing = Array.isArray(record.fields[attachmentFieldName]) ? record.fields[attachmentFieldName] : [];
  if (skipDuplicates && hasAttachmentFilename(existing, filename)) {
    return { skippedDuplicate: true, existing, updated: [{ id: record.id, fields: record.fields }] };
  }
  const newAttachment = filename ? { url: fileUrl, filename: sanitizeFilename(filename) } : { url: fileUrl };
  const updated = await updateRecords(tableName, [{ id: recordId, fields: { [attachmentFieldName]: [...existing, newAttachment] } }]);
  return { skippedDuplicate: false, existing, updated };
}

async function uploadPdfToRecord({ tableName, recordId, attachmentFieldName, filename, fileBase64, fileUrl, skipDuplicates = true, intakeRecordId, intakeTableName = ATTACHMENT_INTAKE_TABLE_NAME, req }) {
  if (!tableName) throw new Error("Missing tableName");
  if (!recordId) throw new Error("Missing recordId");
  if (!attachmentFieldName) throw new Error("Missing attachmentFieldName");
  if (!filename) throw new Error("Missing filename");

  let attachmentUrl = fileUrl;
  let staged = null;
  if (!attachmentUrl) {
    if (!fileBase64) throw new Error("Provide either fileUrl or fileBase64");
    const buffer = Buffer.from(normalizeBase64(fileBase64), "base64");
    staged = stageUploadedPdf({ buffer, filename });
    const encodedName = encodeURIComponent(staged.filename);
    attachmentUrl = `${getPublicBaseUrl(req)}/uploaded-files/${staged.fileId}/${encodedName}`;
  }

  const result = await appendOrSkipAttachment({ tableName, recordId, attachmentFieldName, fileUrl: attachmentUrl, filename, skipDuplicates });
  const targetRecord = await base(tableName).find(recordId);
  const attachments = Array.isArray(targetRecord.fields[attachmentFieldName]) ? targetRecord.fields[attachmentFieldName] : [];
  const verified = hasAttachmentFilename(attachments, filename);
  const now = new Date().toISOString();
  const uploadStatus = result.skippedDuplicate ? "Skipped duplicate" : verified ? "Uploaded" : "Failed";
  const note = result.skippedDuplicate
    ? `Skipped duplicate filename ${sanitizeFilename(filename)} on ${now}.`
    : verified
      ? `Uploaded and verified ${sanitizeFilename(filename)} on ${now}.`
      : `Upload attempted for ${sanitizeFilename(filename)} on ${now}, but readback did not verify the filename.`;

  if (intakeRecordId) {
    await updateOptionalFields(intakeTableName, intakeRecordId, {
      "Upload Status": uploadStatus,
      "Upload Verified At": verified ? now : undefined,
      "Uploader Run ID": staged?.fileId,
      "Upload Error / Notes": note,
      "Last Checked": now.slice(0, 10),
      "Uploader Provider": "Custom Backend"
    });
  }

  return {
    success: verified || result.skippedDuplicate,
    action_attempted: "upload_pdf_to_record",
    tableName,
    recordId,
    attachmentFieldName,
    filename: sanitizeFilename(filename),
    fileUrl: attachmentUrl,
    stagedFileId: staged?.fileId ?? null,
    skippedDuplicate: result.skippedDuplicate,
    verified,
    uploadStatus,
    intakeRecordId: intakeRecordId ?? null,
    note
  };
}

safeTool("get_capabilities", "Report which optional features are enabled on this MCP server", {}, async () => jsonContent({ success: true, version: VERSION, capabilities: { schemaWrites: ENABLE_SCHEMA_WRITES, comments: ENABLE_COMMENTS, railwayIntakeEndpoint: true, pdfUploadEndpoint: true, temporaryFileHosting: true, uploaderTokenConfigured: Boolean(PDF_UPLOADER_TOKEN), maxPdfUploadBytes: MAX_PDF_UPLOAD_BYTES } }));

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
  const fields = { [attachmentFieldName]: [filename ? { url: fileUrl, filename: sanitizeFilename(filename) } : { url: fileUrl }] };
  const updated = await updateRecords(tableName, [{ id: recordId, fields }]);
  return jsonContent({ success: true, action_attempted: "attach_file_to_record", data: updated });
});

safeTool("append_attachment_to_record", "Append a file URL to an existing attachment field", { tableName: z.string(), recordId: z.string(), attachmentFieldName: z.string(), fileUrl: z.string().url(), filename: z.string().optional(), skipDuplicates: z.boolean().optional() }, async ({ tableName, recordId, attachmentFieldName, fileUrl, filename, skipDuplicates = true }) => {
  const result = await appendOrSkipAttachment({ tableName, recordId, attachmentFieldName, fileUrl, filename, skipDuplicates });
  return jsonContent({ success: true, action_attempted: "append_attachment_to_record", skippedDuplicate: result.skippedDuplicate, data: result.updated });
});

safeTool("upload_pdf_base64_to_record", "Upload a base64 PDF to an Airtable attachment field through temporary backend hosting and verified readback", { tableName: z.string(), recordId: z.string(), attachmentFieldName: z.string(), filename: z.string(), fileBase64: z.string(), skipDuplicates: z.boolean().optional(), intakeRecordId: z.string().optional(), intakeTableName: z.string().optional() }, async (args) => {
  const payload = await uploadPdfToRecord({ ...args, req: { get: () => null, protocol: "https" } });
  return jsonContent(payload);
});

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "60mb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, name: "airtable-mcp", version: VERSION, message: "Airtable MCP server is running", capabilities: { schemaWrites: ENABLE_SCHEMA_WRITES, comments: ENABLE_COMMENTS, railwayIntakeEndpoint: true, pdfUploadEndpoint: true, temporaryFileHosting: true } });
});

app.get("/health", (_req, res) => {
  cleanupUploadedFiles();
  res.json({ ok: true, version: VERSION, schemaCacheAgeMs: schemaCache.tables ? Date.now() - schemaCache.fetchedAt : null, stagedFiles: uploadedFiles.size, capabilities: { schemaWrites: ENABLE_SCHEMA_WRITES, comments: ENABLE_COMMENTS, railwayIntakeEndpoint: true, pdfUploadEndpoint: true, temporaryFileHosting: true, uploaderTokenConfigured: Boolean(PDF_UPLOADER_TOKEN) } });
});

app.get("/uploaded-files/:fileId/:filename?", (req, res) => {
  cleanupUploadedFiles();
  const file = uploadedFiles.get(req.params.fileId);
  if (!file) {
    res.status(404).json({ success: false, action_attempted: "download_uploaded_file", message: "File not found or expired" });
    return;
  }
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Length", file.buffer.length);
  res.setHeader("Content-Disposition", `inline; filename="${file.filename.replace(/"/g, "'")}"`);
  res.send(file.buffer);
});

app.post("/upload-pdf-to-record", async (req, res) => {
  try {
    requireUploaderAuth(req);
    const result = await uploadPdfToRecord({ ...req.body, req });
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error("[airtable-mcp] upload-pdf-to-record failed:", error);
    const status = error?.statusCode || 400;
    res.status(status).json({ success: false, action_attempted: "upload_pdf_to_record", ...classifyError(error), raw_error: error?.message || String(error) });
  }
});

app.post("/process-intake-record", async (req, res) => {
  try {
    const { tableName = ATTACHMENT_INTAKE_TABLE_NAME, recordId, attachmentFieldName = ATTACHMENT_INTAKE_ATTACHMENT_FIELD, fileUrl, filename, statusFieldName = ATTACHMENT_INTAKE_STATUS_FIELD, status = "Proposed", notesFieldName = ATTACHMENT_INTAKE_NOTES_FIELD, notes, sourceUrlFieldName = ATTACHMENT_INTAKE_SOURCE_URL_FIELD, filenameFieldName = ATTACHMENT_INTAKE_FILENAME_FIELD } = req.body ?? {};
    if (!recordId) throw new Error("Missing recordId");
    if (!fileUrl) throw new Error("Missing fileUrl");
    const fields = { [attachmentFieldName]: [filename ? { url: fileUrl, filename: sanitizeFilename(filename) } : { url: fileUrl }] };
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
  console.log(`Airtable MCP v${VERSION} listening on port ${PORT}`);
  console.log(`Schema writes: ${ENABLE_SCHEMA_WRITES ? "ENABLED" : "disabled"}`);
  console.log(`Comments: ${ENABLE_COMMENTS ? "ENABLED" : "disabled"}`);
  console.log(`PDF uploader token: ${PDF_UPLOADER_TOKEN ? "configured" : "not configured"}`);
});
