/**
 * Tool registration for the JobOps MCP server.
 *
 * This is a stub for Task 5 (the gated `/mcp` mount). Task 6 replaces
 * `registerAllTools` with the actual tool set, using `ToolContext` to scope
 * every tool call to the caller's bearer key and base URL.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ToolContext = {
  bearerKey: string;
  baseUrl: string;
};

export function registerAllTools(_server: McpServer, _ctx: ToolContext): void {}
