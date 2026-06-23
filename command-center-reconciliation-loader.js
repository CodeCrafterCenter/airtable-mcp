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

const CATEGORIES = [
  "Ready to execute",
  "Waiting external",
  "Needs source",
  "Needs review",
  "Done / do not repeat",
  "Superseded"
];

const DONE_TERMS = [
  "done",
  "closed",
  "resolved",
  "uploaded",
  "verified",
  "completed",
  "received",
  "accepted / active",
  "user-confirmed accepted",
  "skipped duplicate"
];

const WAITING_TERMS = [
  "waiting",
  "pending",
  "requested",
  "waiting reply",
  "user handling",
  "monitor only",
  "follow-up sent",
  "awaiting"
];

const ACTIVE_STATUS_TERMS = [
  "open",
  "to do",
  "active",
  "verification pending",
  "evidence gathering",
  "not confirmed"
];

const SOURCE_TERMS = [
  "missing",
  "needs source",
  "source needed",
  "not found",
  "no active proof",
  "no current proof",
  "to verify"
];

const REVIEW_TERMS = [
  "review",
  "human review",
  "ambiguous",
  "medium",
  "high risk",
  "unknown",
  "legal",
  "coverage",
  "payment",
  "closure",
  "delete",
  "merge"
];

const SUPERSEDED_TERMS = [
  "superseded",
  "replaced",
  "backup-only",
  "do not repeat",
  "legacy evidence pointer",
  "not a contract"
];

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

function failure(action, error, safeFallback = "No reconciliation write was confirmed. Review the dry-run output before applying any operational update.") {
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
    if (fields?.[name] !== undefined && fields?.[name] !== null && normalizeValue(fields[name]).trim()) {
      return fields[name];
    }
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
  const fields = record.fields || {};
  return fieldText(fields, [
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
  ]) || `${tableName} ${record.id}`;
}

function normalizeSelect(value) {
  return normalizeValue(value).trim().toLowerCase();
}

function hasMeaningfulField(record) {
  return Object.values(record.fields || {}).some((value) => normalizeValue(value).trim().length > 0);
}

function statusText(record) {
  return normalizeSelect(fieldValue(record.fields || {}, [
    "Status",
    "Run Status",
    "Upload Status",
    "Approval State",
    "State",
    "Priority",
    "Current Status"
  ]));
}

function itemForCategory(tableName, record, category, source = "explicit_status") {
  const sourceSuffix = source === "explicit_status" ? " Explicit status was prioritized over older note text." : "";
  const definitions = {
    "Ready to execute": {
      reason: `Record appears ready for a low-risk prepared action.${sourceSuffix}`,
      proposedAction: "Review the proposed action and execute only if it stays inside the low-risk boundary.",
      allowedExecutionLevel: "low_risk_write"
    },
    "Waiting external": {
      reason: `Record appears to be waiting on a reply, approval, provider response, or user-handled step.${sourceSuffix}`,
      proposedAction: "Keep in waiting queue; follow up only when the waiting interval has elapsed.",
      allowedExecutionLevel: "read_only"
    },
    "Needs source": {
      reason: `Record indicates a missing or unverified source document/evidence item.${sourceSuffix}`,
      proposedAction: "Search Gmail, Drive, and uploaded files for the source before changing the operational state.",
      riskFlags: ["source_not_verified"],
      allowedExecutionLevel: "read_only"
    },
    "Needs review": {
      reason: `Record is active or ambiguous and needs human-facing triage before automation.${sourceSuffix}`,
      proposedAction: "Classify the operational state, attach missing evidence if available, and update the status only after verification.",
      allowedExecutionLevel: "human_review"
    },
    "Done / do not repeat": {
      reason: `Record language indicates the work is complete, verified, accepted, uploaded, or closed.${sourceSuffix}`,
      proposedAction: "Leave as reference material and skip future reminders unless a new source changes the state.",
      allowedExecutionLevel: "none"
    },
    "Superseded": {
      reason: `Record appears to be superseded, backup-only, or a legacy pointer.${sourceSuffix}`,
      proposedAction: "Keep for retrieval if useful, but hide from default operational cockpit and avoid repeating completed work.",
      allowedExecutionLevel: "read_only"
    }
  };
  return buildItem({ tableName, record, category, ...definitions[category] });
}

function explicitStatusCategory(tableName, record) {
  const status = statusText(record);
  if (!status) return null;

  if (hasAny(status, SUPERSEDED_TERMS)) return "Superseded";
  if (hasAny(status, WAITING_TERMS)) return "Waiting external";
  if (hasAny(status, SOURCE_TERMS)) return "Needs source";

  if (hasAny(status, ACTIVE_STATUS_TERMS)) {
    return tableName === "Command Center Waiting Replies" ? "Waiting external" : "Needs review";
  }

  if (hasAny(status, DONE_TERMS)) return "Done / do not repeat";
  return null;
}

function buildItem({ tableName, record, category, reason, proposedAction, riskFlags = [], allowedExecutionLevel = "read_only" }) {
  const fields = record.fields || {};
  const status = fieldText(fields, [
    "Status",
    "Run Status",
    "Upload Status",
    "Approval State",
    "State",
    "Priority",
    "Current Status"
  ]);
  return {
    category,
    tableName,
    recordId: record.id,
    title: recordTitle(tableName, record),
    status: status || null,
    reason,
    proposedAction,
    riskFlags,
    allowedExecutionLevel
  };
}

function classifyAttachmentIntake(tableName, record) {
  const fields = record.fields || {};
  const uploadStatus = normalizeSelect(fieldValue(fields, ["Upload Status", "Status"]));
  const approvalState = normalizeSelect(fieldValue(fields, ["Approval State", "Approval"]));
  const matchConfidence = normalizeSelect(fieldValue(fields, ["Match Confidence", "Confidence"]));
  const duplicateRisk = normalizeSelect(fieldValue(fields, ["Duplicate Risk", "Duplicate Status"]));
  const targetTable = fieldText(fields, ["Suggested Target Table", "Target Table", "Resolved Target Table"]);
  const targetRecord = fieldText(fields, ["Suggested Target Record", "Target Record", "Resolved Target Record ID", "Target Record ID"]);
  const targetField = fieldText(fields, ["Target Attachment Field", "Attachment Field"]);
  const hasTarget = Boolean(targetTable && targetRecord && targetField);

  if (uploadStatus.includes("uploaded") || uploadStatus.includes("skipped duplicate")) {
    return buildItem({ tableName, record, category: "Done / do not repeat", reason: "Attachment intake already shows uploaded or duplicate-skipped.", proposedAction: "Do not re-upload unless a newer source file is confirmed.", allowedExecutionLevel: "none" });
  }

  if (approvalState.includes("approved") && matchConfidence.includes("high") && duplicateRisk.includes("low") && hasTarget) {
    return buildItem({ tableName, record, category: "Ready to execute", reason: "Approved intake item has high match confidence, low duplicate risk, and a complete target record/field.", proposedAction: "Run the uploader against the target attachment field, then verify by readback and mark the intake row uploaded.", allowedExecutionLevel: "low_risk_write" });
  }

  if (approvalState.includes("review") || approvalState.includes("blocked") || duplicateRisk.includes("medium") || duplicateRisk.includes("high") || duplicateRisk.includes("unknown") || !matchConfidence.includes("high") || !hasTarget) {
    return buildItem({ tableName, record, category: "Needs review", reason: "Attachment cannot be auto-applied because approval, match confidence, duplicate risk, or target fields are not fully safe.", proposedAction: "Resolve target identity and duplicate risk before upload.", riskFlags: ["record_identity_or_duplicate_risk"], allowedExecutionLevel: "human_review" });
  }

  return buildItem({ tableName, record, category: "Waiting external", reason: "Attachment intake is not ready yet and does not meet high-confidence upload criteria.", proposedAction: "Wait for approval or source/target clarification.", allowedExecutionLevel: "read_only" });
}

function classifyRecord(tableName, record) {
  if (tableName === "Attachment Intake Queue") return classifyAttachmentIntake(tableName, record);

  if (!hasMeaningfulField(record)) {
    return buildItem({ tableName, record, category: "Superseded", reason: "Record has no meaningful field values and is cleanup noise.", proposedAction: "Let the hygiene scan handle blank-row cleanup in dry-run first.", allowedExecutionLevel: "hygiene_review" });
  }

  const statusCategory = explicitStatusCategory(tableName, record);
  if (statusCategory) {
    return itemForCategory(tableName, record, statusCategory);
  }

  const haystack = recordHaystack(record);

  if (hasAny(haystack, SUPERSEDED_TERMS)) {
    return itemForCategory(tableName, record, "Superseded", "record_text");
  }

  if (hasAny(haystack, WAITING_TERMS)) {
    return itemForCategory(tableName, record, "Waiting external", "record_text");
  }

  if (hasAny(haystack, SOURCE_TERMS)) {
    return itemForCategory(tableName, record, "Needs source", "record_text");
  }

  if (hasAny(haystack, REVIEW_TERMS)) {
    return buildItem({ tableName, record, category: "Needs review", reason: "Record contains legal, coverage, payment, deletion, merge, unknown, or human-review language.", proposedAction: "Prepare a review packet before any write or outbound communication.", riskFlags: ["consequential_or_ambiguous_state"], allowedExecutionLevel: "human_review" });
  }

  if (hasAny(haystack, DONE_TERMS)) {
    return itemForCategory(tableName, record, "Done / do not repeat", "record_text");
  }

  if (tableName === "Tasks") {
    return buildItem({ tableName, record, category: "Needs review", reason: "Task is active but not safe enough for automatic execution without source context.", proposedAction: "Review priority, source, and consequence before acting.", allowedExecutionLevel: "human_review" });
  }

  return buildItem({ tableName, record, category: "Needs review", reason: "Record is active or ambiguous and needs human-facing triage before automation.", proposedAction: "Classify the operational state, attach missing evidence if available, and update the status only after verification.", allowedExecutionLevel: "human_review" });
}

function emptyQueues() {
  return Object.fromEntries(CATEGORIES.map((category) => [category, []]));
}

function sortQueues(queues) {
  for (const category of CATEGORIES) {
    queues[category].sort((a, b) => `${a.tableName}:${a.title}`.localeCompare(`${b.tableName}:${b.title}`));
  }
  return queues;
}

function summarizeQueues(queues) {
  return Object.fromEntries(CATEGORIES.map((category) => [category, queues[category].length]));
}

async function selectRecords(base, tableName, maxRecords) {
  try {
    const records = await base(tableName).select({ maxRecords }).all();
    return { tableName, records, warning: null };
  } catch (error) {
    return { tableName, records: [], warning: classifyError(error) };
  }
}

function nextBestStep(counts) {
  if (counts["Ready to execute"] > 0) return "Review and execute high-confidence ready items first.";
  if (counts["Needs source"] > 0) return "Search Gmail and Drive for missing source documents before changing statuses.";
  if (counts["Needs review"] > 0) return "Prepare review packets for ambiguous or consequential records.";
  if (counts["Waiting external"] > 0) return "Monitor waiting replies and follow up only when due.";
  return "No immediate operational action found in the scanned records.";
}

function buildSafeBatchProposal(queues) {
  return queues["Ready to execute"].map((item) => ({ tableName: item.tableName, recordId: item.recordId, title: item.title, proposedAction: item.proposedAction, approvalRequired: "Confirm before write unless this is a low-risk uploader readback flow." }));
}

function compactForCockpit(item) {
  return { tableName: item.tableName, recordId: item.recordId, title: item.title, status: item.status, reason: item.reason, proposedAction: item.proposedAction, riskFlags: item.riskFlags, allowedExecutionLevel: item.allowedExecutionLevel };
}

async function buildQueue({ maxRecordsPerTable = 50, tables = DEFAULT_TABLES, includeRecords = true }) {
  const base = getBase();
  const generatedAt = new Date().toISOString();
  const queues = emptyQueues();
  const sourceReadback = [];
  const warnings = [];

  for (const tableName of tables) {
    const result = await selectRecords(base, tableName, maxRecordsPerTable);
    sourceReadback.push({ tableName, recordsRead: result.records.length, warning: result.warning });
    if (result.warning) {
      warnings.push({ tableName, warning: result.warning });
      continue;
    }
    for (const record of result.records) {
      const item = classifyRecord(tableName, record);
      queues[item.category].push(item);
    }
  }

  sortQueues(queues);
  const counts = summarizeQueues(queues);

  return {
    success: true,
    action_attempted: "run_command_center_reconciliation_queue",
    generatedAt,
    scannedTables: tables,
    maxRecordsPerTable,
    counts,
    sourceReadback,
    warnings,
    nextBestStep: nextBestStep(counts),
    safeBatchProposal: buildSafeBatchProposal(queues),
    excludedRiskyActions: [
      "delete non-empty records",
      "delete fields or columns",
      "change legal, coverage, payment, claim closure, or contract status meaning",
      "move evidence when target record identity is not high-confidence",
      "send provider/customer communications without draft review"
    ],
    automationPolicy: {
      defaultMode: "dry_run",
      safeAutonomousActions: [
        "produce queues and cockpit payloads",
        "skip done or superseded reminders",
        "propose uploader actions for approved high-confidence low-duplicate intake items",
        "surface stale/noisy records for review"
      ],
      humanReviewRequiredFor: [
        "ambiguous record identity",
        "medium or high duplicate risk",
        "legal, coverage, refund, payment, claim, or cancellation consequences",
        "deleting non-empty records or deleting fields/columns"
      ]
    },
    ...(includeRecords ? { queues } : {})
  };
}

async function persistAuditRun(base, queueResult) {
  const now = new Date();
  const runId = `RECONCILIATION-BACKEND-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const nextReview = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const fields = {
    "Run ID": runId,
    "Run Date": now.toISOString(),
    "Run Status": "Completed",
    "Context Snapshot": JSON.stringify({ counts: queueResult.counts, warnings: queueResult.warnings, scannedTables: queueResult.scannedTables }).slice(0, 95000),
    "Recommended Action": queueResult.nextBestStep,
    "Airtable Update Log": "Command Center reconciliation queue generated. No source records were changed by this audit run.",
    "Next Review Date": nextReview
  };
  const created = await base("AI Action Runs").create([{ fields }]);
  return created.map((record) => ({ id: record.id, fields: record.fields }));
}

function toCockpitPayload(queueResult) {
  const sections = CATEGORIES.map((category) => ({ category, count: queueResult.counts[category] || 0, records: (queueResult.queues?.[category] || []).slice(0, 25).map(compactForCockpit) }));

  return {
    success: true,
    action_attempted: "get_command_center_cockpit_payload",
    generatedAt: queueResult.generatedAt,
    summaryCards: [
      { label: "Ready", value: queueResult.counts["Ready to execute"] || 0, tone: "action" },
      { label: "Needs source", value: queueResult.counts["Needs source"] || 0, tone: "warning" },
      { label: "Needs review", value: queueResult.counts["Needs review"] || 0, tone: "review" },
      { label: "Waiting", value: queueResult.counts["Waiting external"] || 0, tone: "muted" },
      { label: "Done", value: queueResult.counts["Done / do not repeat"] || 0, tone: "complete" },
      { label: "Superseded", value: queueResult.counts["Superseded"] || 0, tone: "quiet" }
    ],
    sections,
    approvalActions: queueResult.safeBatchProposal,
    blockedActions: queueResult.excludedRiskyActions,
    nextBestStep: queueResult.nextBestStep,
    sourceReadback: queueResult.sourceReadback,
    cockpitUrlHint: "Use this payload as the first web cockpit feed; keep Airtable as the source of truth until the app has its own database."
  };
}

function registerCommandCenterReconciliationTools(server) {
  safeTool(server, "run_command_center_reconciliation_queue", "Build a dry-run Command Center queue across Airtable tables: ready, waiting, needs source, needs review, done, and superseded. Optional audit persistence writes only to AI Action Runs.", {
    maxRecordsPerTable: z.number().int().min(1).max(100).optional(),
    tables: z.array(z.string()).min(1).max(20).optional(),
    includeRecords: z.boolean().optional(),
    persistAudit: z.boolean().optional()
  }, async ({ maxRecordsPerTable = 50, tables = DEFAULT_TABLES, includeRecords = true, persistAudit = false }) => {
    const queueResult = await buildQueue({ maxRecordsPerTable, tables, includeRecords });
    if (persistAudit) {
      const base = getBase();
      queueResult.auditRecord = await persistAuditRun(base, queueResult);
    }
    return jsonContent(queueResult);
  });

  safeTool(server, "get_command_center_cockpit_payload", "Return a compact, read-only Command Center cockpit payload for a future web UI, backed by the reconciliation queue.", {
    maxRecordsPerTable: z.number().int().min(1).max(100).optional(),
    tables: z.array(z.string()).min(1).max(20).optional()
  }, async ({ maxRecordsPerTable = 50, tables = DEFAULT_TABLES }) => {
    const queueResult = await buildQueue({ maxRecordsPerTable, tables, includeRecords: true });
    return jsonContent(toCockpitPayload(queueResult));
  });
}

const originalConnect = McpServer.prototype.connect;
McpServer.prototype.connect = async function connectWithCommandCenterReconciliationTools(...args) {
  if (!this.__commandCenterReconciliationToolsRegistered) {
    registerCommandCenterReconciliationTools(this);
    this.__commandCenterReconciliationToolsRegistered = true;
  }
  return originalConnect.apply(this, args);
};