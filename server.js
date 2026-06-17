import express from "express";
import Airtable from "airtable";

const app = express();
app.use(express.json());

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const PORT = process.env.PORT || 3000;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error("Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID");
}

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Airtable MCP server is running"
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/tables/:table/records", async (req, res) => {
  try {
    const tableName = req.params.table;
    const records = [];

    await base(tableName)
      .select({ maxRecords: 20 })
      .eachPage(function page(partialRecords, fetchNextPage) {
        partialRecords.forEach((record) => {
          records.push({
            id: record.id,
            fields: record.fields
          });
        });
        fetchNextPage();
      });

    res.json({ ok: true, records });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
