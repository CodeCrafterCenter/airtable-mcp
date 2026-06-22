import Airtable from "airtable";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
const BLOCKED_FIELD_TYPES = new Set(["multipleAttachments", "multipleRecordLinks"]);

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

function failure(action, error, safeFallback = "No clear-field write was confirmed. Verify the target record and retry only the intended field names.") {
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

function isClearedValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function getFieldMap(table) {
  return new Map((table.fields ?? []).map((field) => [field.name, field]));
}

function validateClearFields(table, fieldNames, allowDestructiveFieldTypes) {
  const fieldMap = getFieldMap(table);
  const unknownFields = [];
  const blockedFields = [];
  const duplicateCheck = new Set();
  const uniqueFieldNames = [];

  for (const fieldName of fieldNames) {
    if (duplicateCheck.has(fieldName)) continue;
    duplicateCheck.add(fieldName);
    uniqueFieldNames.push(fieldName);
    const field = fieldMap.get(fieldName);
    if (!field) {
      unknownFields.push(fieldName);
      continue;
    }
    if (!allowDestructiveFieldTypes && BLOCKED_FIELD_TYPES.has(field.type)) {
      blockedFields.push({ fieldName, type: field.type });
    }
  }

  if (unknownFields.length) throw new Error(`Field(s) not found in ${table.name}: ${unknownFields.join(", ")}`);
  if (blockedFields.length) {
    const labels = blockedFields.map((field) => `${field.fieldName} (${field.type})`).join(", ");
    throw new Error(`Refusing to clear high-risk field type(s) without allowDestructiveFieldTypes=true: ${labels}`);
  }
  return uniqueFieldNames;
}

function registerClearFieldTools(server) {
  const base = getBase();

  safeTool(server, "clear_record_fields", "Clear one or more Airtable field values by setting them to null. Use for stale dates or optional operational fields when an empty string would be invalid.", {
    tableName: z.string(),
    recordId: z.string().optional(),
    lookupField: z.string().optional(),
    lookupValue: z.any().optional(),
    fieldNames: z.array(z.string()).min(1).max(50),
    allowDestructiveFieldTypes: z.boolean().optional()
  }, async ({ tableName, recordId, lookupField, lookupValue, fieldNames, allowDestructiveFieldTypes = false }) => {
    const table = await getTableOrThrow(tableName);
    const id = await resolveRecordId({ base, tableName, recordId, lookupField, lookupValue });
    const fieldsToClear = validateClearFields(table, fieldNames, allowDestructiveFieldTypes);
    const before = await base(tableName).find(id);
    const alreadyBlank = fieldsToClear.filter((fieldName) => isClearedValue(before.fields[fieldName]));
    const payload = Object.fromEntries(fieldsToClear.map((fieldName) => [fieldName, null]));
    const [updated] = await base(tableName).update([{ id, fields: payload }]);
    const verifiedCleared = fieldsToClear.filter((fieldName) => isClearedValue(updated.fields[fieldName]));

    return jsonContent({
      success: verifiedCleared.length === fieldsToClear.length,
      action_attempted: "clear_record_fields",
      tableName,
      recordId: id,
      clearedFields: verifiedCleared,
      alreadyBlank,
      requestedFields: fieldsToClear,
      blockedFieldTypesDefault: Array.from(BLOCKED_FIELD_TYPES),
      data: { id: updated.id, fields: updated.fields }
    });
  });
}

const originalConnect = McpServer.prototype.connect;
McpServer.prototype.connect = async function connectWithClearFieldTools(...args) {
  if (!this.__clearFieldToolsRegistered) {
    registerClearFieldTools(this);
    this.__clearFieldToolsRegistered = true;
  }
  return originalConnect.apply(this, args);
};
