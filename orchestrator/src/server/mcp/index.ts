/**
 * Gated `/mcp` mount: Streamable HTTP transport (stateless mode), one
 * McpServer + transport per request, authenticated the same way as the rest
 * of the API (JWT first, API-key bearer fallback).
 *
 * Disabled unless JOBOPS_MCP_ENABLED === "true". When disabled, no routes are
 * registered at all, so POST/GET/DELETE /mcp all 404 via Express's default
 * handler.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolveBearerContext } from "@server/auth/bearer-context";
import express from "express";
import { registerAllTools } from "./framework";

const BEARER_PREFIX = "Bearer ";

function extractBearerKey(req: express.Request): string {
  const authHeader = req.headers.authorization ?? "";
  return authHeader.startsWith(BEARER_PREFIX)
    ? authHeader.slice(BEARER_PREFIX.length).trim()
    : "";
}

export function mountMcp(app: express.Express): void {
  if (process.env.JOBOPS_MCP_ENABLED !== "true") return;

  app.post("/mcp", express.json({ limit: "4mb" }), async (req, res) => {
    const ctx = await resolveBearerContext(req);
    if (!ctx) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }

    const server = new McpServer({ name: "jobops", version: "1.0.0" });
    registerAllTools(server, {
      bearerKey: extractBearerKey(req),
      baseUrl: `http://localhost:${process.env.PORT || 3001}`,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (_req, res) => res.status(405).end());
  app.delete("/mcp", (_req, res) => res.status(405).end());
}
