import Airtable from "airtable";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const MAX_BATCH_DELETE = 10;

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

function failure(action, error, safeFallback = "No cleanup write was confirmed. Review the dry-run result and retry only low-risk actions.") {
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

function normalizeRecords(records) {
  return records.map((record) => ({ id: record.id, fields: record.fields }));
}

function isMeaningfulValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function isBlankRecord(record) {
  return !Object.values(record.fields || {}).some(isMeaningfulValue);
}

function fieldText(fields, fieldName) {
  return String(fields?.[fieldName] ?? "").toLowerCase();
}

function isLegacyPointer(fields) {
  const status = fieldText(fields, "Status");
  const type = fieldText(fields, "Type");
  const name = fieldText(fields, "Contract / Provider");
  return (
    status.includes("legacy evidence pointer") ||
    status.includes("legacy warranty/evidence pointer") ||
    type.includes("evidence pointer") ||
    type.includes("warranty evidence pointer") ||
    name.includes("legacy evidence pointer")
  );
}

function isPdfReadyEvidencePlaceholder(fields) {
  const status = fieldText(fields, "Status");
  const name = fieldText(fields, "Contract / Provider");
  return name.includes("pdf ready") || status.includes("evidence pdf attached in linked maintenance/warranty record");
}

function getContractsCleanViewFormula() {
  return [
    "AND(",
    '  NOT(FIND("legacy evidence pointer", LOWER({Status} & ""))),',
    '  NOT(FIND("legacy warranty/evidence pointer", LOWER({Status} & ""))),',
    '  NOT(FIND("evidence pointer", LOWER({Type} & ""))),',
    '  NOT(FIND("warranty evidence pointer", LOWER({Type} & "")))',
    ")"
  ].join("\n");
}

function buildLegacyPointerName(fields) {
  const currentName = String(fields["Contract / Provider"] || "evidence item").replace(/\s+-\s+PDF READY\s*$/i, "").trim();
  return currentName.toLowerCase().startsWith("legacy evidence pointer")
    ? currentName
    : `Legacy evidence pointer - ${currentName}`;
}

function buildPlaceholderUpdate(record) {
  const fields = record.fields || {};
  const linkedEvidence = Array.isArray(fields["Maintenance & Warranty Evidence"]) ? fields["Maintenance & Warranty Evidence"] : [];
  const evidenceRecord = linkedEvidence[0];
  const update = {
    "Contract / Provider": buildLegacyPointerName(fields),
    "Status": "Legacy evidence pointer - primary file in Maintenance & Warranty Evidence",
    "Type": "Evidence pointer (not a contract)"
  };
  if (evidenceRecord) {
    update["Key Use"] = `Retrieval pointer only. Primary evidence lives in Maintenance & Warranty Evidence ${evidenceRecord}.`;
    update["Key Missing / Caution"] = "Do not treat this Contracts row as a policy or active contract-management target. Use the linked evidence record as the primary attachment location.";
  }
  return { id: record.id, fields: update };
}

async function destroyInBatches(table, recordIds) {
  const deleted = [];
  for (let i = 0; i < recordIds.length; i += MAX_BATCH_DELETE) {
    const batch = recordIds.slice(i, i + MAX_BATCH_DELETE);
    const result = await table.destroy(batch);
    deleted.push(...normalizeRecords(result));
  }
  return deleted;
}

async function updateInBatches(table, updates) {
  const updated = [];
  for (let i = 0; i < updates.length; i += MAX_BATCH_DELETE) {
    const batch = updates.slice(i, i + MAX_BATCH_DELETE);
    const result = await table.update(batch);
    updated.push(...normalizeRecords(result));
  }
  return updated;
}

function getBase() {
  if (!AIRTABLE_API_KEY) throw new Error("Missing AIRTABLE_API_KEY");
  if (!AIRTABLE_BASE_ID) throw new Error("Missing AIRTABLE_BASE_ID");
  return new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
}

async function scanTableForBlankRows(base, tableName, maxRecords) {
  const records = await base(tableName).select({ maxRecords }).all();
  return records.filter(isBlankRecord).map((record) => ({ id: record.id, fields: record.fields }));
}

function registerCommandCenterHygieneTools(server) {
  const base = getBase();

  safeTool(server, "list_clean_contract_records", "List Contracts records with legacy evidence pointers and blank records hidden for a clean app/default-view feed", {
    maxRecords: z.number().int().min(1).max(100).optional(),
    includeHidden: z.boolean().optional()
  }, async ({ maxRecords = 100, includeHidden = false }) => {
    const records = await base("Contracts").select({ maxRecords }).all();
    const blankRows = [];
    const hiddenLegacyPointers = [];
    const visibleContracts = [];
    for (const record of records) {
      if (isBlankRecord(record)) blankRows.push(record);
      else if (isLegacyPointer(record.fields)) hiddenLegacyPointers.push(record);
      else visibleContracts.push(record);
    }
    return jsonContent({
      success: true,
      action_attempted: "list_clean_contract_records",
      data: {
        visibleContracts: normalizeRecords(visibleContracts),
        counts: {
          visibleContracts: visibleContracts.length,
          hiddenLegacyPointers: hiddenLegacyPointers.length,
          blankRows: blankRows.length
        },
        ...(includeHidden ? { hiddenLegacyPointers: normalizeRecords(hiddenLegacyPointers), blankRows: normalizeRecords(blankRows) } : {}),
        contractsCleanViewFormula: getContractsCleanViewFormula(),
        note: "Airtable API clients should use this clean feed or the formula above. Native Airtable UI view editing is not modified by this tool."
      }
    });
  });

  safeTool(server, "run_command_center_hygiene_scan", "Run a dry-run or low-risk cleanup scan for Command Center tables; apply mode can delete fully blank rows and normalize obvious Contracts evidence placeholders", {
    mode: z.enum(["dry_run", "apply"]).optional(),
    maxRecordsPerTable: z.number().int().min(1).max(100).optional(),
    tables: z.array(z.string()).min(1).max(20).optional(),
    deleteBlankRows: z.boolean().optional(),
    normalizeContractsPlaceholders: z.boolean().optional()
  }, async ({ mode = "dry_run", maxRecordsPerTable = 100, tables = ["Contracts"], deleteBlankRows = false, normalizeContractsPlaceholders = true }) => {
    const apply = mode === "apply";
    const scannedAt = new Date().toISOString();
    const blankRowsByTable = {};
    for (const tableName of tables) {
      blankRowsByTable[tableName] = await scanTableForBlankRows(base, tableName, maxRecordsPerTable);
    }

    const contractRecords = tables.includes("Contracts")
      ? await base("Contracts").select({ maxRecords: maxRecordsPerTable }).all()
      : [];
    const legacyPointers = contractRecords.filter((record) => !isBlankRecord(record) && isLegacyPointer(record.fields));
    const pdfReadyPlaceholders = contractRecords.filter((record) => !isBlankRecord(record) && isPdfReadyEvidencePlaceholder(record.fields));
    const placeholderUpdates = pdfReadyPlaceholders.map(buildPlaceholderUpdate);

    const applied = { deletedBlankRows: {}, normalizedContractsPlaceholders: [] };
    if (apply && deleteBlankRows) {
      for (const [tableName, rows] of Object.entries(blankRowsByTable)) {
        if (rows.length) {
          applied.deletedBlankRows[tableName] = await destroyInBatches(base(tableName), rows.map((row) => row.id));
        }
      }
    }
    if (apply && normalizeContractsPlaceholders && placeholderUpdates.length) {
      applied.normalizedContractsPlaceholders = await updateInBatches(base("Contracts"), placeholderUpdates);
    }

    return jsonContent({
      success: true,
      action_attempted: "run_command_center_hygiene_scan",
      mode,
      scannedAt,
      data: {
        findings: {
          blankRowsByTable,
          contracts: {
            legacyPointers: normalizeRecords(legacyPointers),
            pdfReadyPlaceholders: normalizeRecords(pdfReadyPlaceholders),
            recommendedHiddenFromDefaultView: legacyPointers.map((record) => record.id),
            contractsCleanViewFormula: getContractsCleanViewFormula()
          }
        },
        applied,
        automationPolicy: {
          dailyDefault: "dry_run",
          safeAutoApply: "delete fully blank rows only, when deleteBlankRows=true and mode=apply",
          humanReviewRequired: [
            "deleting legacy evidence pointers",
            "changing coverage, legal, claim, payment, or active status meaning",
            "deleting fields/columns or records with any non-empty value",
            "moving evidence between tables when match confidence is not high"
          ]
        }
      }
    });
  });
}

const originalConnect = McpServer.prototype.connect;
McpServer.prototype.connect = async function connectWithCommandCenterHygieneTools(...args) {
  if (!this.__commandCenterHygieneToolsRegistered) {
    registerCommandCenterHygieneTools(this);
    this.__commandCenterHygieneToolsRegistered = true;
  }
  return originalConnect.apply(this, args);
};