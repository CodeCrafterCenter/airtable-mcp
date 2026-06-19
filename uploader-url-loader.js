import crypto from "crypto";
import express from "express";
import Airtable from "airtable";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || "";
const MAX_PDF_UPLOAD_BYTES = Number(process.env.MAX_PDF_UPLOAD_BYTES || 15 * 1024 * 1024);
const UPLOADED_FILE_TTL_MS = Number(process.env.UPLOADED_FILE_TTL_MS || 20 * 60 * 1000);
const ATTACHMENT_INTAKE_TABLE_NAME = process.env.ATTACHMENT_INTAKE_TABLE_NAME || "Attachment Intake Queue";

const uploadedUrlFiles = new Map();
const airtable = AIRTABLE_API_KEY && AIRTABLE_BASE_ID ? new Airtable({ apiKey: AIRTABLE_API_KEY }) : null;
const base = airtable ? airtable.base(AIRTABLE_BASE_ID) : null;

function jsonContent(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function sanitizeFilename(filename = "upload.pdf") {
  const cleaned = String(filename).replace(/[\\/]/g, "_").replaceAll(String.fromCharCode(0), "_").replace(/[\r\n]/g, "_").trim();
  return cleaned || "upload.pdf";
}

function getPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL.startsWith("http") ? PUBLIC_BASE_URL.replace(/\/$/, "") : `https://${PUBLIC_BASE_URL.replace(/\/$/, "")}`;
  }
  const proto = req?.get?.("x-forwarded-proto") || req?.protocol || "https";
  return `${proto}://${req?.get?.("host")}`;
}

function cleanupUploadedUrlFiles() {
  const now = Date.now();
  for (const [id, file] of uploadedUrlFiles.entries()) {
    if (file.expiresAt <= now) uploadedUrlFiles.delete(id);
  }
}

function attachmentFilename(attachment) {
  return String(attachment?.filename || attachment?.name || "").trim();
}

function hasAttachmentFilename(attachments, filename) {
  const wanted = sanitizeFilename(filename).toLowerCase();
  return attachments.some((attachment) => attachmentFilename(attachment).toLowerCase() === wanted);
}

function stagePdfBuffer({ buffer, filename, sourceUrl }) {
  cleanupUploadedUrlFiles();
  if (!buffer.length) throw new Error("Fetched PDF is empty");
  if (buffer.length > MAX_PDF_UPLOAD_BYTES) throw new Error(`Fetched PDF exceeds limit of ${MAX_PDF_UPLOAD_BYTES} bytes`);
  if (buffer.subarray(0, 4).toString("utf8") !== "%PDF") throw new Error("Fetched file does not look like a PDF");
  const fileId = crypto.randomUUID();
  const safeFilename = sanitizeFilename(filename);
  uploadedUrlFiles.set(fileId, {
    buffer,
    filename: safeFilename,
    sourceUrl,
    contentType: "application/pdf",
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + UPLOADED_FILE_TTL_MS
  });
  return { fileId, filename: safeFilename };
}

async function fetchPdfBuffer(sourceUrl) {
  const response = await fetch(sourceUrl, {
    redirect: "follow",
    headers: { Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1" }
  });
  if (!response.ok) {
    throw new Error(`Source PDF fetch failed: ${response.status} ${await response.text()}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function updateOptionalFields(tableName, recordId, candidateFields) {
  const entries = Object.entries(candidateFields).filter(([, value]) => value !== undefined && value !== null);
  if (!entries.length) return null;
  const record = await base(tableName).find(recordId);
  const fields = {};
  for (const [fieldName, value] of entries) {
    if (Object.prototype.hasOwnProperty.call(record.fields, fieldName) || fieldName === "Upload Status" || fieldName === "Upload Verified At" || fieldName === "Uploader Run ID" || fieldName === "Upload Error / Notes" || fieldName === "Last Checked" || fieldName === "Uploader Provider") {
      fields[fieldName] = value;
    }
  }
  if (!Object.keys(fields).length) return null;
  return base(tableName).update([{ id: recordId, fields }]);
}

async function appendOrSkipAttachment({ tableName, recordId, attachmentFieldName, fileUrl, filename, skipDuplicates = true }) {
  const record = await base(tableName).find(recordId);
  const existing = Array.isArray(record.fields[attachmentFieldName]) ? record.fields[attachmentFieldName] : [];
  if (skipDuplicates && hasAttachmentFilename(existing, filename)) {
    return { skippedDuplicate: true };
  }
  const newAttachment = { url: fileUrl, filename: sanitizeFilename(filename) };
  await base(tableName).update([{ id: recordId, fields: { [attachmentFieldName]: [...existing, newAttachment] } }]);
  return { skippedDuplicate: false };
}

async function uploadPdfUrlToRecord({ tableName, recordId, attachmentFieldName, filename, sourceUrl, skipDuplicates = true, intakeRecordId, intakeTableName = ATTACHMENT_INTAKE_TABLE_NAME, req }) {
  if (!base) throw new Error("Missing Airtable configuration");
  if (!tableName) throw new Error("Missing tableName");
  if (!recordId) throw new Error("Missing recordId");
  if (!attachmentFieldName) throw new Error("Missing attachmentFieldName");
  if (!filename) throw new Error("Missing filename");
  if (!sourceUrl) throw new Error("Missing sourceUrl");

  const buffer = await fetchPdfBuffer(sourceUrl);
  const staged = stagePdfBuffer({ buffer, filename, sourceUrl });
  const fileUrl = `${getPublicBaseUrl(req)}/uploaded-url-files/${staged.fileId}/${encodeURIComponent(staged.filename)}`;
  const result = await appendOrSkipAttachment({ tableName, recordId, attachmentFieldName, fileUrl, filename, skipDuplicates });
  const targetRecord = await base(tableName).find(recordId);
  const attachments = Array.isArray(targetRecord.fields[attachmentFieldName]) ? targetRecord.fields[attachmentFieldName] : [];
  const verified = hasAttachmentFilename(attachments, filename);
  const now = new Date().toISOString();
  const uploadStatus = result.skippedDuplicate ? "Skipped duplicate" : verified ? "Uploaded" : "Failed";
  const note = result.skippedDuplicate
    ? `Skipped duplicate filename ${sanitizeFilename(filename)} on ${now}.`
    : verified
      ? `Uploaded from source URL and verified ${sanitizeFilename(filename)} on ${now}.`
      : `Upload attempted from source URL for ${sanitizeFilename(filename)} on ${now}, but readback did not verify the filename.`;

  if (intakeRecordId) {
    await updateOptionalFields(intakeTableName, intakeRecordId, {
      "Upload Status": uploadStatus,
      "Upload Verified At": verified ? now : undefined,
      "Uploader Run ID": staged.fileId,
      "Upload Error / Notes": note,
      "Last Checked": now.slice(0, 10),
      "Uploader Provider": "Custom Backend"
    });
  }

  return {
    success: verified || result.skippedDuplicate,
    action_attempted: "upload_pdf_url_to_record",
    tableName,
    recordId,
    attachmentFieldName,
    filename: sanitizeFilename(filename),
    sourceUrl,
    fileUrl,
    stagedFileId: staged.fileId,
    skippedDuplicate: result.skippedDuplicate,
    verified,
    uploadStatus,
    intakeRecordId: intakeRecordId ?? null,
    note
  };
}

const originalListen = express.application.listen;
express.application.listen = function listenWithUploadedUrlFiles(...args) {
  if (!this.__uploadedUrlFilesRouteInstalled) {
    this.__uploadedUrlFilesRouteInstalled = true;
    this.get("/uploaded-url-files/:fileId/:filename?", (req, res) => {
      cleanupUploadedUrlFiles();
      const file = uploadedUrlFiles.get(req.params.fileId);
      if (!file) {
        res.status(404).json({ success: false, action_attempted: "download_uploaded_url_file", message: "File not found or expired" });
        return;
      }
      res.setHeader("Content-Type", file.contentType);
      res.setHeader("Content-Length", file.buffer.length);
      res.setHeader("Content-Disposition", `inline; filename="${file.filename.replace(/"/g, "'")}"`);
      res.send(file.buffer);
    });
  }
  return originalListen.apply(this, args);
};

const previousTool = McpServer.prototype.tool;
const injectedServers = new WeakSet();

McpServer.prototype.tool = function toolWithUrlUploader(name, ...rest) {
  if (!injectedServers.has(this)) {
    injectedServers.add(this);
    previousTool.call(
      this,
      "upload_pdf_url_to_record",
      "Fetch a PDF from a source URL, stage it through backend temporary hosting, append it to an Airtable attachment field, and verify readback",
      {
        tableName: z.string(),
        recordId: z.string(),
        attachmentFieldName: z.string(),
        filename: z.string(),
        sourceUrl: z.string().url(),
        skipDuplicates: z.boolean().optional(),
        intakeRecordId: z.string().optional(),
        intakeTableName: z.string().optional()
      },
      async (args) => {
        try {
          const payload = await uploadPdfUrlToRecord({ ...args, req: { get: () => null, protocol: "https" } });
          return jsonContent(payload);
        } catch (error) {
          return jsonContent({
            success: false,
            action_attempted: "upload_pdf_url_to_record",
            message: error?.message || String(error),
            raw_error: error?.message || String(error),
            safe_fallback: "Verify the source URL is reachable as a PDF and retry; no upload should be considered complete without target-record readback."
          });
        }
      }
    );
  }

  return previousTool.call(this, name, ...rest);
};
