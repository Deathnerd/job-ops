/**
 * Gated `/mcp` mount: Streamable HTTP transport (stateless mode), one
 * McpServer + transport per request, authenticated the same way as the rest
 * of the API (JWT first, API-key bearer fallback).
 *
 * Disabled unless JOBOPS_MCP_ENABLED === "true". When disabled, no routes are
 * registered at all, so POST/GET/DELETE /mcp all 404 via Express's default
 * handler.
 */

import { logger } from "@infra/logger";
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

/**
 * Resolves the bearer context from headers only (no body access needed) and
 * either stashes it on `res.locals` for the downstream handler or 401s
 * immediately. Runs BEFORE the JSON body parser so unauthenticated callers
 * never pay for body parsing.
 */
async function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const ctx = await resolveBearerContext(req);
  if (!ctx) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }
  res.locals.mcpBearerContext = ctx;
  next();
}

export function mountMcp(app: express.Express): void {
  if (process.env.JOBOPS_MCP_ENABLED !== "true") return;

  app.post(
    "/mcp",
    authMiddleware,
    express.json({ limit: "4mb" }),
    async (req, res) => {
      try {
        // The SDK transport rejects any Accept header that does not list BOTH
        // application/json and text/event-stream literally -- including "*/*",
        // which by HTTP semantics accepts everything. Real clients send laxer
        // headers (Cloudflare MCP portal sync sends its own Accept; health
        // probes send one type), so widen any COMPATIBLE Accept to the exact
        // pair the SDK wants. Explicitly incompatible Accepts still 406.
        const accept = req.headers.accept;
        const acceptsAny = !accept || accept.includes("*/*");
        if (
          acceptsAny ||
          accept.includes("application/json") ||
          accept.includes("text/event-stream")
        ) {
          const widened = "application/json, text/event-stream";
          req.headers.accept = widened;
          // The SDK's Node transport rebuilds a web-standard Request from
          // rawHeaders (via @hono/node-server), so the parsed headers object
          // alone is ignored -- rawHeaders must be rewritten too.
          let replaced = false;
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            if (req.rawHeaders[i].toLowerCase() === "accept") {
              req.rawHeaders[i + 1] = widened;
              replaced = true;
            }
          }
          if (!replaced) req.rawHeaders.push("Accept", widened);
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
          void transport.close().catch(() => {});
          void server.close().catch(() => {});
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error("MCP request handler failed", { error });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          });
        }
      }
    },
  );

  app.get("/mcp", (_req, res) => res.status(405).end());
  app.delete("/mcp", (_req, res) => res.status(405).end());
}
