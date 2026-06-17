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

const mcpServer = new McpServer({ name: "airtable-mcp", version: "6.0.0" });

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

async function validateFields(tableName, fields) {
  const tables = await getTables();
  const table = tables.find((t) => t.name === tableName);
  if (!table) return { valid: true, unknownFields: [] };

  const knownNames = new Set((table.fields ?? []).map((f) => f.name));
  const keys = Array.isArray(fields) ? fields : Object.keys(fields ?? {});
  const unknownFields = keys.filter((k) => !knownNames.has(k));
  return { valid: unknownFields.length === 0, unknownFields };
}

/**
 * Resolve a record ID from either a bare record ID string or a field-value
 * lookup. Accepts:
 *   - { recordId: "recXXX" }
 *   - { tableName, lookupField, lookupValue }
 */
async function resolveRecordId({ tableName, recordId, lookupField, lookupValue }) {
  if (recordId) return recordId;
  if (!tableName || !lookupField || lookupValue === undefined) {
    throw new Error(
      "Provide either recordId or all of: tableName, lookupField, lookupValue"
    );
  }
  const safeValue = String(lookupValue).replace(/"/g, '\\"');
  const formula = `{${lookupField}} = "${safeValue}"`;
  const records = await base(tableName).select({ filterByFormula: formula, maxRecords: 1 }).all();
  if (!records.length) {
    throw new Error(
      `No record found in "${tableName}" where ${lookupField} = "${lookupValue}"`
    );
  }
  return records[0].id;
}

/** Wrap a tool handler so errors always return a structured MCP error response. */
function safeHandler(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error("[airtable-mcp] tool error:", message);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }]
      };
    }
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
  {
    tableName: z.string().optional(),
    forceRefresh: z.boolean().optional()
  },
  safeHandler(async ({ tableName, forceRefresh = false }) => {
    const tables = await getTables({ forceRefresh });

    if (tableName) {
      const table = tables.find((candidate) => candidate.name === tableName);
      if (!table) throw new Error(`Table not found: ${tableName}`);
      return success("get_table_schema", compactTable(table));
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          tables.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description ?? null,
            fields: (t.fields ?? []).map((f) => ({
              id: f.id,
              name: f.name,
              type: f.type,
              description: f.description ?? null
            }))
          })),
          null,
          2
        )
      }]
    };
  })
);

/* ---------------- RECORD READ ---------------- */

tool(
  "list_records",
  "List records from an Airtable table",
  {
    tableName: z.string(),
    maxRecords: z.number().int().min(1).max(100).optional()
  },
  safeHandler(async ({ tableName, maxRecords = 20 }) => {
    const records = await base(tableName).select({ maxRecords }).all();

    return {
      content: [{
        type: "text",
        text: JSON.stringify(normalizeRecords(records), null, 2)
      }]
    };
  })
);

tool(
  "get_record",
  "Get one Airtable record by record ID",
  {
    tableName: z.string(),
    recordId: z.string()
  },
  safeHandler(async ({ tableName, recordId }) => {
    const record = await base(tableName).find(recordId);

    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          { id: record.id, fields: record.fields },
          null,
          2
        )
      }]
    };
  })
);

mcpServer.tool(
  "resolve_record",
  "Resolve a record ID by looking up a field value, or confirm an existing record ID",
  {
    tableName: z.string(),
    recordId: z.string().optional(),
    lookupField: z.string().optional(),
    lookupValue: z.string().optional()
  },
  safeHandler(async ({ tableName, recordId, lookupField, lookupValue }) => {
    const id = await resolveRecordId({ tableName, recordId, lookupField, lookupValue });
    const record = await base(tableName).find(id);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ id: record.id, fields: record.fields }, null, 2)
      }]
    };
  })
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
  safeHandler(async ({ tableName, fieldName, query, maxRecords = 20 }) => {
    const safeQuery = query.replace(/"/g, '\\"');
    const formula = `FIND(LOWER("${safeQuery}"), LOWER({${fieldName}}))`;

    const records = await base(tableName)
      .select({
        filterByFormula: formula,
        maxRecords
      })
      .all();

    return {
      content: [{
        type: "text",
        text: JSON.stringify(normalizeRecords(records), null, 2)
      }]
    };
  })
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
  safeHandler(async ({ tableNames, fieldName, query, maxPerTable = 10 }) => {
    const safeQuery = query.replace(/"/g, '\\"');
    const formula = `FIND(LOWER("${safeQuery}"), LOWER({${fieldName}}))`;

    const results = [];

    for (const tableName of tableNames) {
      const records = await base(tableName)
        .select({ filterByFormula: formula, maxRecords: maxPerTable })
        .all();
      results.push({ tableName, records: normalizeRecords(records), formula });
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(results, null, 2)
      }]
    };
  })
);

/* ---------------- RECORD WRITE ---------------- */

tool(
  "create_record",
  "Create one Airtable record",
  {
    tableName: z.string(),
    fields: z.record(z.any())
  },
  safeHandler(async ({ tableName, fields }) => {
    const { unknownFields } = await validateFields(tableName, fields);
    const created = await base(tableName).create([{ fields }]);
    const result = normalizeRecords(created);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          unknownFields.length ? { records: result, warnings: { unknownFields } } : result,
          null,
          2
        )
      }]
    };
  })
);

tool(
  "update_record",
  "Update one Airtable record",
  {
    tableName: z.string(),
    recordId: z.string().optional(),
    lookupField: z.string().optional(),
    lookupValue: z.string().optional(),
    fields: z.record(z.any())
  },
  safeHandler(async ({ tableName, recordId, lookupField, lookupValue, fields }) => {
    const id = await resolveRecordId({ tableName, recordId, lookupField, lookupValue });
    const { unknownFields } = await validateFields(tableName, fields);
    const updated = await base(tableName).update([{ id, fields }]);
    const result = normalizeRecords(updated);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          unknownFields.length ? { records: result, warnings: { unknownFields } } : result,
          null,
          2
        )
      }]
    };
  })
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
    recordId: z.string().optional(),
    lookupField: z.string().optional(),
    lookupValue: z.string().optional()
  },
  safeHandler(async ({ tableName, recordId, lookupField, lookupValue }) => {
    const id = await resolveRecordId({ tableName, recordId, lookupField, lookupValue });
    const deleted = await base(tableName).destroy([id]);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(deleted, null, 2)
      }]
    };
  })
);

/* ---------------- BATCH WRITE ---------------- */

tool(
  "batch_create_records",
  "Create multiple Airtable records",
  {
    tableName: z.string(),
    records: z.array(z.record(z.any())).min(1).max(10)
  },
  safeHandler(async ({ tableName, records }) => {
    const created = await base(tableName).create(
      records.map((fields) => ({ fields }))
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify(normalizeRecords(created), null, 2)
      }]
    };
  })
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
  safeHandler(async ({ tableName, records }) => {
    const updated = await base(tableName).update(
      records.map(({ recordId, fields }) => ({
        id: recordId,
        fields
      }))
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify(normalizeRecords(updated), null, 2)
      }]
    };
  })
);

tool(
  "batch_delete_records",
  "Delete multiple Airtable records",
  {
    tableName: z.string(),
    recordIds: z.array(z.string()).min(1).max(10)
  },
  safeHandler(async ({ tableName, recordIds }) => {
    const deleted = await base(tableName).destroy(recordIds);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(deleted, null, 2)
      }]
    };
  })
);

tool(
  "batch_upsert_records",
  "Idempotent upsert: update records that have a recordId, create those that do not",
  {
    tableName: z.string(),
    records: z
      .array(z.object({ recordId: z.string().optional(), fields: z.record(z.any()) }))
      .min(1)
      .max(10)
  },
  safeHandler(async ({ tableName, records }) => {
    const toCreate = records.filter((r) => !r.recordId);
    const toUpdate = records.filter((r) => !!r.recordId);

    const result = { created: [], updated: [] };

    if (toCreate.length) {
      const created = await base(tableName).create(
        toCreate.map((record) => ({ fields: record.fields }))
      );
      result.created = normalizeRecords(created);
    }

    if (toUpdate.length) {
      const updated = await base(tableName).update(
        toUpdate.map((record) => ({ id: record.recordId, fields: record.fields }))
      );
      result.updated = normalizeRecords(updated);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }]
    };
  })
);

/* ---------------- COMMENTS ---------------- */

tool(
  "list_record_comments",
  "List comments on an Airtable record (requires ENABLE_COMMENTS=true)",
  {
    tableName: z.string(),
    recordId: z.string()
  },
  safeHandler(async ({ tableName, recordId }) => {
    if (!ENABLE_COMMENTS) {
      throw new Error(
        "Comments are disabled. Set ENABLE_COMMENTS=true in Railway environment variables to enable this feature."
      );
    }
    const data = await airtableMetaFetch(
      `/bases/${AIRTABLE_BASE_ID}/tables/${tableName}/records/${recordId}/comments`
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    };
  })
);

tool(
  "create_record_comment",
  "Create a comment on an Airtable record (requires ENABLE_COMMENTS=true)",
  {
    tableName: z.string(),
    recordId: z.string(),
    text: z.string()
  },
  safeHandler(async ({ tableName, recordId, text }) => {
    if (!ENABLE_COMMENTS) {
      throw new Error(
        "Comments are disabled. Set ENABLE_COMMENTS=true in Railway environment variables to enable this feature."
      );
    }
    const data = await airtableMetaFetch(
      `/bases/${AIRTABLE_BASE_ID}/tables/${tableName}/records/${recordId}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ text })
      }
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    };
  })
);

/* ---------------- SCHEMA WRITE ---------------- */

function requireSchemaWrites() {
  if (!ENABLE_SCHEMA_WRITES) {
    throw new Error("Schema writes are disabled. Set ENABLE_SCHEMA_WRITES=true only after confirming the Airtable token has schema scopes.");
  }
}

tool(
  "create_table",
  "Create a new Airtable table (requires ENABLE_SCHEMA_WRITES=true)",
  {
    tableName: z.string(),
    fields: z.array(z.object({ name: z.string(), type: z.string() })).min(1)
  },
  safeHandler(async ({ tableName, fields }) => {
    if (!ENABLE_SCHEMA_WRITES) {
      throw new Error(
        "Schema writes are disabled. Set ENABLE_SCHEMA_WRITES=true in Railway environment variables to enable this feature."
      );
    }
    const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables`, {
      method: "POST",
      body: JSON.stringify({ name: tableName, fields })
    });
    schemaCache.fetchedAt = 0;

    return {
      content: [{
        type: "text",
        text: JSON.stringify(data, null, 2)
      }]
    };
  })
);


mcpServer.tool(
  "create_field",
  "Create a field in an Airtable table (requires ENABLE_SCHEMA_WRITES=true)",
  {
    tableId: z.string(),
    fieldName: z.string(),
    fieldType: z.string()
  },
  safeHandler(async ({ tableId, fieldName, fieldType }) => {
    if (!ENABLE_SCHEMA_WRITES) {
      throw new Error(
        "Schema writes are disabled. Set ENABLE_SCHEMA_WRITES=true in Railway environment variables to enable this feature."
      );
    }
    const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables/${tableId}/fields`, {
      method: "POST",
      body: JSON.stringify({ name: fieldName, type: fieldType })
    });
    schemaCache.fetchedAt = 0;

    return {
      content: [{
        type: "text",
        text: JSON.stringify(data, null, 2)
      }]
    };
  })
);

tool(
  "update_field",
  "Update an Airtable field (requires ENABLE_SCHEMA_WRITES=true)",
  {
    tableId: z.string(),
    fieldId: z.string(),
    name: z.string().optional(),
    description: z.string().optional()
  },
  safeHandler(async ({ tableId, fieldId, name, description }) => {
    if (!ENABLE_SCHEMA_WRITES) {
      throw new Error(
        "Schema writes are disabled. Set ENABLE_SCHEMA_WRITES=true in Railway environment variables to enable this feature."
      );
    }
    const body = {};
    if (name !== undefined) body.name = name;
    if (description !== undefined) body.description = description;

    const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables/${tableId}/fields/${fieldId}`, {
      method: "PATCH",
      body: JSON.stringify(body)
    });
    schemaCache.fetchedAt = 0;

    return {
      content: [{
        type: "text",
        text: JSON.stringify(data, null, 2)
      }]
    };
  })
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
  safeHandler(async ({ tableName, recordId, attachmentFieldName, fileUrl, filename }) => {
    const fields = {
      [attachmentFieldName]: [
        filename ? { url: fileUrl, filename } : { url: fileUrl }
      ]
    };

    const updated = await base(tableName).update([{ id: recordId, fields }]);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(normalizeRecords(updated), null, 2)
      }]
    };
  })
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
  safeHandler(async ({ tableName, recordId, attachmentFieldName, fileUrl, filename }) => {
    const record = await base(tableName).find(recordId);
    const existing = Array.isArray(record.fields[attachmentFieldName])
      ? record.fields[attachmentFieldName]
      : [];
    const newAttachment = filename ? { url: fileUrl, filename } : { url: fileUrl };

    const fields = {
      [attachmentFieldName]: [...existing, newAttachment]
    };

    const updated = await base(tableName).update([{ id: recordId, fields }]);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(normalizeRecords(updated), null, 2)
      }]
    };
  })
);

/* ---------------- HTTP SERVER ---------------- */

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "airtable-mcp",
    version: "6.0.0",
    message: "Airtable MCP server is running",
    capabilities: {
      schemaWrites: ENABLE_SCHEMA_WRITES,
      comments: ENABLE_COMMENTS
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: "6.0.0",
    schemaCacheAgeMs: schemaCache.tables ? Date.now() - schemaCache.fetchedAt : null,
    capabilities: {
      schemaWrites: ENABLE_SCHEMA_WRITES,
      comments: ENABLE_COMMENTS
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
  console.log(`Airtable MCP v6.0.0 listening on port ${PORT}`);
  console.log(`  Schema writes: ${ENABLE_SCHEMA_WRITES ? "ENABLED" : "disabled"}`);
  console.log(`  Comments:      ${ENABLE_COMMENTS ? "ENABLED" : "disabled"}`);
});
