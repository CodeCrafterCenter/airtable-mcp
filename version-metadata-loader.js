import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DISPLAY_VERSION = process.env.AIRTABLE_MCP_DISPLAY_VERSION || "6.4.5";
const originalJson = express.response.json;

function patchVersionPayload(payload) {
  if (payload && typeof payload === "object" && payload.version === "6.3.0") {
    return { ...payload, version: DISPLAY_VERSION };
  }
  return payload;
}

express.response.json = function jsonWithCurrentVersion(payload) {
  return originalJson.call(this, patchVersionPayload(payload));
};

const originalTool = McpServer.prototype.tool;
McpServer.prototype.tool = function toolWithCurrentCapabilitiesVersion(name, ...rest) {
  const callback = rest.at(-1);
  if (name !== "get_capabilities" || typeof callback !== "function") {
    return originalTool.call(this, name, ...rest);
  }

  const wrapped = async (...args) => {
    const result = await callback(...args);
    const textItem = result?.content?.find((item) => item?.type === "text" && typeof item.text === "string");
    if (!textItem) return result;

    try {
      const parsed = JSON.parse(textItem.text);
      const patched = patchVersionPayload(parsed);
      return {
        ...result,
        content: result.content.map((item) => (item === textItem ? { ...item, text: JSON.stringify(patched, null, 2) } : item)),
        structuredContent: result.structuredContent ? patchVersionPayload(result.structuredContent) : patched
      };
    } catch {
      return result;
    }
  };

  return originalTool.call(this, name, ...rest.slice(0, -1), wrapped);
};
