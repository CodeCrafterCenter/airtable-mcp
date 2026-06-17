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

if (!AIRTABLE_API_KEY) throw new Error("Missing AIRTABLE_API_KEY");
if (!AIRTABLE_BASE_ID) throw new Error("Missing AIRTABLE_BASE_ID");

const airtable = new Airtable({ apiKey: AIRTABLE_API_KEY });
const base = airtable.base(AIRTABLE_BASE_ID);
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;

let schemaCache = { fetchedAt: 0, tables: null };

const mcpServer = new McpServer({ name: "airtable-mcp", version: "5.1.0" });

function jsonContent(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}

function success(action, data, extra = {}) {
  return jsonContent({
    success: true,
    action_attempted: action,
    ...extra,
    data
  });
}

function classifyError(error) {
  const message = error?.message || String(error);
  const statusCode = error?.statusCode || error?.status || error?.error?.statusCode || null;
  const lower = message.toLowerCase();

  const authIssue =
    statusCode === 401 ||
    statusCode === 403 ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("authentication") ||
    lower.includes("permission");

  const missingCapability =
    lower.includes("not working yet") ||
    lower.includes("disabled") ||
    lower.includes("not supported") ||
    lower.includes("missing capability");

  const missingField =
    lower.includes("unknown field") ||
    lower.includes("field") && lower.includes("not found");

  const missingTable =
    lower.includes("table") && lower.includes("not found");

  return {
    message,
    statusCode,
    auth_issue: authIssue,
    missing_capability: missingCapability,
    validation_issue: missingField || missingTable,
    recoverable: authIssue || missingCapability || missingField || missingTable
  };
}

function failure(action, error, safeFallback = "No write was confirmed. Verify the source and retry after fixing the reported issue.") {
  const classified = classifyError(error);
  return jsonContent({
    success: false,
    action_attempted: action,
    ...classified,
    safe_fallback: safeFallback,
    raw_error: classified.message
  });
}

function tool(name, description, schema, handler) {
  mcpServer.tool(name, description, schema, async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      console.error(`${name} failed:`, error);
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

function normalizeRecords(records) {
  return records.map((record) => ({ id: record.id, fields: record.fields }));
}

function compactTable(table) {
  return {
    id: table.id,
    name: table.name,
    description: table.description ?? null,
    fields: (table.fields ?? []).map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      description: field.description ?? null,
      options: field.options ?? null
    }))
  };
}

async function airtableMetaFetch(path, options = {}) {
  const response = await fetch(`https://api.airtable.com/v0/meta${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
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

async function airtableFetch(path, options = {}) {
  const response = await fetch(`https://api.airtable.com/v0${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Airtable API failed: ${response.status} ${text}`);
    error.statusCode = response.status;
    throw error;
  }

  if (response.status === 204) return {};
  return response.json();
}

async function fetchTablesFresh() {
  const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables`);
  const tables = data.tables ?? [];
  schemaCache = { fetchedAt: Date.now(), tables };
  return tables;
}

async function getTables({ forceRefresh = false } = {}) {
  const isFresh =
    schemaCache.tables &&
    Date.now() - schemaCache.fetchedAt < SCHEMA_CACHE_TTL_MS;

  if (!forceRefresh && isFresh) return schemaCache.tables;
  return fetchTablesFresh();
}

async function getTableOrThrow(tableName, options = {}) {
  const tables = await getTables(options);
  const table = tables.find((candidate) => candidate.name === tableName);
  if (!table) throw new Error(`Table not found: ${tableName}`);
  return table;
}

async function validateFields(tableName, fields, { requireAll = true } = {}) {
  const table = await getTableOrThrow(tableName);
  const existing = new Set((table.fields ?? []).map((field) => field.name));
  const requested = Array.isArray(fields) ? fields : Object.keys(fields ?? {});
  const missing = requested.filter((fieldName) => !existing.has(fieldName));

  if (requireAll && missing.length) {
    throw new Error(`Field(s) not found in ${tableName}: ${missing.join(", ")}`);
  }

  return { table, missing, valid: requested.filter((fieldName) => existing.has(fieldName)) };
}

async function selectRecords(tableName, options) {
  const records = await base(tableName).select(options).all();
  return normalizeRecords(records);
}

async function createRecords(tableName, records) {
  await validateFields(tableName, records.flatMap((record) => Object.keys(record.fields)));
  const created = await base(tableName).create(records);
  return normalizeRecords(created);
}

async function updateRecords(tableName, records) {
  await validateFields(tableName, records.flatMap((record) => Object.keys(record.fields)));
  const updated = await base(tableName).update(records);
  return normalizeRecords(updated);
}

function buildSearchFormula(searchFields, query) {
  const safeQuery = escapeFormulaString(query).toLowerCase();
  const clauses = searchFields.map((fieldName) => {
    const safeField = escapeFieldName(fieldName);
    return `FIND("${safeQuery}", LOWER({${safeField}} & ""))`;
  });
  return clauses.length === 1 ? clauses[0] : `OR(${clauses.join(", ")})`;
}

function scoreRecord(record, searchFields, query, exactFields = []) {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  let score = 0;
  const matchedFields = [];

  for (const fieldName of searchFields) {
    const value = String(record.fields[fieldName] ?? "").trim().toLowerCase();
    if (!value || !normalizedQuery) continue;
    if (value === normalizedQuery) {
      score += exactFields.includes(fieldName) ? 100 : 80;
      matchedFields.push({ fieldName, match: "exact" });
    } else if (value.includes(normalizedQuery)) {
      score += 40;
      matchedFields.push({ fieldName, match: "contains" });
    }
  }

  return { ...record, match: { score, matchedFields } };
}

function summarizeResolution(scoredRecords) {
  const sorted = [...scoredRecords].sort((a, b) => b.match.score - a.match.score);
  const top = sorted[0] ?? null;
  const second = sorted[1] ?? null;

  if (!top) {
    return {
      status: "create_new_safe",
      confidence: 0,
      human_review_required: false,
      duplicate_risk: false
    };
  }

  if (top.match.score >= 100 && (!second || second.match.score < 80)) {
    return {
      status: "exact_match",
      confidence: top.match.score,
      human_review_required: false,
      duplicate_risk: false
    };
  }

  if (top.match.score >= 40 && (!second || top.match.score - second.match.score >= 30)) {
    return {
      status: "likely_match",
      confidence: top.match.score,
      human_review_required: false,
      duplicate_risk: false
    };
  }

  return {
    status: "human_review_required",
    confidence: top.match.score,
    human_review_required: true,
    duplicate_risk: sorted.length > 1
  };
}

/* ---------------- CAPABILITIES ---------------- */

tool("get_capabilities", "Return MCP and Airtable capability status", {}, async () => {
  const capabilities = {
    canReadRecords: true,
    canWriteRecords: true,
    canReadSchema: true,
    canWriteSchema: ENABLE_SCHEMA_WRITES,
    canReadComments: ENABLE_COMMENTS,
    canWriteComments: ENABLE_COMMENTS,
    canAttachByUrl: true,
    canUploadBinaryFiles: false,
    canReplaceAttachments: true,
    canAppendAttachments: true,
    schemaCacheTtlMs: SCHEMA_CACHE_TTL_MS
  };

  return success("get_capabilities", {
    service: "airtable-mcp",
    version: "5.1.0",
    baseIdConfigured: Boolean(AIRTABLE_BASE_ID),
    capabilities,
    notes: [
      "Schema writes are disabled unless ENABLE_SCHEMA_WRITES=true.",
      "Comment endpoints are disabled unless ENABLE_COMMENTS=true.",
      "Attachment support is URL-based only; binary upload is not supported."
    ]
  });
});

/* ---------------- TABLES / SCHEMA ---------------- */

tool("list_tables", "List all tables in the Airtable base", {}, async () => {
  const tables = await getTables();
  return success(
    "list_tables",
    tables.map((table) => ({
      id: table.id,
      name: table.name,
      description: table.description ?? null
    }))
  );
});

tool(
  "get_table_schema",
  "Get schema for one table or all tables in the Airtable base",
  { tableName: z.string().optional(), forceRefresh: z.boolean().optional() },
  async ({ tableName, forceRefresh = false }) => {
    const tables = await getTables({ forceRefresh });

    if (tableName) {
      const table = tables.find((candidate) => candidate.name === tableName);
      if (!table) throw new Error(`Table not found: ${tableName}`);
      return success("get_table_schema", compactTable(table));
    }

    return success("get_table_schema", tables.map(compactTable));
  }
);

/* ---------------- RECORD READ ---------------- */

tool(
  "list_records",
  "List records from an Airtable table",
  { tableName: z.string(), maxRecords: z.number().int().min(1).max(100).optional() },
  async ({ tableName, maxRecords = 20 }) => {
    await getTableOrThrow(tableName);
    const records = await selectRecords(tableName, { maxRecords });
    return success("list_records", records);
  }
);

tool(
  "get_record",
  "Get one Airtable record by record ID",
  { tableName: z.string(), recordId: z.string() },
  async ({ tableName, recordId }) => {
    await getTableOrThrow(tableName);
    const record = await base(tableName).find(recordId);
    return success("get_record", { id: record.id, fields: record.fields });
  }
);

tool(
  "search_records",
  "Search Airtable records by plain text in one chosen field",
  {
    tableName: z.string(),
    fieldName: z.string(),
    query: z.string(),
    maxRecords: z.number().int().min(1).max(100).optional()
  },
  async ({ tableName, fieldName, query, maxRecords = 20 }) => {
    await validateFields(tableName, [fieldName]);
    const formula = buildSearchFormula([fieldName], query);
    const records = await selectRecords(tableName, { filterByFormula: formula, maxRecords });
    return success("search_records", records, { formula });
  }
);

tool(
  "find_records_across_tables",
  "Search across multiple Airtable tables",
  {
    tableNames: z.array(z.string()).min(1).max(10),
    fieldName: z.string(),
    query: z.string(),
    maxPerTable: z.number().int().min(1).max(50).optional()
  },
  async ({ tableNames, fieldName, query, maxPerTable = 10 }) => {
    const results = [];

    for (const tableName of tableNames) {
      await validateFields(tableName, [fieldName]);
      const formula = buildSearchFormula([fieldName], query);
      const records = await selectRecords(tableName, {
        filterByFormula: formula,
        maxRecords: maxPerTable
      });
      results.push({ tableName, records, formula });
    }

    return success("find_records_across_tables", results);
  }
);

tool(
  "resolve_record",
  "Resolve the best matching record and identify duplicate risk before writing",
  {
    tableName: z.string(),
    query: z.string(),
    searchFields: z.array(z.string()).min(1).max(10),
    exactFields: z.array(z.string()).optional(),
    maxRecords: z.number().int().min(1).max(50).optional()
  },
  async ({ tableName, query, searchFields, exactFields = [], maxRecords = 20 }) => {
    await validateFields(tableName, searchFields);
    const formula = buildSearchFormula(searchFields, query);
    const records = await selectRecords(tableName, { filterByFormula: formula, maxRecords });
    const scoredRecords = records.map((record) =>
      scoreRecord(record, searchFields, query, exactFields)
    );
    const resolution = summarizeResolution(scoredRecords);

    return success("resolve_record", {
      tableName,
      query,
      searchFields,
      formula,
      resolution,
      records: scoredRecords.sort((a, b) => b.match.score - a.match.score)
    });
  }
);

/* ---------------- RECORD WRITE ---------------- */

tool(
  "create_record",
  "Create one Airtable record",
  { tableName: z.string(), fields: z.record(z.any()) },
  async ({ tableName, fields }) => {
    const created = await createRecords(tableName, [{ fields }]);
    return success("create_record", created);
  }
);

tool(
  "update_record",
  "Update one Airtable record",
  { tableName: z.string(), recordId: z.string(), fields: z.record(z.any()) },
  async ({ tableName, recordId, fields }) => {
    const updated = await updateRecords(tableName, [{ id: recordId, fields }]);
    return success("update_record", updated);
  }
);

tool(
  "delete_record",
  "Delete one Airtable record",
  { tableName: z.string(), recordId: z.string() },
  async ({ tableName, recordId }) => {
    await getTableOrThrow(tableName);
    const deleted = await base(tableName).destroy([recordId]);
    return success("delete_record", deleted);
  }
);

tool(
  "upsert_record_by_field",
  "Idempotently update one Airtable record by a unique field, or create it if missing",
  {
    tableName: z.string(),
    keyFieldName: z.string(),
    keyValue: z.string(),
    fields: z.record(z.any()),
    createIfMissing: z.boolean().optional(),
    humanReviewOnMultiple: z.boolean().optional()
  },
  async ({
    tableName,
    keyFieldName,
    keyValue,
    fields,
    createIfMissing = true,
    humanReviewOnMultiple = true
  }) => {
    await validateFields(tableName, [keyFieldName, ...Object.keys(fields)]);
    const formula = `{${escapeFieldName(keyFieldName)}} = "${escapeFormulaString(keyValue)}"`;
    const matches = await selectRecords(tableName, { filterByFormula: formula, maxRecords: 10 });

    if (matches.length > 1 && humanReviewOnMultiple) {
      return jsonContent({
        success: false,
        action_attempted: "upsert_record_by_field",
        recoverable: true,
        human_review_required: true,
        duplicate_risk: true,
        safe_fallback: "Multiple records match the idempotency key. Resolve duplicates before writing.",
        data: { tableName, keyFieldName, keyValue, matches }
      });
    }

    if (matches.length === 1) {
      const updated = await updateRecords(tableName, [{ id: matches[0].id, fields }]);
      return success("upsert_record_by_field", { mode: "updated", records: updated });
    }

    if (!createIfMissing) {
      return jsonContent({
        success: false,
        action_attempted: "upsert_record_by_field",
        recoverable: true,
        safe_fallback: "No matching record was found and createIfMissing is false.",
        data: { tableName, keyFieldName, keyValue }
      });
    }

    const created = await createRecords(tableName, [
      { fields: { ...fields, [keyFieldName]: keyValue } }
    ]);
    return success("upsert_record_by_field", { mode: "created", records: created });
  }
);

/* ---------------- BATCH WRITE ---------------- */

tool(
  "batch_create_records",
  "Create multiple Airtable records",
  { tableName: z.string(), records: z.array(z.record(z.any())).min(1).max(10) },
  async ({ tableName, records }) => {
    const created = await createRecords(
      tableName,
      records.map((fields) => ({ fields }))
    );
    return success("batch_create_records", created);
  }
);

tool(
  "batch_update_records",
  "Update multiple Airtable records",
  {
    tableName: z.string(),
    records: z
      .array(z.object({ recordId: z.string(), fields: z.record(z.any()) }))
      .min(1)
      .max(10)
  },
  async ({ tableName, records }) => {
    const updated = await updateRecords(
      tableName,
      records.map(({ recordId, fields }) => ({ id: recordId, fields }))
    );
    return success("batch_update_records", updated);
  }
);

tool(
  "batch_delete_records",
  "Delete multiple Airtable records",
  { tableName: z.string(), recordIds: z.array(z.string()).min(1).max(10) },
  async ({ tableName, recordIds }) => {
    await getTableOrThrow(tableName);
    const deleted = await base(tableName).destroy(recordIds);
    return success("batch_delete_records", deleted);
  }
);

tool(
  "batch_upsert_records",
  "Upsert multiple Airtable records by record ID when present, otherwise create them",
  {
    tableName: z.string(),
    records: z
      .array(z.object({ recordId: z.string().optional(), fields: z.record(z.any()) }))
      .min(1)
      .max(10)
  },
  async ({ tableName, records }) => {
    const toCreate = records.filter((record) => !record.recordId);
    const toUpdate = records.filter((record) => record.recordId);
    const result = { created: [], updated: [] };

    if (toCreate.length) {
      result.created = await createRecords(
        tableName,
        toCreate.map((record) => ({ fields: record.fields }))
      );
    }

    if (toUpdate.length) {
      result.updated = await updateRecords(
        tableName,
        toUpdate.map((record) => ({ id: record.recordId, fields: record.fields }))
      );
    }

    return success("batch_upsert_records", result);
  }
);

/* ---------------- COMMENTS ---------------- */

tool(
  "list_record_comments",
  "List comments on an Airtable record",
  { recordId: z.string() },
  async ({ recordId }) => {
    if (!ENABLE_COMMENTS) {
      throw new Error("Comment endpoints are disabled. Set ENABLE_COMMENTS=true after verifying Airtable comment API access.");
    }

    const data = await airtableFetch(`/${AIRTABLE_BASE_ID}/${recordId}/comments`);
    return success("list_record_comments", data);
  }
);

tool(
  "create_record_comment",
  "Create a comment on an Airtable record",
  { recordId: z.string(), text: z.string() },
  async ({ recordId, text }) => {
    if (!ENABLE_COMMENTS) {
      throw new Error("Comment endpoints are disabled. Set ENABLE_COMMENTS=true after verifying Airtable comment API access.");
    }

    const data = await airtableFetch(`/${AIRTABLE_BASE_ID}/${recordId}/comments`, {
      method: "POST",
      body: JSON.stringify({ text })
    });
    return success("create_record_comment", data);
  }
);

/* ---------------- SCHEMA WRITE ---------------- */

function requireSchemaWrites() {
  if (!ENABLE_SCHEMA_WRITES) {
    throw new Error("Schema writes are disabled. Set ENABLE_SCHEMA_WRITES=true only after confirming the Airtable token has schema scopes.");
  }
}

tool(
  "create_table",
  "Create a new Airtable table",
  {
    tableName: z.string(),
    fields: z.array(z.object({ name: z.string(), type: z.string() })).min(1)
  },
  async ({ tableName, fields }) => {
    requireSchemaWrites();
    const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables`, {
      method: "POST",
      body: JSON.stringify({ name: tableName, fields })
    });
    schemaCache.fetchedAt = 0;
    return success("create_table", data);
  }
);

tool(
  "create_field",
  "Create a field in an Airtable table",
  { tableId: z.string(), fieldName: z.string(), fieldType: z.string() },
  async ({ tableId, fieldName, fieldType }) => {
    requireSchemaWrites();
    const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables/${tableId}/fields`, {
      method: "POST",
      body: JSON.stringify({ name: fieldName, type: fieldType })
    });
    schemaCache.fetchedAt = 0;
    return success("create_field", data);
  }
);

tool(
  "update_field",
  "Update an Airtable field",
  {
    tableId: z.string(),
    fieldId: z.string(),
    name: z.string().optional(),
    description: z.string().optional()
  },
  async ({ tableId, fieldId, name, description }) => {
    requireSchemaWrites();
    const body = {};
    if (name !== undefined) body.name = name;
    if (description !== undefined) body.description = description;

    const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables/${tableId}/fields/${fieldId}`, {
      method: "PATCH",
      body: JSON.stringify(body)
    });
    schemaCache.fetchedAt = 0;
    return success("update_field", data);
  }
);

/* ---------------- ATTACHMENTS BY URL ---------------- */

tool(
  "attach_file_to_record",
  "Replace an attachment field with one file URL",
  {
    tableName: z.string(),
    recordId: z.string(),
    attachmentFieldName: z.string(),
    fileUrl: z.string().url(),
    filename: z.string().optional()
  },
  async ({ tableName, recordId, attachmentFieldName, fileUrl, filename }) => {
    await validateFields(tableName, [attachmentFieldName]);
    const attachment = filename ? { url: fileUrl, filename } : { url: fileUrl };
    const updated = await updateRecords(tableName, [
      { id: recordId, fields: { [attachmentFieldName]: [attachment] } }
    ]);
    return success("attach_file_to_record", updated, {
      warning: "This replaces the existing attachment field value. Prefer append_attachment_to_record when preserving evidence."
    });
  }
);

tool(
  "append_attachment_to_record",
  "Append a file URL to an existing attachment field",
  {
    tableName: z.string(),
    recordId: z.string(),
    attachmentFieldName: z.string(),
    fileUrl: z.string().url(),
    filename: z.string().optional()
  },
  async ({ tableName, recordId, attachmentFieldName, fileUrl, filename }) => {
    await validateFields(tableName, [attachmentFieldName]);
    const record = await base(tableName).find(recordId);
    const existing = Array.isArray(record.fields[attachmentFieldName])
      ? record.fields[attachmentFieldName]
      : [];
    const newAttachment = filename ? { url: fileUrl, filename } : { url: fileUrl };

    const updated = await updateRecords(tableName, [
      { id: recordId, fields: { [attachmentFieldName]: [...existing, newAttachment] } }
    ]);
    return success("append_attachment_to_record", updated);
  }
);

/* ---------------- HTTP SERVER ---------------- */

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "airtable-mcp",
    version: "5.1.0",
    message: "Airtable MCP server is running"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    schemaCacheAgeMs: schemaCache.tables ? Date.now() - schemaCache.fetchedAt : null,
    capabilities: {
      schemaWritesEnabled: ENABLE_SCHEMA_WRITES,
      commentsEnabled: ENABLE_COMMENTS,
      binaryUploadsEnabled: false
    }
  });
});

app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        action_attempted: "mcp_http_request",
        ...classifyError(error),
        raw_error: error?.message || "Internal server error"
      });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Airtable MCP listening on port ${PORT}`);
});
