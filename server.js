import express from "express";
import Airtable from "airtable";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = process.env.PORT || 3000;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

if (!AIRTABLE_API_KEY) {
  throw new Error("Missing AIRTABLE_API_KEY");
}

if (!AIRTABLE_BASE_ID) {
  throw new Error("Missing AIRTABLE_BASE_ID");
}

const airtable = new Airtable({ apiKey: AIRTABLE_API_KEY });
const base = airtable.base(AIRTABLE_BASE_ID);

async function fetchAirtableMeta(path) {
  const response = await fetch(`https://api.airtable.com/v0/meta${path}`, {
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Airtable meta API failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function getTables() {
  const data = await fetchAirtableMeta(`/bases/${AIRTABLE_BASE_ID}/tables`);
  return data.tables ?? [];
}

const mcpServer = new McpServer({
  name: "airtable-mcp",
  version: "1.0.0"
});

mcpServer.tool(
  "list_tables",
  "List all tables in the Airtable base",
  {},
  async () => {
    const tables = await getTables();

    return {
      content: [
        {
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
        }
      ]
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
    const filtered = tableName
      ? tables.filter((t) => t.name === tableName)
      : tables;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            filtered.map((t) => ({
              id: t.id,
              name: t.name,
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
        }
      ]
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
      content: [
        {
          type: "text",
          text: JSON.stringify(
            records.map((record) => ({
              id: record.id,
              fields: record.fields
            })),
            null,
            2
          )
        }
      ]
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
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: record.id,
              fields: record.fields
            },
            null,
            2
          )
        }
      ]
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

    const records = await base(tableName)
      .select({
        filterByFormula: formula,
        maxRecords: 20
      })
      .all();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            records.map((record) => ({
              id: record.id,
              fields: record.fields
            })),
            null,
            2
          )
        }
      ]
    };
  }
);

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
      content: [
        {
          type: "text",
          text: JSON.stringify(
            created.map((record) => ({
              id: record.id,
              fields: record.fields
            })),
            null,
            2
          )
        }
      ]
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
    const updated = await base(tableName).update([
      {
        id: recordId,
        fields
      }
    ]);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            updated.map((record) => ({
              id: record.id,
              fields: record.fields
            })),
            null,
            2
          )
        }
      ]
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
      content: [
        {
          type: "text",
          text: JSON.stringify(deleted, null, 2)
        }
      ]
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
    const created = await base(tableName).create(
      records.map((fields) => ({ fields }))
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            created.map((record) => ({
              id: record.id,
              fields: record.fields
            })),
            null,
            2
          )
        }
      ]
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
      content: [
        {
          type: "text",
          text: JSON.stringify(
            updated.map((record) => ({
              id: record.id,
              fields: record.fields
            })),
            null,
            2
          )
        }
      ]
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
      content: [
        {
          type: "text",
          text: JSON.stringify(deleted, null, 2)
        }
      ]
    };
  }
);

const app = express();
app.use(express.json({ limit: "2mb" }));

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
