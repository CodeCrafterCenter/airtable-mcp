import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { operatorAutomationStatus, runOperatorAutomationOnce } from "./operator-automation-runner-loader.js";

function jsonContent(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function classifyError(error) {
  return {
    message: error?.message || String(error),
    name: error?.name || "Error",
    statusCode: error?.statusCode || error?.status || null
  };
}

function safeTool(server, name, description, schema, handler) {
  server.tool(name, description, schema, async (args) => {
    try {
      return await handler(args || {});
    } catch (error) {
      console.error(`[airtable-mcp] ${name} failed:`, error);
      return jsonContent({ success: false, action_attempted: name, ...classifyError(error) });
    }
  });
}

function registerOperatorAutomationTools(server) {
  safeTool(server, "get_operator_automation_status", "Return Railway-side Operator automation runner status, connector availability, and the last backend scan summary.", {}, async () => {
    return jsonContent({ success: true, action_attempted: "get_operator_automation_status", ...operatorAutomationStatus() });
  });

  safeTool(server, "run_operator_automation_once", "Run one safe Operator backend automation pass now. This is Airtable-control-plane only unless Email/Drive connector URLs are configured. It writes at most a compact AI Action Runs audit record.", {
    confirmReadOnlySourceRecords: z.boolean().optional()
  }, async ({ confirmReadOnlySourceRecords = false }) => {
    if (!confirmReadOnlySourceRecords) {
      return jsonContent({
        success: false,
        action_attempted: "run_operator_automation_once",
        message: "Set confirmReadOnlySourceRecords=true to confirm this pass may read Airtable and write only a compact AI Action Runs audit record."
      });
    }
    return jsonContent({ success: true, action_attempted: "run_operator_automation_once", result: await runOperatorAutomationOnce() });
  });
}

const originalConnect = McpServer.prototype.connect;
McpServer.prototype.connect = async function connectWithOperatorAutomationTools(...args) {
  if (!this.__operatorAutomationToolsRegistered) {
    registerOperatorAutomationTools(this);
    this.__operatorAutomationToolsRegistered = true;
  }
  return originalConnect.apply(this, args);
};
