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

async function getTables() {
  const response = await fetch(
    `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`,
    {
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch tables: ${response.status} ${text}`);
  }

  const data = await response.json();
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
              fields: t.fields?.map((f) => ({
                id: f.id,
                name: f.name,
                type: f.type
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
  "Search Airtable records by plain text in a chosen field",
  {
    tableName: z.string(),
    fieldName: z.string(),
    query: z.string()
  },
  async ({ tableName, fieldName, query }) => {
    const formula = `FIND(LOWER("${query.replace(/"/g, '\\"')}"), LOWER({${fieldName}}))`;

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
