import Airtable from "airtable";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_WORKPACK_LINK_FIELDS = {
  Tasks: ["Related Claim", "Related Contract", "Related Missing Document", "Related Evidence", "AI Action Runs", "Command Center Waiting Replies"],
  "Missing Documents": ["Related Contract", "Related Claim", "Attachment Intake Queue", "AI Action Runs"],
  "Attachment Intake Queue": ["Related Contract", "Related Claim", "Related Evidence", "AI Action Runs"],
  Claims: ["Related Contract", "Claim Evidence & Incidents", "Tasks", "Missing Documents", "AI Action Runs"],
  Contracts: ["Claims", "Missing Documents", "Tasks", "AI Action Runs"],
  "Purchase & Consumer Disputes": ["Tasks", "AI Action Runs", "Command Center Waiting Replies"]
};

const DEFAULT_RESOLVED_STATUS = {
  Tasks: "Closed",
  "Missing Documents": "Resolved",
  "Attachment Intake Queue": "Done",
  "Dashboard Metrics": "Done / monitor only"
};

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

function failure(action, error, safeFallback = "No Command Center workflow write was confirmed. Review the target record and retry with explicit field names if needed.") {
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

function fieldMapFor(table) {
  return new Map((table.fields ?? []).map((field) => [field.name, field]));
}

function tableHasField(table, fieldName) {
  return fieldMapFor(table).has(fieldName);
}

function firstExistingField(table, candidates) {
  const fieldMap = fieldMapFor(table);
  return candidates.find((candidate) => fieldMap.has(candidate));
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
  if (!tableHasField(table, lookupField)) throw new Error(`Field not found in ${tableName}: ${lookupField}`);
  const formula = `{${escapeFieldName(lookupField)}} = "${escapeFormulaString(lookupValue)}"`;
  const records = await base(tableName).select({ filterByFormula: formula, maxRecords: 2 }).all();
  if (!records.length) throw new Error(`No record found in ${tableName} where ${lookupField} = ${lookupValue}`);
  if (records.length > 1) throw new Error(`Multiple records found in ${tableName} where ${lookupField} = ${lookupValue}`);
  return records[0].id;
}

function normalizeRecord(record) {
  return { id: record.id, fields: record.fields };
}

function normalizeValue(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(normalizeValue).filter(Boolean).join(" ");
  if (typeof value === "object") return Object.values(value).map(normalizeValue).filter(Boolean).join(" ");
  return String(value);
}

function fieldText(fields, names) {
  for (const name of names) {
    const text = normalizeValue(fields?.[name]).trim();
    if (text) return text;
  }
  return "";
}

function isBlankValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function isDoneish(fields) {
  const text = fieldText(fields, ["Status", "Priority", "Operational View", "Upload Status", "Resolution Status"]).toLowerCase();
  return ["done", "closed", "resolved", "uploaded", "superseded", "cancelled", "canceled", "archived"].some((term) => text.includes(term));
}

function isIsoDateOnly(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function classifyDueDateNoise(value) {
  if (isBlankValue(value)) return null;
  const text = String(value).trim();
  const lower = text.toLowerCase();
  if (isIsoDateOnly(text)) {
    return {
      issue: "done_record_has_real_due_date",
      suggestedAction: "human review before clearing real due date",
      autoClearSafe: false
    };
  }
  if (/\d{4}-\d{2}-\d{2}/.test(text) && ["done", "resolved", "superseded", "uploaded", "verified", "closed"].some((term) => lower.includes(term))) {
    return {
      issue: "done_record_has_due_date_status_text",
      suggestedAction: "safe to clear Due Date text marker after review",
      autoClearSafe: true
    };
  }
  if (["when ", "ongoing", "backup", "blocked", "available", "targeted cleanup", "review only"].some((term) => lower.includes(term))) {
    return {
      issue: "done_record_has_due_date_placeholder_text",
      suggestedAction: "safe to clear Due Date placeholder text after review",
      autoClearSafe: true
    };
  }
  return {
    issue: "done_record_has_due_date_non_date_text",
    suggestedAction: "review Due Date text before clearing",
    autoClearSafe: false
  };
}

function appendText(existing, text, { separator = "\n\n", includeTimestamp = true } = {}) {
  const prefix = includeTimestamp ? `[${new Date().toISOString()}] ` : "";
  const addition = `${prefix}${text}`;
  const current = existing === undefined || existing === null ? "" : String(existing);
  return current.trim() ? `${current}${separator}${addition}` : addition;
}

function candidateNoteFields(table) {
  return ["Notes", "Operational Notes", "Internal Notes", "Upload Error / Notes", "Evidence Needed", "Key Missing / Caution"].filter((fieldName) => tableHasField(table, fieldName));
}

function buildResolvedFields(table, args) {
  const fields = {};
  const skipped = [];
  const statusFieldName = args.statusFieldName || firstExistingField(table, ["Status", "Upload Status", "Resolution Status"]);
  const statusValue = args.statusValue || DEFAULT_RESOLVED_STATUS[table.name] || "Resolved";
  if (statusFieldName) fields[statusFieldName] = statusValue;
  else skipped.push("status");

  const priorityFieldName = args.priorityFieldName || firstExistingField(table, ["Priority"]);
  if (priorityFieldName) fields[priorityFieldName] = args.priorityValue || "Closed";

  const viewFieldName = args.operationalViewFieldName || firstExistingField(table, ["Operational View"]);
  if (viewFieldName) fields[viewFieldName] = args.operationalViewValue || "Done / Closed";

  const dateFieldNames = args.clearDateFieldNames?.length ? args.clearDateFieldNames : ["Follow-Up Date", "Next Follow-Up", "Next Follow Up", "Due Date"].filter((fieldName) => tableHasField(table, fieldName));
  for (const fieldName of dateFieldNames) {
    if (tableHasField(table, fieldName)) fields[fieldName] = null;
  }

  const noteFieldName = args.noteFieldName || firstExistingField(table, candidateNoteFields(table));
  return { fields, skipped, noteFieldName };
}

async function fetchLinkedRecords({ base, record, table, maxLinkedRecords }) {
  const linked = [];
  const fieldMap = fieldMapFor(table);
  const candidateFields = DEFAULT_WORKPACK_LINK_FIELDS[table.name] ?? [];

  for (const fieldName of candidateFields) {
    const field = fieldMap.get(fieldName);
    const linkedIds = Array.isArray(record.fields[fieldName]) ? record.fields[fieldName].filter((value) => typeof value === "string") : [];
    const linkedTableId = field?.options?.linkedTableId;
    if (!linkedIds.length || !linkedTableId) continue;
    const tables = await getTables();
    const linkedTable = tables.find((candidate) => candidate.id === linkedTableId);
    if (!linkedTable) continue;
    const sampleIds = linkedIds.slice(0, maxLinkedRecords);
    const sampleRecords = [];
    for (const linkedId of sampleIds) {
      try {
        const linkedRecord = await base(linkedTable.name).find(linkedId);
        sampleRecords.push(normalizeRecord(linkedRecord));
      } catch (error) {
        sampleRecords.push({ id: linkedId, error: error?.message || String(error) });
      }
    }
    linked.push({ fieldName, linkedTableName: linkedTable.name, totalLinkedIds: linkedIds.length, records: sampleRecords });
  }

  return linked;
}

async function scanTableForNoise({ base, tableName, maxRecords, maxItems }) {
  const table = await getTableOrThrow(tableName);
  const records = await base(tableName).select({ maxRecords }).all();
  const items = [];
  for (const record of records) {
    const fields = record.fields;
    const followUpField = firstExistingField(table, ["Follow-Up Date", "Next Follow-Up", "Next Follow Up"]);
    const dueDateField = firstExistingField(table, ["Due Date"]);
    const hasStaleFollowUp = Boolean(followUpField && !isBlankValue(fields[followUpField]) && isDoneish(fields));
    const dueDateNoise = dueDateField && isDoneish(fields) ? classifyDueDateNoise(fields[dueDateField]) : null;
    const title = fieldText(fields, ["Task", "Name", "Title", "Document", "Metric Name", "Record ID", "Task ID"]) || record.id;
    if (hasStaleFollowUp || dueDateNoise) {
      items.push({
        tableName,
        recordId: record.id,
        title,
        issue: hasStaleFollowUp ? "done_record_has_follow_up_date" : dueDateNoise.issue,
        suggestedAction: hasStaleFollowUp ? `clear ${followUpField}` : dueDateNoise.suggestedAction,
        autoClearSafe: hasStaleFollowUp || Boolean(dueDateNoise.autoClearSafe),
        fields: {
          Status: fields.Status ?? null,
          Priority: fields.Priority ?? null,
          "Operational View": fields["Operational View"] ?? null,
          [followUpField || "Follow-Up Date"]: followUpField ? fields[followUpField] ?? null : null,
          [dueDateField || "Due Date"]: dueDateField ? fields[dueDateField] ?? null : null
        }
      });
    }
    if (items.length >= maxItems) break;
  }
  return items;
}

function registerWorkflowTools(server) {
  const base = getBase();

  safeTool(server, "create_audit_run", "Create a compact AI Action Runs audit record for a material Command Center operation. Requires explicit table/field names only when defaults do not exist.", {
    runId: z.string(),
    summary: z.string(),
    status: z.string().optional(),
    details: z.string().optional(),
    tableName: z.string().optional(),
    runIdFieldName: z.string().optional(),
    summaryFieldName: z.string().optional(),
    statusFieldName: z.string().optional(),
    detailsFieldName: z.string().optional(),
    dateFieldName: z.string().optional()
  }, async ({ runId, summary, status = "Completed", details = "", tableName = "AI Action Runs", runIdFieldName, summaryFieldName, statusFieldName, detailsFieldName, dateFieldName }) => {
    const table = await getTableOrThrow(tableName);
    const fields = {};
    const resolvedRunIdField = runIdFieldName || firstExistingField(table, ["Run ID", "Action Run ID", "Name", "Title"]);
    const resolvedSummaryField = summaryFieldName || firstExistingField(table, ["Summary", "Action Summary", "Airtable Update Log", "Notes", "Details"]);
    const resolvedStatusField = statusFieldName || firstExistingField(table, ["Run Status", "Status", "Result", "Outcome"]);
    const resolvedDetailsField = detailsFieldName || firstExistingField(table, ["Context Snapshot", "Details", "Airtable Update Log", "Notes", "Description", "Output"]);
    const resolvedDateField = dateFieldName || firstExistingField(table, ["Run Date", "Date", "Created Date", "Last Checked"]);

    if (resolvedRunIdField) fields[resolvedRunIdField] = runId;
    if (resolvedSummaryField) fields[resolvedSummaryField] = summary;
    if (resolvedStatusField) fields[resolvedStatusField] = status;
    if (details && resolvedDetailsField && resolvedDetailsField !== resolvedSummaryField) fields[resolvedDetailsField] = details;
    if (resolvedDateField) fields[resolvedDateField] = new Date().toISOString().slice(0, 10);
    if (!Object.keys(fields).length) throw new Error(`No usable audit fields found in ${tableName}`);

    const created = await base(tableName).create([{ fields }]);
    return jsonContent({ success: true, action_attempted: "create_audit_run", tableName, data: created.map(normalizeRecord) });
  });

  safeTool(server, "mark_record_resolved", "Safely mark one operational record resolved/closed: status/view/priority, optional date clears, and an appended note. Defaults skip missing fields.", {
    tableName: z.string(),
    recordId: z.string().optional(),
    lookupField: z.string().optional(),
    lookupValue: z.any().optional(),
    note: z.string(),
    statusValue: z.string().optional(),
    statusFieldName: z.string().optional(),
    priorityValue: z.string().optional(),
    priorityFieldName: z.string().optional(),
    operationalViewValue: z.string().optional(),
    operationalViewFieldName: z.string().optional(),
    noteFieldName: z.string().optional(),
    clearDateFieldNames: z.array(z.string()).optional(),
    includeTimestamp: z.boolean().optional()
  }, async (args) => {
    const table = await getTableOrThrow(args.tableName);
    const id = await resolveRecordId({ base, tableName: args.tableName, recordId: args.recordId, lookupField: args.lookupField, lookupValue: args.lookupValue });
    const before = await base(args.tableName).find(id);
    const { fields, skipped, noteFieldName } = buildResolvedFields(table, args);
    if (noteFieldName) {
      fields[noteFieldName] = appendText(before.fields[noteFieldName], args.note, { includeTimestamp: args.includeTimestamp !== false });
    } else {
      skipped.push("note");
    }
    if (!Object.keys(fields).length) throw new Error(`No usable fields found to resolve ${args.tableName}`);
    const [updated] = await base(args.tableName).update([{ id, fields }]);
    return jsonContent({ success: true, action_attempted: "mark_record_resolved", tableName: args.tableName, recordId: id, updatedFields: Object.keys(fields), skipped, data: normalizeRecord(updated) });
  });

  safeTool(server, "append_operational_note", "Append a standardized Command Center operational note to the best available note field without replacing existing history.", {
    tableName: z.string(),
    recordId: z.string().optional(),
    lookupField: z.string().optional(),
    lookupValue: z.any().optional(),
    note: z.string(),
    source: z.string().optional(),
    noteFieldName: z.string().optional(),
    includeTimestamp: z.boolean().optional()
  }, async ({ tableName, recordId, lookupField, lookupValue, note, source = "Command Center", noteFieldName, includeTimestamp = true }) => {
    const table = await getTableOrThrow(tableName);
    const id = await resolveRecordId({ base, tableName, recordId, lookupField, lookupValue });
    const record = await base(tableName).find(id);
    const fieldName = noteFieldName || firstExistingField(table, candidateNoteFields(table));
    if (!fieldName) throw new Error(`No known note field found in ${tableName}`);
    const text = source ? `${source}: ${note}` : note;
    const nextValue = appendText(record.fields[fieldName], text, { includeTimestamp });
    const [updated] = await base(tableName).update([{ id, fields: { [fieldName]: nextValue } }]);
    return jsonContent({ success: true, action_attempted: "append_operational_note", tableName, recordId: id, fieldName, data: normalizeRecord(updated) });
  });

  safeTool(server, "get_record_workpack", "Read-only workpack for one record plus selected linked records. Use before consequential updates or case work.", {
    tableName: z.string(),
    recordId: z.string().optional(),
    lookupField: z.string().optional(),
    lookupValue: z.any().optional(),
    includeLinked: z.boolean().optional(),
    maxLinkedRecords: z.number().int().min(1).max(5).optional()
  }, async ({ tableName, recordId, lookupField, lookupValue, includeLinked = true, maxLinkedRecords = 3 }) => {
    const table = await getTableOrThrow(tableName);
    const id = await resolveRecordId({ base, tableName, recordId, lookupField, lookupValue });
    const record = await base(tableName).find(id);
    const linked = includeLinked ? await fetchLinkedRecords({ base, record, table, maxLinkedRecords }) : [];
    return jsonContent({ success: true, action_attempted: "get_record_workpack", tableName, recordId: id, primary: normalizeRecord(record), linked });
  });

  safeTool(server, "dry_run_noise_cleanup", "Dry-run first Command Center noise scan for stale follow-up dates and Due Date text placeholders on done/closed records. Apply mode clears follow-up fields only unless applyDueDateTextCleanup=true.", {
    tableNames: z.array(z.string()).optional(),
    maxRecordsPerTable: z.number().int().min(1).max(100).optional(),
    maxItems: z.number().int().min(1).max(100).optional(),
    apply: z.boolean().optional(),
    applyDueDateTextCleanup: z.boolean().optional()
  }, async ({ tableNames = ["Tasks", "Missing Documents", "Attachment Intake Queue", "Dashboard Metrics"], maxRecordsPerTable = 50, maxItems = 50, apply = false, applyDueDateTextCleanup = false }) => {
    const allItems = [];
    for (const tableName of tableNames) {
      try {
        const remaining = Math.max(0, maxItems - allItems.length);
        if (!remaining) break;
        allItems.push(...await scanTableForNoise({ base, tableName, maxRecords: maxRecordsPerTable, maxItems: remaining }));
      } catch (error) {
        allItems.push({ tableName, error: error?.message || String(error) });
      }
    }

    const applied = [];
    if (apply) {
      for (const item of allItems) {
        let fieldName = null;
        if (item.issue === "done_record_has_follow_up_date") {
          fieldName = Object.keys(item.fields).find((key) => key.includes("Follow") && item.fields[key]);
        } else if (applyDueDateTextCleanup && item.autoClearSafe && item.issue.includes("due_date") && item.issue !== "done_record_has_real_due_date") {
          fieldName = Object.keys(item.fields).find((key) => key === "Due Date" && item.fields[key]);
        }
        if (!fieldName) continue;
        const [updated] = await base(item.tableName).update([{ id: item.recordId, fields: { [fieldName]: null } }]);
        applied.push({ tableName: item.tableName, recordId: item.recordId, clearedField: fieldName, data: normalizeRecord(updated) });
      }
    }

    return jsonContent({ success: true, action_attempted: "dry_run_noise_cleanup", mode: apply ? "applied_limited_cleanup" : "dry_run", applyDueDateTextCleanup, itemCount: allItems.length, items: allItems, applied });
  });
}

const originalConnect = McpServer.prototype.connect;
McpServer.prototype.connect = async function connectWithWorkflowTools(...args) {
  if (!this.__workflowToolsRegistered) {
    registerWorkflowTools(this);
    this.__workflowToolsRegistered = true;
  }
  return originalConnect.apply(this, args);
};
