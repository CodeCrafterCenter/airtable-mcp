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

async function getTables() {
  const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables`);
  return data.tables ?? [];
}

const mcpServer = new McpServer({
  name: "airtable-mcp",
  version: "2.0.0"
});

/* ---------------- READ / SCHEMA READ ---------------- */

mcpServer.tool(
  "list_tables",
  "List all tables in the Airtable base",
  {},
  async () => {
    const tables = await getTables();
    return {
      content: [{ type: "text", text: JSON.stringify(tables.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description ?? null
      })), null, 2) }]
    };
  }
);

mcpServer.tool(
  "get_table_schema",
  "Get schema for tables in the Airtable base",
  {
    tableName: z.string().optional()
  },
  async ({ tableName }) => {
    const tables = await getTables();
    const filtered = tableName ? tables.filter(t => t.name === tableName) : tables;

    return {
      content: [{ type: "text", text: JSON.stringify(filtered.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description ?? null,
        fields: (t.fields ?? []).map(f => ({
          id: f.id,
          name: f.name,
          type: f.type,
          description: f.description ?? null,
          options: f.options ?? null
        }))
      })), null, 2) }]
    };
  }
);

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
      content: [{ type: "text", text: JSON.stringify(records.map(record => ({
        id: record.id,
        fields: record.fields
      })), null, 2) }]
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
      content: [{ type: "text", text: JSON.stringify({
        id: record.id,
        fields: record.fields
      }, null, 2) }]
    };
  }
);

mcpServer.tool(
  "search_records",
  "Search Airtable records by text in a chosen field",
  {
    tableName: z.string(),
    fieldName: z.string(),
    query: z.string()
  },
  async ({ tableName, fieldName, query }) => {
    const safeQuery = query.replace(/"/g, '\\"');
    const formula = `FIND(LOWER("${safeQuery}"), LOWER({${fieldName}}))`;
    const records = await base(tableName).select({
      filterByFormula: formula,
      maxRecords: 20
    }).all();

    return {
      content: [{ type: "text", text: JSON.stringify(records.map(record => ({
        id: record.id,
        fields: record.fields
      })), null, 2) }]
    };
  }
);

/* ---------------- RECORD WRITES ---------------- */

mcpServer.tool(
  "create_record",
  "Create a new Airtable record in a table",
  {
    tableName: z.string(),
    fields: z.record(z.any())
  },
  async ({ tableName, fields }) => {
    const created = await base(tableName).create([{ fields }]);
    return {
      content: [{ type: "text", text: JSON.stringify(created.map(record => ({
        id: record.id,
        fields: record.fields
      })), null, 2) }]
    };
  }
);

mcpServer.tool(
  "update_record",
  "Update an existing Airtable record",
  {
    tableName: z.string(),
    recordId: z.string(),
    fields: z.record(z.any())
  },
  async ({ tableName, recordId, fields }) => {
    const updated = await base(tableName).update([{ id: recordId, fields }]);
    return {
      content: [{ type: "text", text: JSON.stringify(updated.map(record => ({
        id: record.id,
        fields: record.fields
      })), null, 2) }]
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
      content: [{ type: "text", text: JSON.stringify(deleted, null, 2) }]
    };
  }
);

mcpServer.tool(
  "batch_create_records",
  "Create multiple Airtable records",
  {
    tableName: z.string(),
    records: z.array(z.record(z.any())).min(1).max(10)
  },
  async ({ tableName, records }) => {
    const created = await base(tableName).create(records.map(fields => ({ fields })));
    return {
      content: [{ type: "text", text: JSON.stringify(created.map(record => ({
        id: record.id,
        fields: record.fields
      })), null, 2) }]
    };
  }
);

mcpServer.tool(
  "batch_update_records",
  "Update multiple Airtable records",
  {
    tableName: z.string(),
    records: z.array(z.object({
      recordId: z.string(),
      fields: z.record(z.any())
    })).min(1).max(10)
  },
  async ({ tableName, records }) => {
    const updated = await base(tableName).update(
      records.map(({ recordId, fields }) => ({ id: recordId, fields }))
    );
    return {
      content: [{ type: "text", text: JSON.stringify(updated.map(record => ({
        id: record.id,
        fields: record.fields
      })), null, 2) }]
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
      content: [{ type: "text", text: JSON.stringify(deleted, null, 2) }]
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
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
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
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    };
  }
);

/* ---------------- SCHEMA WRITES ---------------- */

mcpServer.tool(
  "create_table",
  "Create a new Airtable table",
  {
    tableName: z.string(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string()
    })).min(1)
  },
  async ({ tableName, fields }) => {
    const data = await airtableMetaFetch(`/bases/${AIRTABLE_BASE_ID}/tables`, {
      method: "POST",
      body: JSON.stringify({
        name: tableName,
        fields
      })
    });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
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
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
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
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    };
  }
);

/* ---------------- ATTACHMENTS ---------------- */

mcpServer.tool(
  "attach_file_to_record",
  "Attach a file URL to an Airtable attachment field",
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
      content: [{ type: "text", text: JSON.stringify(updated.map(record => ({
        id: record.id,
        fields: record.fields
      })), null, 2) }]
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
  res.json({ ok: true });
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
