import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const originalTool = McpServer.prototype.tool;

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

McpServer.prototype.tool = function annotatedTool(name, ...rest) {
  const callback = rest.at(-1);
  if (typeof callback !== "function") {
    return originalTool.call(this, name, ...rest);
  }

  if (rest.length === 3 && typeof rest[0] === "string") {
    return originalTool.call(this, name, rest[0], rest[1], annotationsForTool(name), callback);
  }

  if (rest.length === 2) {
    return originalTool.call(this, name, rest[0], annotationsForTool(name), callback);
  }

  return originalTool.call(this, name, ...rest);
};
