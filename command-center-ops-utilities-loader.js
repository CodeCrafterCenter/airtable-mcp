import Airtable from "airtable";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_BLOCKED_FIELD_TYPES = new Set(["multipleAttachments", "multipleRecordLinks"]);
const TEXT_FIELD_TYPES = new Set(["singleLineText", "multilineText", "richText", "email", "url", "phoneNumber"]);

let schemaCache = { fetchedAt: 0, tables: null };

function jsonContent(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function classifyError(error) {
  const message = error?.message || String(error);
  const statusCode = error?.statusCode || error?.status || error?.error?.statusCode || null;
  const lower = message.toLowerCase();
  const auth_issue = statusCode === 401 || statusCode === 403 || lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("authentication") || lower.includes("permission");
  const validation_issue = lower.includes("unknown field") || (lower.includes("field") && lower.includes("not found")) || (lower.includes("table") && lower.includes("not found"));
  return { message, statusCode, auth_issue, validation_issue, recoverable: auth_issue || validation_issue };
}

function failure(action, error, safeFallback = "No operations-utility write was confirmed. Verify the target, field names, and JSON payload before retrying.") {
  const classified = classifyError(error);
  return jsonContent({ success: false, action_attempted: action, ...classified, safe_fallback: safeFallback, raw_error: classified.message });
}

function safeTool(server, name, description, schema, handler) {
  server.tool(name, description, schema, async (args) => {
    try {
      return await handler(args || {});
    } catch (error) {
      console.error(`[airtable-mcp] ${name} failed:`, error);
      return failure(name, error);
    }
  });
}

function getBase() {
  if (!AIRTABLE_API_KEY) throw new Error("Missing AIRTABLE_API_KEY");
  if (!AIRTABLE_BASE_ID) throw new Error("Missing AIRTABLE_BASE_ID");
  return new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
}

async function airtableMetaFetch(path) {
  const response = await fetch(`https://api.airtable.com/v0/meta${path}`, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, "Content-Type": "application/json" }
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Airtable Meta API failed: ${response.status} ${text}`);
    error.statusCode = response.status;
    throw error;
  }
  return response.json();
}

async function getTables({ forceRefresh = false } = {}) {
  const isFresh = schemaCache.tables && Date.now() - schemaCache.fetchedAt < SCHEMA_CACHE_TTL_MS;
  if (!forceRefresh && isFresh) return schemaCache.tables;
  const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables`);
  schemaCache = { fetchedAt: Date.now(), tables: data.tables ?? [] };
  return schemaCache.tables;
}

async function getTableOrThrow(tableName) {
  const tables = await getTables();
  const table = tables.find((candidate) => candidate.name === tableName);
  if (!table) throw new Error(`Table not found: ${tableName}`);
  return table;
}

function escapeFormulaString(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeFieldName(fieldName) {
  return String(fieldName).replace(/}/g, "\\}");
}

async function resolveRecordId({ base, tableName, recordId, lookupField, lookupValue }) {
  if (recordId) return recordId;
  if (!lookupField || lookupValue === undefined) {
    throw new Error("Provide either recordId or both lookupField and lookupValue");
  }
  const table = await getTableOrThrow(tableName);
  const lookupExists = (table.fields ?? []).some((field) => field.name === lookupField);
  if (!lookupExists) throw new Error(`Field not found in ${tableName}: ${lookupField}`);
  const formula = `{${escapeFieldName(lookupField)}} = "${escapeFormulaString(lookupValue)}"`;
  const records = await base(tableName).select({ filterByFormula: formula, maxRecords: 2 }).all();
  if (!records.length) throw new Error(`No record found in ${tableName} where ${lookupField} = ${lookupValue}`);
  if (records.length > 1) throw new Error(`Multiple records found in ${tableName} where ${lookupField} = ${lookupValue}`);
  return records[0].id;
}

function fieldMapFor(table) {
  return new Map((table.fields ?? []).map((field) => [field.name, field]));
}

function parseJsonObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function parseJsonArray(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return parsed;
}

function validatePayloadFields(table, fields, { allowAttachmentAndLinkFields = false } = {}) {
  const fieldMap = fieldMapFor(table);
  const unknownFields = [];
  const blockedFields = [];

  for (const fieldName of Object.keys(fields ?? {})) {
    const field = fieldMap.get(fieldName);
    if (!field) {
      unknownFields.push(fieldName);
      continue;
    }
    if (!allowAttachmentAndLinkFields && DEFAULT_BLOCKED_FIELD_TYPES.has(field.type)) {
      blockedFields.push(`${fieldName} (${field.type})`);
    }
  }

  if (unknownFields.length) throw new Error(`Field(s) not found in ${table.name}: ${unknownFields.join(", ")}`);
  if (blockedFields.length) {
    throw new Error(`Refusing high-risk field type(s) without allowAttachmentAndLinkFields=true: ${blockedFields.join(", ")}`);
  }
}

function normalizeRecord(record) {
  return { id: record.id, fields: record.fields };
}

function changedFieldSnapshot(record, fieldNames) {
  return Object.fromEntries(fieldNames.map((fieldName) => [fieldName, record.fields[fieldName] ?? null]));
}

function appendText({ existing, text, separator, includeTimestamp }) {
  const prefix = includeTimestamp ? `[${new Date().toISOString()}] ` : "";
  const addition = `${prefix}${text}`;
  const current = existing === undefined || existing === null ? "" : String(existing);
  return current.trim() ? `${current}${separator}${addition}` : addition;
}

function registerOpsUtilityTools(server) {
  const base = getBase();

  safeTool(server, "update_record_json", "Update one Airtable record using a JSON string payload. Use when typed values such as null, booleans, numbers, arrays, or objects must be preserved.", {
    tableName: z.string(),
    recordId: z.string().optional(),
    lookupField: z.string().optional(),
    lookupValue: z.any().optional(),
    fieldsJson: z.string(),
    allowAttachmentAndLinkFields: z.boolean().optional()
  }, async ({ tableName, recordId, lookupField, lookupValue, fieldsJson, allowAttachmentAndLinkFields = false }) => {
    const table = await getTableOrThrow(tableName);
    const fields = parseJsonObject(fieldsJson, "fieldsJson");
    validatePayloadFields(table, fields, { allowAttachmentAndLinkFields });
    const id = await resolveRecordId({ base, tableName, recordId, lookupField, lookupValue });
    const before = await base(tableName).find(id);
    const [updated] = await base(tableName).update([{ id, fields }]);
    const fieldNames = Object.keys(fields);

    return jsonContent({
      success: true,
      action_attempted: "update_record_json",
      tableName,
      recordId: id,
      updatedFields: fieldNames,
      before: changedFieldSnapshot(before, fieldNames),
      after: changedFieldSnapshot(updated, fieldNames),
      data: normalizeRecord(updated)
    });
  });

  safeTool(server, "batch_update_records_json", "Update up to 10 Airtable records using a JSON string array. Each item must contain recordId and fields, preserving typed values such as null.", {
    tableName: z.string(),
    recordsJson: z.string(),
    allowAttachmentAndLinkFields: z.boolean().optional()
  }, async ({ tableName, recordsJson, allowAttachmentAndLinkFields = false }) => {
    const table = await getTableOrThrow(tableName);
    const records = parseJsonArray(recordsJson, "recordsJson");
    if (!records.length || records.length > 10) throw new Error("recordsJson must contain 1 to 10 records");
    const updates = records.map((record, index) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`recordsJson[${index}] must be an object`);
      if (!record.recordId || typeof record.recordId !== "string") throw new Error(`recordsJson[${index}].recordId must be a string`);
      if (!record.fields || typeof record.fields !== "object" || Array.isArray(record.fields)) throw new Error(`recordsJson[${index}].fields must be an object`);
      validatePayloadFields(table, record.fields, { allowAttachmentAndLinkFields });
      return { id: record.recordId, fields: record.fields };
    });
    const updated = await base(tableName).update(updates);

    return jsonContent({
      success: true,
      action_attempted: "batch_update_records_json",
      tableName,
      updatedCount: updated.length,
      updatedRecordIds: updated.map((record) => record.id),
      data: updated.map(normalizeRecord)
    });
  });

  safeTool(server, "append_text_field", "Append text to a text-like Airtable field without replacing existing notes. Useful for audit trails, operational notes, and follow-up history.", {
    tableName: z.string(),
    recordId: z.string().optional(),
    lookupField: z.string().optional(),
    lookupValue: z.any().optional(),
    fieldName: z.string(),
    text: z.string().min(1),
    separator: z.string().optional(),
    includeTimestamp: z.boolean().optional(),
    allowNonTextField: z.boolean().optional()
  }, async ({ tableName, recordId, lookupField, lookupValue, fieldName, text, separator = "\n\n", includeTimestamp = true, allowNonTextField = false }) => {
    const table = await getTableOrThrow(tableName);
    const field = fieldMapFor(table).get(fieldName);
    if (!field) throw new Error(`Field not found in ${tableName}: ${fieldName}`);
    if (!allowNonTextField && !TEXT_FIELD_TYPES.has(field.type)) {
      throw new Error(`Refusing to append text to non-text field ${fieldName} (${field.type}) without allowNonTextField=true`);
    }
    const id = await resolveRecordId({ base, tableName, recordId, lookupField, lookupValue });
    const before = await base(tableName).find(id);
    const nextValue = appendText({ existing: before.fields[fieldName], text, separator, includeTimestamp });
    const [updated] = await base(tableName).update([{ id, fields: { [fieldName]: nextValue } }]);

    return jsonContent({
      success: true,
      action_attempted: "append_text_field",
      tableName,
      recordId: id,
      fieldName,
      beforeLength: String(before.fields[fieldName] ?? "").length,
      afterLength: String(updated.fields[fieldName] ?? "").length,
      data: normalizeRecord(updated)
    });
  });
}

const originalConnect = McpServer.prototype.connect;
McpServer.prototype.connect = async function connectWithOpsUtilityTools(...args) {
  if (!this.__opsUtilityToolsRegistered) {
    registerOpsUtilityTools(this);
    this.__opsUtilityToolsRegistered = true;
  }
  return originalConnect.apply(this, args);
};
