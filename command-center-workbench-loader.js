import Airtable from "airtable";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

const STATUS_FIELDS = [
  "Status",
  "Run Status",
  "Upload Status",
  "Approval State",
  "State",
  "Priority",
  "Current Status"
];

const DATE_FIELDS = [
  "Due Date",
  "Follow-Up Date",
  "Next Review Date",
  "Deadline",
  "Decision Deadline",
  "Last Checked",
  "Upload Verified At",
  "Run Date"
];

const TITLE_FIELDS = [
  "Name",
  "Title",
  "Task",
  "Document",
  "Contract / Provider",
  "Provider",
  "Claim",
  "Case",
  "Metric",
  "Subject",
  "Filename"
];

const CATEGORY_ORDER = [
  "Today",
  "Needs source",
  "Needs review",
  "Waiting external",
  "Ready to clean",
  "Done / reference"
];

const DONE_TERMS = ["done", "closed", "resolved", "uploaded", "verified", "completed", "received", "accepted / active", "user-confirmed accepted", "skipped duplicate"];
const WAITING_TERMS = ["waiting", "pending", "requested", "waiting reply", "user handling", "monitor only", "follow-up sent", "awaiting"];
const ACTIVE_TERMS = ["open", "to do", "verification pending", "evidence gathering", "not confirmed"];
const SOURCE_TERMS = ["missing", "needs source", "source needed", "not found", "no active proof", "no current proof", "to verify"];
const REVIEW_TERMS = ["review", "human review", "ambiguous", "medium", "high risk", "unknown", "legal", "coverage", "payment", "closure", "delete", "merge", "exclusion", "cancel"];
const SUPERSEDED_TERMS = ["superseded", "replaced", "backup-only", "do not repeat", "legacy evidence pointer", "not a contract"];

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

function failure(action, error, safeFallback = "No workbench write was confirmed. This tool is read-only; retry with narrower tables or record identifiers if needed.") {
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

function normalizeValue(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(normalizeValue).filter(Boolean).join(" ");
  if (typeof value === "object") return Object.values(value).map(normalizeValue).filter(Boolean).join(" ");
  return String(value);
}

function fieldValue(fields, names) {
  for (const name of names) {
    if (fields?.[name] !== undefined && fields?.[name] !== null && normalizeValue(fields[name]).trim()) return fields[name];
  }
  return undefined;
}

function fieldText(fields, names) {
  return normalizeValue(fieldValue(fields, names)).trim();
}

function hasAny(haystack, terms) {
  return terms.some((term) => haystack.includes(term));
}

function recordHaystack(record) {
  return Object.values(record.fields || {}).map(normalizeValue).join(" ").toLowerCase();
}

function recordTitle(tableName, record) {
  return fieldText(record.fields || {}, TITLE_FIELDS) || `${tableName} ${record.id}`;
}

function statusText(record) {
  return fieldText(record.fields || {}, STATUS_FIELDS);
}

function statusHaystack(record) {
  return statusText(record).toLowerCase();
}

function dateSignals(record) {
  const fields = record.fields || {};
  const today = new Date().toISOString().slice(0, 10);
  const signals = [];
  for (const field of DATE_FIELDS) {
    const value = normalizeValue(fields[field]).trim();
    if (!value) continue;
    const iso = value.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    signals.push({ field, value, iso, isDueOrPast: Boolean(iso && iso <= today) });
  }
  return signals;
}

function hasMeaningfulField(record) {
  return Object.values(record.fields || {}).some((value) => normalizeValue(value).trim().length > 0);
}

function explicitBaseCategory(tableName, record) {
  const status = statusHaystack(record);
  if (!status) return null;
  if (hasAny(status, SUPERSEDED_TERMS)) return "Done / reference";
  if (hasAny(status, WAITING_TERMS)) return "Waiting external";
  if (hasAny(status, SOURCE_TERMS)) return "Needs source";
  if (hasAny(status, DONE_TERMS)) return "Done / reference";
  if (hasAny(status, ACTIVE_TERMS)) return tableName === "Command Center Waiting Replies" ? "Waiting external" : "Needs review";
  return null;
}

function baseCategory(tableName, record) {
  if (!hasMeaningfulField(record)) return "Ready to clean";
  const explicit = explicitBaseCategory(tableName, record);
  if (explicit) return explicit;
  const haystack = recordHaystack(record);
  if (hasAny(haystack, SUPERSEDED_TERMS)) return "Ready to clean";
  if (hasAny(haystack, WAITING_TERMS)) return "Waiting external";
  if (hasAny(haystack, SOURCE_TERMS)) return "Needs source";
  if (hasAny(haystack, REVIEW_TERMS)) return "Needs review";
  if (hasAny(haystack, DONE_TERMS)) return "Done / reference";
  return "Needs review";
}

function priorityFor({ category, tableName, record, dates }) {
  let score = 40;
  if (category === "Today") score = 95;
  if (category === "Needs source") score = 85;
  if (category === "Needs review") score = 75;
  if (category === "Waiting external") score = 55;
  if (category === "Ready to clean") score = 35;
  if (category === "Done / reference") score = 10;

  if (dates.some((date) => date.isDueOrPast)) score += 8;
  if (tableName === "Command Center Waiting Replies") score += 7;
  if (tableName === "Missing Documents") score += 5;
  if (tableName === "Attachment Intake Queue") score += 3;

  const haystack = recordHaystack(record);
  if (haystack.includes("deadline") || haystack.includes("decision")) score += 5;
  if (haystack.includes("legal") || haystack.includes("coverage") || haystack.includes("payment")) score += 4;

  return Math.min(score, 100);
}

function workbenchCategory({ base, record, dates }) {
  const status = statusHaystack(record);
  if (["Needs source", "Needs review"].includes(base) && dates.some((date) => date.isDueOrPast)) return "Today";
  if (base === "Waiting external" && dates.some((date) => date.isDueOrPast)) return "Today";
  if (status.includes("follow-up sent") || status.includes("waiting reply")) return "Waiting external";
  return base;
}

function actionFor(category, tableName, record) {
  const status = statusText(record) || "No explicit status";
  const title = recordTitle(tableName, record);
  if (category === "Today") return `Review ${title} now; confirm source and consequence before any write. Current status: ${status}.`;
  if (category === "Needs source") return "Search Gmail, Google Drive, and uploaded files for the missing source before changing status or coverage meaning.";
  if (category === "Needs review") return "Prepare a case brief and keep writes human-approved because the record may affect coverage, legal, payment, claim, or record meaning.";
  if (category === "Waiting external") return "Keep waiting; follow up only if the waiting interval or decision deadline has arrived.";
  if (category === "Ready to clean") return "Use hygiene/noise tools in dry-run first; apply only blank-row or explicitly safe cleanup.";
  return "Leave as reference material and avoid repeated reminders unless new evidence arrives.";
}

function allowedActions(category) {
  if (category === "Today") return ["prepare_action_pack", "search_sources", "draft_message_for_review", "append_note_after_approval"];
  if (category === "Needs source") return ["search_sources", "prepare_source_request", "attach_after_verified_readback"];
  if (category === "Needs review") return ["prepare_action_pack", "draft_summary", "ask_human_approval"];
  if (category === "Waiting external") return ["monitor", "follow_up_when_due", "append_waiting_note"];
  if (category === "Ready to clean") return ["dry_run_cleanup", "apply_low_risk_cleanup_after_review"];
  return ["skip", "monitor_only"];
}

function riskFlagsFor(category, record) {
  const haystack = recordHaystack(record);
  const flags = [];
  if (category === "Needs source") flags.push("source_not_verified");
  if (category === "Needs review" || category === "Today") flags.push("human_review_required");
  if (haystack.includes("legal")) flags.push("legal_or_dispute_consequence");
  if (haystack.includes("coverage") || haystack.includes("exclusion")) flags.push("coverage_consequence");
  if (haystack.includes("payment") || haystack.includes("refund") || haystack.includes("deductible")) flags.push("payment_consequence");
  if (haystack.includes("duplicate") || haystack.includes("merge")) flags.push("duplicate_or_merge_risk");
  return [...new Set(flags)];
}

function buildCard(tableName, record) {
  const dates = dateSignals(record);
  const base = baseCategory(tableName, record);
  const category = workbenchCategory({ base, record, dates });
  const priorityScore = priorityFor({ category, tableName, record, dates });
  return {
    category,
    priorityScore,
    tableName,
    recordId: record.id,
    title: recordTitle(tableName, record),
    status: statusText(record) || null,
    dateSignals: dates,
    whyItMatters: `${category} classification from current status, dates, and source/risk language.`,
    recommendedNextAction: actionFor(category, tableName, record),
    safeAvailableActions: allowedActions(category),
    blockedOrRiskReason: riskFlagsFor(category, record).join(", ") || null,
    humanReviewRequired: ["Today", "Needs review"].includes(category),
    sourceHints: sourceHints(record)
  };
}

function sourceHints(record) {
  const fields = record.fields || {};
  const hints = [];
  for (const [key, value] of Object.entries(fields)) {
    const text = normalizeValue(value).trim();
    if (!text) continue;
    const lower = key.toLowerCase();
    if (lower.includes("gmail") || lower.includes("drive") || lower.includes("source") || lower.includes("file") || lower.includes("attachment") || lower.includes("url")) {
      hints.push({ field: key, value: text.slice(0, 500) });
    }
  }
  return hints.slice(0, 8);
}

async function selectRecords(base, tableName, maxRecords) {
  try {
    const records = await base(tableName).select({ maxRecords }).all();
    return { tableName, records, warning: null };
  } catch (error) {
    return { tableName, records: [], warning: classifyError(error) };
  }
}

function summarize(cards) {
  return Object.fromEntries(CATEGORY_ORDER.map((category) => [category, cards.filter((card) => card.category === category).length]));
}

function groupCards(cards, maxItems) {
  return Object.fromEntries(CATEGORY_ORDER.map((category) => [category, cards.filter((card) => card.category === category).slice(0, maxItems)]));
}

async function buildTodayQueue({ maxRecordsPerTable = 50, maxItems = 25, tables = DEFAULT_TABLES }) {
  const base = getBase();
  const generatedAt = new Date().toISOString();
  const cards = [];
  const sourceReadback = [];
  const warnings = [];

  for (const tableName of tables) {
    const result = await selectRecords(base, tableName, maxRecordsPerTable);
    sourceReadback.push({ tableName, recordsRead: result.records.length, warning: result.warning });
    if (result.warning) {
      warnings.push({ tableName, warning: result.warning });
      continue;
    }
    for (const record of result.records) cards.push(buildCard(tableName, record));
  }

  cards.sort((a, b) => b.priorityScore - a.priorityScore || `${a.tableName}:${a.title}`.localeCompare(`${b.tableName}:${b.title}`));
  const visibleCards = cards.slice(0, maxItems);

  return {
    success: true,
    action_attempted: "get_command_center_today_queue",
    generatedAt,
    scannedTables: tables,
    maxRecordsPerTable,
    maxItems,
    counts: summarize(cards),
    topCards: visibleCards,
    sections: groupCards(cards, maxItems),
    nextBestStep: visibleCards[0]?.recommendedNextAction || "No immediate Command Center action found in the scanned records.",
    automationBoundary: {
      canDoNow: ["rank queue", "prepare action packs", "search sources", "draft messages for review", "append notes after approval"],
      keepHumanApproved: ["coverage interpretation", "legal escalation", "payment/claim closure", "contract cancellation", "ambiguous attachment", "outbound provider message"],
      safeCleanupOnly: ["blank rows", "stale follow-up fields", "text placeholders already marked safe by cleanup dry-run"]
    },
    sourceReadback,
    warnings
  };
}

async function readRecord(base, tableName, recordId) {
  const record = await base(tableName).find(recordId);
  return { id: record.id, fields: record.fields || {} };
}

function pickFields(fields) {
  const keys = [
    ...TITLE_FIELDS,
    ...STATUS_FIELDS,
    ...DATE_FIELDS,
    "Notes",
    "Summary",
    "Description",
    "Recommended Action",
    "Next Action",
    "Missing Source",
    "Source",
    "Risk",
    "Priority"
  ];
  const picked = {};
  for (const key of keys) {
    if (fields[key] !== undefined && normalizeValue(fields[key]).trim()) picked[key] = fields[key];
  }
  return picked;
}

function actionPack(tableName, record) {
  const card = buildCard(tableName, record);
  return {
    success: true,
    action_attempted: "prepare_command_center_action_pack",
    generatedAt: new Date().toISOString(),
    target: { tableName, recordId: record.id, title: card.title, status: card.status },
    classification: { category: card.category, priorityScore: card.priorityScore, humanReviewRequired: card.humanReviewRequired },
    compactFacts: pickFields(record.fields || {}),
    sourceHints: card.sourceHints,
    riskFlags: riskFlagsFor(card.category, record),
    recommendedNextAction: card.recommendedNextAction,
    safeAvailableActions: card.safeAvailableActions,
    blockedActions: [
      "Do not change legal, coverage, payment, claim, contract, or cancellation meaning without human approval.",
      "Do not attach or move evidence unless record identity and duplicate risk are verified.",
      "Do not send outbound communications without an approved draft."
    ],
    suggestedOperatorPrompt: `Prepare the next safe step for ${card.title}: ${card.recommendedNextAction}`,
    auditGuidance: "If any write or outbound communication is later executed, create or update an AI Action Runs audit record and append an operational note to the target record."
  };
}

function registerCommandCenterWorkbenchTools(server) {
  safeTool(server, "get_command_center_today_queue", "Return a ranked read-only Command Center Today Queue / Action Workbench across operational Airtable tables.", {
    maxRecordsPerTable: z.number().int().min(1).max(100).optional(),
    maxItems: z.number().int().min(1).max(100).optional(),
    tables: z.array(z.string()).min(1).max(20).optional()
  }, async ({ maxRecordsPerTable = 50, maxItems = 25, tables = DEFAULT_TABLES }) => {
    return jsonContent(await buildTodayQueue({ maxRecordsPerTable, maxItems, tables }));
  });

  safeTool(server, "prepare_command_center_action_pack", "Prepare a read-only action pack for one Command Center record: facts, risks, source hints, safe actions, and human-review boundaries.", {
    tableName: z.string().min(1),
    recordId: z.string().min(1)
  }, async ({ tableName, recordId }) => {
    const base = getBase();
    const record = await readRecord(base, tableName, recordId);
    return jsonContent(actionPack(tableName, record));
  });
}

const originalConnect = McpServer.prototype.connect;
McpServer.prototype.connect = async function connectWithCommandCenterWorkbenchTools(...args) {
  if (!this.__commandCenterWorkbenchToolsRegistered) {
    registerCommandCenterWorkbenchTools(this);
    this.__commandCenterWorkbenchToolsRegistered = true;
  }
  return originalConnect.apply(this, args);
};
