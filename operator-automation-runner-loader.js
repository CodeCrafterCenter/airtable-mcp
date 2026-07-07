import Airtable from "airtable";

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

const DEFAULT_TABLES = [
  "Tasks",
  "Missing Documents",
  "Attachment Intake Queue",
  "Purchase & Consumer Disputes",
  "Claims",
  "Claim Evidence & Incidents",
  "Maintenance & Warranty Evidence",
  "Dashboard Metrics",
  "Command Center Waiting Replies"
];

const STATUS_FIELDS = ["Status", "Run Status", "Upload Status", "Approval State", "State", "Priority", "Current Status"];
const TITLE_FIELDS = ["Name", "Title", "Task", "Document", "Contract / Provider", "Provider", "Claim", "Case", "Metric", "Subject", "Filename"];
const DATE_FIELDS = ["Due Date", "Follow-Up Date", "Next Review Date", "Deadline", "Decision Deadline", "Last Checked", "Run Date"];

const DONE_TERMS = ["done", "closed", "resolved", "uploaded", "verified", "completed", "received", "accepted / active", "user-confirmed accepted", "skipped duplicate"];
const WAITING_TERMS = ["waiting", "pending", "requested", "waiting reply", "user handling", "monitor only", "follow-up sent", "awaiting"];
const SOURCE_TERMS = ["missing", "needs source", "source needed", "not found", "no active proof", "no current proof", "to verify"];
const REVIEW_TERMS = ["review", "human review", "ambiguous", "medium", "high risk", "unknown", "legal", "coverage", "payment", "closure", "delete", "merge", "exclusion", "cancel"];
const SUPERSEDED_TERMS = ["superseded", "replaced", "backup-only", "do not repeat", "legacy evidence pointer", "not a contract"];

const STATE = {
  enabled: false,
  started: false,
  running: false,
  timer: null,
  intervalMinutes: 360,
  maxRecordsPerTable: 50,
  writeAudit: true,
  initialDelaySeconds: 30,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: null,
  lastSummary: null
};

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function envPositiveInt(name, fallback, minimum = 1) {
  const value = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(value) || value < minimum) return fallback;
  return value;
}

function configure() {
  STATE.enabled = envFlag("OPERATOR_AUTOMATION_ENABLED", false);
  STATE.intervalMinutes = envPositiveInt("OPERATOR_AUTOMATION_INTERVAL_MINUTES", 360, 15);
  STATE.maxRecordsPerTable = envPositiveInt("OPERATOR_AUTOMATION_MAX_RECORDS_PER_TABLE", 50, 5);
  STATE.writeAudit = envFlag("OPERATOR_AUTOMATION_WRITE_AUDIT", true);
  STATE.initialDelaySeconds = envPositiveInt("OPERATOR_AUTOMATION_INITIAL_DELAY_SECONDS", 30, 5);
}

function base() {
  if (!AIRTABLE_API_KEY) throw new Error("Missing AIRTABLE_API_KEY");
  if (!AIRTABLE_BASE_ID) throw new Error("Missing AIRTABLE_BASE_ID");
  return new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
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

function hasAny(haystack, terms) {
  return terms.some((term) => haystack.includes(term));
}

function titleFor(tableName, record) {
  return fieldText(record.fields || {}, TITLE_FIELDS) || `${tableName} ${record.id}`;
}

function hasMeaningfulField(record) {
  return Object.values(record.fields || {}).some((value) => normalizeValue(value).trim().length > 0);
}

function recordHaystack(record) {
  return Object.values(record.fields || {}).map(normalizeValue).join(" ").toLowerCase();
}

function statusHaystack(record) {
  return fieldText(record.fields || {}, STATUS_FIELDS).toLowerCase();
}

function dueSignals(record) {
  const today = new Date().toISOString().slice(0, 10);
  return DATE_FIELDS.map((field) => {
    const value = normalizeValue(record.fields?.[field]).trim();
    const iso = value.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    return value ? { field, value, iso, isDueOrPast: Boolean(iso && iso <= today) } : null;
  }).filter(Boolean);
}

function classify(tableName, record) {
  if (!hasMeaningfulField(record)) return "Superseded";
  const status = statusHaystack(record);
  const haystack = recordHaystack(record);
  const text = `${status} ${haystack}`;
  if (hasAny(status, SUPERSEDED_TERMS) || hasAny(haystack, SUPERSEDED_TERMS)) return "Superseded";
  if (hasAny(status, WAITING_TERMS)) return dueSignals(record).some((date) => date.isDueOrPast) ? "Today" : "Waiting external";
  if (hasAny(status, SOURCE_TERMS)) return "Needs source";
  if (hasAny(status, DONE_TERMS)) return "Done / reference";
  if (hasAny(text, REVIEW_TERMS)) return "Needs review";
  if (hasAny(text, WAITING_TERMS)) return "Waiting external";
  if (hasAny(text, SOURCE_TERMS)) return "Needs source";
  if (hasAny(text, DONE_TERMS)) return "Done / reference";
  return tableName === "Dashboard Metrics" ? "Done / reference" : "Needs review";
}

function priority(category, record, tableName) {
  let score = { Today: 95, "Needs source": 85, "Needs review": 75, "Waiting external": 55, Superseded: 25, "Done / reference": 10 }[category] || 40;
  if (dueSignals(record).some((date) => date.isDueOrPast)) score += 5;
  if (tableName === "Command Center Waiting Replies") score += 5;
  if (tableName === "Missing Documents") score += 4;
  return Math.min(score, 100);
}

async function readTable(airtableBase, tableName) {
  try {
    const records = await airtableBase(tableName).select({ maxRecords: STATE.maxRecordsPerTable }).all();
    return { tableName, records, warning: null };
  } catch (error) {
    return { tableName, records: [], warning: { message: error.message, name: error.name, statusCode: error.statusCode || error.status || null } };
  }
}

function summarize(cards) {
  const counts = { Today: 0, "Needs source": 0, "Needs review": 0, "Waiting external": 0, Superseded: 0, "Done / reference": 0 };
  for (const card of cards) counts[card.category] = (counts[card.category] || 0) + 1;
  return counts;
}

function connectorStatus() {
  return {
    gmail_or_email_connector_configured: Boolean(process.env.EMAIL_MCP_URL || process.env.GMAIL_MCP_URL),
    drive_connector_configured: Boolean(process.env.DRIVE_MCP_URL),
    mode: "airtable_control_plane_only_until_connectors_configured"
  };
}

async function createAuditRun(airtableBase, summary, warnings, topCards) {
  const now = new Date();
  const runId = `OPERATOR-BACKEND-AUTOMATION-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const connector = connectorStatus();
  const fields = {
    "Run ID": runId,
    "Run Date": now.toISOString(),
    "Run Status": "Completed",
    "Context Snapshot": JSON.stringify({ summary, warnings, topCards, connector }).slice(0, 95000),
    "Recommended Action": nextBestStep(summary, connector),
    "Airtable Update Log": "Railway Operator backend automation generated this read-only queue snapshot. No source records, attachments, Gmail, or Drive items were changed.",
    "Next Review Date": new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10)
  };
  const created = await airtableBase("AI Action Runs").create([{ fields }]);
  return created.map((record) => ({ id: record.id, fields: record.fields }));
}

function nextBestStep(summary, connector) {
  if (!connector.gmail_or_email_connector_configured || !connector.drive_connector_configured) {
    return "Backend Operator scan is running Airtable-only. Configure Email/Drive MCP connector URLs before pausing evidence-source discovery permanently.";
  }
  if ((summary.Today || 0) > 0) return "Review Today items first; backend source checks should remain human-approved for consequential actions.";
  if ((summary["Needs source"] || 0) > 0) return "Run connector-backed source checks for Needs source items.";
  if ((summary["Needs review"] || 0) > 0) return "Prepare review packs for ambiguous or consequential items.";
  return "No urgent Operator action found in this backend pass.";
}

export async function runOperatorAutomationOnce() {
  configure();
  if (STATE.running) return { skipped: true, reason: "already_running" };
  STATE.running = true;
  STATE.lastStartedAt = new Date().toISOString();
  STATE.lastError = null;

  try {
    const airtableBase = base();
    const cards = [];
    const sourceReadback = [];
    const warnings = [];

    for (const tableName of DEFAULT_TABLES) {
      const result = await readTable(airtableBase, tableName);
      sourceReadback.push({ tableName, recordsRead: result.records.length, warning: result.warning });
      if (result.warning) warnings.push({ tableName, warning: result.warning });
      for (const record of result.records) {
        const category = classify(tableName, record);
        cards.push({
          tableName,
          recordId: record.id,
          title: titleFor(tableName, record),
          status: fieldText(record.fields || {}, STATUS_FIELDS) || null,
          category,
          priority: priority(category, record, tableName),
          dueSignals: dueSignals(record).slice(0, 3)
        });
      }
    }

    cards.sort((a, b) => b.priority - a.priority || `${a.tableName}:${a.title}`.localeCompare(`${b.tableName}:${b.title}`));
    const summary = summarize(cards);
    const topCards = cards.slice(0, 20);
    const connector = connectorStatus();
    const auditRecord = STATE.writeAudit ? await createAuditRun(airtableBase, summary, warnings, topCards) : null;

    STATE.lastSummary = {
      generated_at: new Date().toISOString(),
      summary,
      top_count: topCards.length,
      warning_count: warnings.length,
      audit_record_ids: auditRecord?.map((record) => record.id) || [],
      connector,
      sourceReadback
    };

    console.error(`Operator automation run completed summary=${JSON.stringify(summary)} audit_records=${STATE.lastSummary.audit_record_ids.join(",") || "none"} connector_mode=${connector.mode}`);
    return STATE.lastSummary;
  } catch (error) {
    STATE.lastError = { message: error.message, name: error.name, statusCode: error.statusCode || error.status || null };
    console.error(`Operator automation run failed: ${error.message}`);
    return { success: false, error: STATE.lastError };
  } finally {
    STATE.running = false;
    STATE.lastFinishedAt = new Date().toISOString();
  }
}

export function operatorAutomationStatus() {
  configure();
  return {
    enabled: STATE.enabled,
    started: STATE.started,
    running: STATE.running,
    interval_minutes: STATE.intervalMinutes,
    max_records_per_table: STATE.maxRecordsPerTable,
    write_audit: STATE.writeAudit,
    connector: connectorStatus(),
    last_started_at: STATE.lastStartedAt,
    last_finished_at: STATE.lastFinishedAt,
    last_error: STATE.lastError,
    last_summary: STATE.lastSummary
  };
}

export function startOperatorAutomationRunner() {
  configure();
  console.error(`Operator automation flags enabled=${STATE.enabled} interval_minutes=${STATE.intervalMinutes} write_audit=${STATE.writeAudit} email_connector=${connectorStatus().gmail_or_email_connector_configured} drive_connector=${connectorStatus().drive_connector_configured}`);
  if (!STATE.enabled || STATE.started) return;
  STATE.started = true;
  const intervalMs = STATE.intervalMinutes * 60 * 1000;
  STATE.timer = setInterval(runOperatorAutomationOnce, intervalMs);
  STATE.timer.unref?.();
  setTimeout(runOperatorAutomationOnce, STATE.initialDelaySeconds * 1000).unref?.();
}

startOperatorAutomationRunner();
