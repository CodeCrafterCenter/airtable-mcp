import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const originalTool = McpServer.prototype.tool;
const originalRegisterTool = McpServer.prototype.registerTool;

const READ_ONLY_TOOLS = new Set([
  "get_capabilities",
  "list_tables",
  "get_table_schema",
  "list_records",
  "get_record",
  "resolve_record",
  "search_records",
  "find_records_across_tables",
  "list_record_comments"
]);

function annotationsForTool(name) {
  if (READ_ONLY_TOOLS.has(name)) {
    return {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    };
  }

  return {
    readOnlyHint: false,
    destructiveHint: name.includes("delete") || name === "attach_file_to_record",
    idempotentHint: name.includes("update") || name.includes("upsert"),
    openWorldHint: true
  };
}

function outputSchemaForTool() {
  return z.object({
    success: z.boolean().optional(),
    action_attempted: z.string().optional(),
    data: z.any().optional(),
    mode: z.string().optional(),
    formula: z.string().optional(),
    capabilities: z.record(z.any()).optional(),
    version: z.string().optional(),
    message: z.string().optional(),
    statusCode: z.number().nullable().optional(),
    auth_issue: z.boolean().optional(),
    missing_capability: z.boolean().optional(),
    validation_issue: z.boolean().optional(),
    recoverable: z.boolean().optional(),
    safe_fallback: z.string().optional(),
    raw_error: z.string().optional()
  }).passthrough();
}

function withStructuredContent(handler) {
  return async (...args) => {
    const result = await handler(...args);
    if (result?.structuredContent !== undefined) {
      return result;
    }

    const text = result?.content?.find((item) => item?.type === "text")?.text;
    if (typeof text !== "string") {
      return result;
    }

    try {
      return { ...result, structuredContent: JSON.parse(text) };
    } catch {
      return result;
    }
  };
}

McpServer.prototype.tool = function annotatedTool(name, ...rest) {
  const callback = rest.at(-1);
  if (typeof callback !== "function") {
    return originalTool.call(this, name, ...rest);
  }

  if (rest.length === 3 && typeof rest[0] === "string") {
    return originalRegisterTool.call(this, name, {
      description: rest[0],
      inputSchema: rest[1],
      outputSchema: outputSchemaForTool(name),
      annotations: annotationsForTool(name)
    }, withStructuredContent(callback));
  }

  if (rest.length === 2) {
    return originalRegisterTool.call(this, name, {
      inputSchema: rest[0],
      outputSchema: outputSchemaForTool(name),
      annotations: annotationsForTool(name)
    }, withStructuredContent(callback));
  }

  return originalTool.call(this, name, ...rest);
};
