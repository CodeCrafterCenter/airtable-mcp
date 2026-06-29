import Airtable from "airtable";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const ATTACHMENT_INTAKE_TABLE_NAME = process.env.ATTACHMENT_INTAKE_TABLE_NAME || "Attachment Intake Queue";

function jsonContent(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
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

function sanitizeFilename(filename = "attachment") {
  const cleaned = String(filename).replace(/[\\/]/g, "_").replaceAll(String.fromCharCode(0), "_").replace(/[\r\n]/g, "_").trim();
  return cleaned || "attachment";
}

function attachmentFilename(attachment) {
  return String(attachment?.filename || attachment?.name || "").trim();
}

function hasAttachmentFilename(attachments, filename) {
  const wanted = sanitizeFilename(filename).toLowerCase();
  return attachments.some((attachment) => attachmentFilename(attachment).toLowerCase() === wanted);
}

function firstText(fields, names) {
  for (const name of names) {
    const value = normalizeValue(fields?.[name]).trim();
    if (value) return value;
  }
  return "";
}

function parseRecordId(text) {
  return normalizeValue(text).match(/\brec[a-zA-Z0-9]{14,}\b/)?.[0] || null;
}

function splitFilenameList(text) {
  const cleaned = normalizeValue(text)
    .replace(/^.*?\battachments?:/i, "")
    .replace(/^.*?:\s*/, "")
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/\s*;\s*|\s+\band\b\s+|\s+\bet\b\s+/i)
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter((part) => /\.[a-z0-9]{2,5}$/i.test(part));
}

function candidateFilesFromRecord(fields) {
  const sources = [
    firstText(fields, ["File Name", "Filename", "Attachments", "Attachment Names"]),
    firstText(fields, ["Source Reference", "Source", "Gmail Source", "Source Notes"])
  ];
  const seen = new Set();
  const files = [];
  for (const source of sources) {
    for (const filename of splitFilenameList(source)) {
      const key = filename.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({ filename });
    }
  }
  return files;
}

function isImageLike(file) {
  const text = `${file.filename || ""} ${file.mimeType || file.mime_type || ""}`.toLowerCase();
  return text.includes("image/") || /\.(heic|heif|jpe?g|png|webp|gif|tiff?)$/i.test(file.filename || "") || text.includes("screenshot") || text.includes("photo");
}

function isLikelyInvoiceOrPaymentFile(file) {
  const text = `${file.filename || ""} ${file.mimeType || file.mime_type || ""}`.toLowerCase();
  return ["invoice", "facture", "receipt", "recu", "payment", "paiement", "quote", "devis"].some((term) => text.includes(term));
}

function isExplicitDuplicateFile(file) {
  const text = `${file.filename || ""} ${file.reason || ""} ${file.notes || ""}`.toLowerCase();
  return ["duplicate", "already attached", "already queued", "already represented", "same invoice"].some((term) => text.includes(term));
}

function assessFile(file, context) {
  const filename = sanitizeFilename(file.filename);
  const duplicateRisk = normalizeValue(context.duplicateRisk).toLowerCase();
  const contextText = normalizeValue(context.contextText).toLowerCase();
  const hasHighPacketDuplicateRisk = duplicateRisk.includes("medium") || duplicateRisk.includes("high") || contextText.includes("duplicate");
  const imageLike = isImageLike(file);
  const invoiceOrPayment = isLikelyInvoiceOrPaymentFile(file);
  const explicitDuplicate = isExplicitDuplicateFile(file);

  if (explicitDuplicate || (hasHighPacketDuplicateRisk && invoiceOrPayment)) {
    return {
      filename,
      action: "hold_or_skip_duplicate",
      executable: false,
      reason: "File is invoice/payment-like inside a duplicate-risk packet; hold or skip until duplicate/content status is verified."
    };
  }

  if (imageLike) {
    return {
      filename,
      action: "auto_attach_if_url_available",
      executable: Boolean(file.fileUrl),
      reason: "Image/screenshot evidence can be attached when the target record and attachment field are high-confidence; it does not change claim/payment/legal conclusions."
    };
  }

  if (!hasHighPacketDuplicateRisk) {
    return {
      filename,
      action: "auto_attach_if_url_available",
      executable: Boolean(file.fileUrl),
      reason: "No packet-level duplicate risk blocks this file and target context can be verified."
    };
  }

  return {
    filename,
    action: "human_review_required",
    executable: false,
    reason: "File is not clearly safe to split from the packet under current duplicate/consequence signals."
  };
}

async function appendOrSkipAttachment(base, { tableName, recordId, attachmentFieldName, fileUrl, filename, skipDuplicates = true }) {
  const record = await base(tableName).find(recordId);
  const existing = Array.isArray(record.fields[attachmentFieldName]) ? record.fields[attachmentFieldName] : [];
  if (skipDuplicates && hasAttachmentFilename(existing, filename)) {
    return { filename: sanitizeFilename(filename), skippedDuplicate: true, verified: true };
  }
  await base(tableName).update([{ id: recordId, fields: { [attachmentFieldName]: [...existing, { url: fileUrl, filename: sanitizeFilename(filename) }] } }]);
  const updated = await base(tableName).find(recordId);
  const attachments = Array.isArray(updated.fields[attachmentFieldName]) ? updated.fields[attachmentFieldName] : [];
  return { filename: sanitizeFilename(filename), skippedDuplicate: false, verified: hasAttachmentFilename(attachments, filename) };
}

async function updateOptionalFields(base, tableName, recordId, candidateFields) {
  const record = await base(tableName).find(recordId);
  const fields = {};
  for (const [fieldName, value] of Object.entries(candidateFields)) {
    if (value !== undefined && value !== null && Object.prototype.hasOwnProperty.call(record.fields, fieldName)) fields[fieldName] = value;
  }
  if (!Object.keys(fields).length) return null;
  const [updated] = await base(tableName).update([{ id: recordId, fields }]);
  return { id: updated.id, fields: updated.fields };
}

function buildPlan({ intakeTableName, intakeRecordId, fields, candidateFiles, targetTableName, targetRecordId, attachmentFieldName }) {
  const contextText = normalizeValue(fields);
  const resolvedTargetTable = targetTableName || firstText(fields, ["Suggested Target Table", "Target Table"]);
  const resolvedTargetRecordId = targetRecordId || parseRecordId(firstText(fields, ["Suggested Target Record", "Target Record"]));
  const resolvedAttachmentField = attachmentFieldName || firstText(fields, ["Target Attachment Field", "Attachment Field"]) || "Evidence Files";
  const files = candidateFiles?.length ? candidateFiles : candidateFilesFromRecord(fields);
  const fileDecisions = files.map((file) => assessFile(file, { duplicateRisk: fields["Duplicate Risk"], contextText }));
  const attachable = fileDecisions.filter((decision) => decision.action === "auto_attach_if_url_available");
  const held = fileDecisions.filter((decision) => decision.action !== "auto_attach_if_url_available");
  const canExecute = Boolean(resolvedTargetTable && resolvedTargetRecordId && resolvedAttachmentField && candidateFiles?.some((file) => file.fileUrl));

  return {
    intake: { tableName: intakeTableName, recordId: intakeRecordId },
    target: { tableName: resolvedTargetTable || null, recordId: resolvedTargetRecordId, attachmentFieldName: resolvedAttachmentField },
    posture: attachable.length ? "split_and_attach_safe_files" : "review_packet",
    recommendedNextAction: attachable.length
      ? "Split this mixed packet by file: attach safe distinct files with available URLs, and hold only duplicate-risk or consequence-sensitive files."
      : "Keep this packet in human review until a safe file-level attachment decision is available.",
    fileDecisions,
    heldFiles: held,
    canExecuteSafeAttachments: canExecute,
    blockedConclusions: [
      "Do not change legal, coverage, claim, payment, liability, franchise recovery, cancellation, closure, deletion, merge, or outbound-message meaning from this file split alone."
    ]
  };
}

function registerEvidencePolicyTools(server) {
  server.tool(
    "prepare_mixed_packet_attachment_plan",
    "Read an Attachment Intake Queue record and split mixed evidence packets by file, so safe distinct attachments can proceed while duplicate-risk or consequence-sensitive files remain held.",
    {
      intakeTableName: z.string().optional(),
      intakeRecordId: z.string(),
      candidateFiles: z.array(z.object({
        filename: z.string(),
        mimeType: z.string().optional(),
        fileUrl: z.string().url().optional(),
        notes: z.string().optional()
      })).optional(),
      targetTableName: z.string().optional(),
      targetRecordId: z.string().optional(),
      attachmentFieldName: z.string().optional(),
      executeSafeAttachments: z.boolean().optional(),
      skipDuplicates: z.boolean().optional()
    },
    async ({ intakeTableName = ATTACHMENT_INTAKE_TABLE_NAME, intakeRecordId, candidateFiles, targetTableName, targetRecordId, attachmentFieldName, executeSafeAttachments = false, skipDuplicates = true }) => {
      try {
        const base = getBase();
        const intake = await base(intakeTableName).find(intakeRecordId);
        const plan = buildPlan({ intakeTableName, intakeRecordId, fields: intake.fields || {}, candidateFiles, targetTableName, targetRecordId, attachmentFieldName });
        const executed = [];

        if (executeSafeAttachments) {
          if (!plan.target.tableName || !plan.target.recordId || !plan.target.attachmentFieldName) throw new Error("Cannot execute safe attachments without target table, target record, and attachment field.");
          const safeByName = new Set(plan.fileDecisions.filter((decision) => decision.action === "auto_attach_if_url_available").map((decision) => decision.filename.toLowerCase()));
          for (const file of candidateFiles || []) {
            if (!file.fileUrl || !safeByName.has(sanitizeFilename(file.filename).toLowerCase())) continue;
            executed.push(await appendOrSkipAttachment(base, {
              tableName: plan.target.tableName,
              recordId: plan.target.recordId,
              attachmentFieldName: plan.target.attachmentFieldName,
              fileUrl: file.fileUrl,
              filename: file.filename,
              skipDuplicates
            }));
          }

          const now = new Date().toISOString();
          const attachedNames = executed.filter((item) => item.verified && !item.skippedDuplicate).map((item) => item.filename);
          const skippedNames = executed.filter((item) => item.skippedDuplicate).map((item) => item.filename);
          const heldNames = plan.heldFiles.map((item) => item.filename);
          await updateOptionalFields(base, intakeTableName, intakeRecordId, {
            "Upload Status": attachedNames.length || skippedNames.length ? "Uploaded" : undefined,
            "Approval State": attachedNames.length || skippedNames.length ? "Approved" : undefined,
            "Last Checked": now.slice(0, 10),
            "Upload Error / Notes": `Mixed packet split ${now}: attached [${attachedNames.join(", ") || "none"}]; skipped duplicates [${skippedNames.join(", ") || "none"}]; held [${heldNames.join(", ") || "none"}]. No claim/payment/legal conclusions changed.`,
            "Next Action": heldNames.length
              ? `Safe files handled. Hold or skip duplicate-risk files only: ${heldNames.join(", ")}.`
              : "Safe files handled. No remaining mixed-packet file review needed."
          });
        }

        return jsonContent({ success: true, action_attempted: "prepare_mixed_packet_attachment_plan", ...plan, executed });
      } catch (error) {
        return jsonContent({
          success: false,
          action_attempted: "prepare_mixed_packet_attachment_plan",
          message: error?.message || String(error),
          raw_error: error?.message || String(error),
          safe_fallback: "Prepare a manual file-level split: attach only safe distinct files with verified target record and hold duplicate-risk or consequence-sensitive files."
        });
      }
    }
  );
}

const originalConnect = McpServer.prototype.connect;
McpServer.prototype.connect = async function connectWithEvidencePolicyTools(...args) {
  if (!this.__evidencePolicyToolsRegistered) {
    registerEvidencePolicyTools(this);
    this.__evidencePolicyToolsRegistered = true;
  }
  return originalConnect.apply(this, args);
};