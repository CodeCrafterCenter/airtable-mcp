import express from "express";
import Airtable from "airtable";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = process.env.PORT || 3000;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

if (!AIRTABLE_API_KEY) throw new Error("Missing AIRTABLE_API_KEY");
if (!AIRTABLE_BASE_ID) throw new Error("Missing AIRTABLE_BASE_ID");

const airtable = new Airtable({ apiKey: AIRTABLE_API_KEY });
const base = airtable.base(AIRTABLE_BASE_ID);

const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
let schemaCache = {
  fetchedAt: 0,
  tables: null
};

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
    throw new Error(`Airtable API failed: ${response.status} ${text}`);
  }

  if (response.status === 204) return {};
  return response.json();
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
    throw new Error(`Airtable Meta API failed: ${response.status} ${text}`);
  }

  if (response.status === 204) return {};
  return response.json();
}

async function fetchTablesFresh() {
  const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables`);
  const tables = data.tables ?? [];
  schemaCache = {
    fetchedAt: Date.now(),
    tables
  };
  return tables;
}

async function getTables({ forceRefresh = false } = {}) {
  const isFresh =
    schemaCache.tables &&
    Date.now() - schemaCache.fetchedAt < SCHEMA_CACHE_TTL_MS;

  if (!forceRefresh && isFresh) {
    return schemaCache.tables;
  }

  return fetchTablesFresh();
}

async function getTableByName(tableName) {
  const tables = await getTables();
  const table = tables.find((t) => t.name === tableName);
  if (!table) throw new Error(`Table not found: ${tableName}`);
  return table;
}

function normalizeRecords(records) {
  return records.map((record) => ({
    id: record.id,
    fields: record.fields
  }));
}

const mcpServer = new McpServer({
  name: "airtable-mcp",
  version: "4.1.0"
});

/* ---------------- TABLES / SCHEMA ---------------- */

mcpServer.tool(
  "list_tables",
  "List all tables in the Airtable base",
  {},
  async () => {
    const tables = await getTables();

    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          tables.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description ?? null
          })),
          null,
          2
        )
      }]
    };
  }
);

mcpServer.tool(
  "get_table_schema",
  "Get schema for one table or all tables in the Airtable base",
  {
    tableName: z.string().optional(),
    forceRefresh: z.boolean().optional()
  },
  async ({ tableName, forceRefresh = false }) => {
    const tables = await getTables({ forceRefresh });

    if (tableName) {
      const t = tables.find((x) => x.name === tableName);
      if (!t) throw new Error(`Table not found: ${tableName}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            {
              id: t.id,
              name: t.name,
              description: t.description ?? null,
              fields: (t.fields ?? []).map((f) => ({
                id: f.id,
                name: f.name,
                type: f.type,
                description: f.description ?? null,
                options: f.options ?? null
              }))
            },
            null,
            2
          )
        }]
      };
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
  }
);

/* ---------------- RECORD READ ---------------- */

mcpServer.tool(
  "list_records",
  "List records from an Airtable table",
  {
    tableName: z.string(),
    maxRecords: z.number().int().min(1).max(100).optional()
  },
  async ({ tableName, maxRecords = 20 }) => {
    const records = await base(tableName).select({ maxRecords }).all();

    return {
      content: [{
        type: "text",
        text: JSON.stringify(normalizeRecords(records), null, 2)
      }]
    };
  }
);

mcpServer.tool(
  "get_record",
  "Get one Airtable record by record ID",
  {
    tableName: z.string(),
    recordId: z.string()
  },
  async ({ tableName, recordId }) => {
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
  }
);

mcpServer.tool(
  "search_records",
  "Search Airtable records by plain text in one chosen field",
  {
    tableName: z.string(),
    fieldName: z.string(),
    query: z.string(),
    maxRecords: z.number().int().min(1).max(100).optional()
  },
  async ({ tableName, fieldName, query, maxRecords = 20 }) => {
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
  }
);

mcpServer.tool(
  "find_records_across_tables",
  "Search across multiple Airtable tables",
  {
    tableNames: z.array(z.string()).min(1).max(10),
    fieldName: z.string(),
    query: z.string(),
    maxPerTable: z.number().int().min(1).max(50).optional()
  },
  async ({ tableNames, fieldName, query, maxPerTable = 10 }) => {
    const safeQuery = query.replace(/"/g, '\\"');
    const formula = `FIND(LOWER("${safeQuery}"), LOWER({${fieldName}}))`;

    const results = [];
    for (const tableName of tableNames) {
      const records = await base(tableName)
        .select({
          filterByFormula: formula,
          maxRecords: maxPerTable
        })
        .all();

      results.push({
        tableName,
        records: normalizeRecords(records)
      });
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(results, null, 2)
      }]
    };
  }
);

/* ---------------- RECORD WRITE ---------------- */

mcpServer.tool(
  "create_record",
  "Create one Airtable record",
  {
    tableName: z.string(),
    fields: z.record(z.any())
  },
  async ({ tableName, fields }) => {
    const created = await base(tableName).create([{ fields }]);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(normalizeRecords(created), null, 2)
      }]
    };
  }
);

mcpServer.tool(
  "update_record",
  "Update one Airtable record",
  {
    tableName: z.string(),
    recordId: z.string(),
    fields: z.record(z.any())
  },
  async ({ tableName, recordId, fields }) => {
    const updated = await base(tableName).update([{ id: recordId, fields }]);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(normalizeRecords(updated), null, 2)
      }]
    };
  }
);

mcpServer.tool(
  "delete_record",
  "Delete one Airtable record",
  {
    tableName: z.string(),
    recordId: z.string()
  },
  async ({ tableName, recordId }) => {
    const deleted = await base(tableName).destroy([recordId]);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(deleted, null, 2)
      }]
    };
  }
);

/* ---------------- BATCH WRITE ---------------- */

mcpServer.tool(
  "batch_create_records",
  "Create multiple Airtable records",
  {
    tableName: z.string(),
    records: z.array(z.record(z.any())).min(1).max(10)
  },
  async ({ tableName, records }) => {
    const created = await base(tableName).create(
      records.map((fields) => ({ fields }))
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify(normalizeRecords(created), null, 2)
      }]
    };
  }
);

mcpServer.tool(
  "batch_update_records",
  "Update multiple Airtable records",
  {
    tableName: z.string(),
    records: z.array(
      z.object({
        recordId: z.string(),
        fields: z.record(z.any())
      })
    ).min(1).max(10)
  },
  async ({ tableName, records }) => {
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
  }
);

mcpServer.tool(
  "batch_delete_records",
  "Delete multiple Airtable records",
  {
    tableName: z.string(),
    recordIds: z.array(z.string()).min(1).max(10)
  },
  async ({ tableName, recordIds }) => {
    const deleted = await base(tableName).destroy(recordIds);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(deleted, null, 2)
      }]
    };
  }
);

mcpServer.tool(
  "batch_upsert_records",
  "Upsert multiple Airtable records by record ID when present, otherwise create them",
  {
    tableName: z.string(),
    records: z.array(
      z.object({
        recordId: z.string().optional(),
        fields: z.record(z.any())
      })
    ).min(1).max(10)
  },
  async ({ tableName, records }) => {
    const toCreate = records.filter((r) => !r.recordId);
    const toUpdate = records.filter((r) => !!r.recordId);

    const result = { created: [], updated: [] };

    if (toCreate.length) {
      const created = await base(tableName).create(
        toCreate.map((r) => ({ fields: r.fields }))
      );
      result.created = normalizeRecords(created);
    }

    if (toUpdate.length) {
      const updated = await base(tableName).update(
        toUpdate.map((r) => ({
          id: r.recordId,
          fields: r.fields
        }))
      );
      result.updated = normalizeRecords(updated);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }]
    };
  }
);

/* ---------------- COMMENTS ---------------- */

mcpServer.tool(
  "list_record_comments",
  "List comments on an Airtable record",
  {
    recordId: z.string()
  },
  async ({ recordId }) => {
    const data = await airtableFetch(`/meta/bases/${AIRTABLE_BASE_ID}/records/${recordId}/comments`);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(data, null, 2)
      }]
    };
  }
);

mcpServer.tool(
  "create_record_comment",
  "Create a comment on an Airtable record",
  {
    recordId: z.string(),
    text: z.string()
  },
  async ({ recordId, text }) => {
    const data = await airtableFetch(`/meta/bases/${AIRTABLE_BASE_ID}/records/${recordId}/comments`, {
      method: "POST",
      body: JSON.stringify({ text })
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify(data, null, 2)
      }]
    };
  }
);

/* ---------------- SCHEMA WRITE ---------------- */

mcpServer.tool(
  "create_table",
  "Create a new Airtable table",
  {
    tableName: z.string(),
    fields: z.array(
      z.object({
        name: z.string(),
        type: z.string()
      })
    ).min(1)
  },
  async ({ tableName, fields }) => {
    const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables`, {
      method: "POST",
      body: JSON.stringify({
        name: tableName,
        fields
      })
    });

    schemaCache.fetchedAt = 0;

    return {
      content: [{
        type: "text",
        text: JSON.stringify(data, null, 2)
      }]
    };
  }
);

mcpServer.tool(
  "create_field",
  "Create a field in an Airtable table",
  {
    tableId: z.string(),
    fieldName: z.string(),
    fieldType: z.string()
  },
  async ({ tableId, fieldName, fieldType }) => {
    const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables/${tableId}/fields`, {
      method: "POST",
      body: JSON.stringify({
        name: fieldName,
        type: fieldType
      })
    });

    schemaCache.fetchedAt = 0;

    return {
      content: [{
        type: "text",
        text: JSON.stringify(data, null, 2)
      }]
    };
  }
);

mcpServer.tool(
  "update_field",
  "Update an Airtable field",
  {
    tableId: z.string(),
    fieldId: z.string(),
    name: z.string().optional(),
    description: z.string().optional()
  },
  async ({ tableId, fieldId, name, description }) => {
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
  }
);

/* ---------------- ATTACHMENTS BY URL ---------------- */

mcpServer.tool(
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
  }
);

mcpServer.tool(
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
  }
);

/* ---------------- HTTP SERVER ---------------- */

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "airtable-mcp",
    message: "Airtable MCP server is running"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    schemaCacheAgeMs: schemaCache.tables ? Date.now() - schemaCache.fetchedAt : null
  });
});

app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    res.on("close", () => {
      transport.close();
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: error.message || "Internal server error"
      });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Airtable MCP listening on port ${PORT}`);
});
