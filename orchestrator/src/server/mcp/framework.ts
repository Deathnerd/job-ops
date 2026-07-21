/**
 * Tool registration and self-call dispatch for the JobOps MCP server.
 *
 * Domain tool files (Tasks 7+) each export a `ToolDef[]`; `getAllToolDefs`
 * concatenates them and `registerAllTools` wires each one into the MCP SDK's
 * `registerTool`. Every tool's `handler` reaches the app the same way an
 * external HTTP client would: `selfCall` issues an authenticated loopback
 * request to this same process's `/api/*` surface and unwraps the
 * `{ ok, data/error, meta.requestId }` envelope (see AGENTS.md) into a plain
 * value, or throws an `Error` carrying the code/message/requestId.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { designResumeTools } from "./tools/design-resume";
import { ghostwriterTools } from "./tools/ghostwriter";
import { jobsTools } from "./tools/jobs";
import { pipelineTools } from "./tools/pipeline";
import { profileSettingsTools } from "./tools/profile-settings";
import { watchlistTools } from "./tools/watchlist";

/**
 * `McpServer#registerTool` is generic over `InputArgs extends undefined |
 * ZodRawShapeCompat | AnySchema` (see the SDK's `server/mcp.d.ts`), inferred
 * from the `inputSchema` we pass in. When that value is typed as the general
 * `z.ZodRawShape` (as every `ToolDef.inputSchema` is here) rather than an
 * inline object literal with concrete keys, TypeScript 7's native compiler
 * recurses through the SDK's dual v3/v4 zod-compat conditional types trying
 * to resolve `ShapeOutput<InputArgs>` and hits TS2589 ("Type instantiation is
 * excessively deep and possibly infinite").
 *
 * We only ever call `registerTool` with this exact shape, so narrow the
 * method to a concrete, non-generic function type at the call boundary --
 * this skips the problematic inference entirely without touching `ToolDef`'s
 * own (unrelated) public typing.
 */
type RegisterToolCallback = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

type RegisterToolFn = (
  name: string,
  config: {
    description: string;
    inputSchema: z.ZodRawShape;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  },
  cb: RegisterToolCallback,
) => unknown;

export type ToolContext = {
  bearerKey: string;
  baseUrl: string;
};

export type ToolDef = {
  /** jobops_<domain>_<verb> */
  name: string;
  description: string;
  /** zod shape, NOT z.object() -- the SDK wraps it into an object schema */
  inputSchema: z.ZodRawShape;
  /** e.g. ["GET /api/jobs", "POST /api/jobs/:id/status"] */
  coverage: string[];
  /** default false */
  readOnly?: boolean;
  /** default false */
  destructive?: boolean;
  handler: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<unknown>;
};

type SelfCallEnvelope = {
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
  meta?: { requestId?: string };
};

const SELF_CALL_TIMEOUT_MS = 60_000;

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Issues an authenticated loopback HTTP request to this same process and
 * resolves the envelope's `data`. Throws on `ok !== true`, a non-2xx status,
 * a non-JSON response body, or a 60s timeout.
 */
export async function selfCall(
  ctx: ToolContext,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${ctx.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ctx.bearerKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(SELF_CALL_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(`timeout: request exceeded 60s (path=${path})`);
    }
    throw error;
  }

  const json = (await res.json().catch(() => null)) as SelfCallEnvelope | null;
  if (!json || json.ok !== true) {
    const code = json?.error?.code ?? `http_${res.status}`;
    const message = json?.error?.message ?? res.statusText;
    const requestId = json?.meta?.requestId ?? "unknown";
    throw new Error(`${code}: ${message} (requestId=${requestId})`);
  }
  return json.data;
}

/**
 * Aggregates every domain's `ToolDef[]`. Starts empty -- Tasks 7+ each add an
 * import and a spread here.
 */
export function getAllToolDefs(): ToolDef[] {
  return [
    ...jobsTools,
    ...pipelineTools,
    ...ghostwriterTools,
    ...designResumeTools,
    ...profileSettingsTools,
    ...watchlistTools,
  ];
}

/**
 * Registers every tool def against the given MCP server. `defs` defaults to
 * `getAllToolDefs()`; it's an explicit param (rather than always calling
 * `getAllToolDefs()` internally) so tests can inject a fake `ToolDef[]`
 * without needing real domain tool files to exist yet.
 */
export function registerAllTools(
  server: McpServer,
  ctx: ToolContext,
  defs: ToolDef[] = getAllToolDefs(),
): void {
  // See the `RegisterToolFn` comment above: this cast sidesteps a TS2589
  // ("excessively deep") failure from the SDK's generic `registerTool`.
  const registerTool = server.registerTool.bind(
    server,
  ) as unknown as RegisterToolFn;

  for (const def of defs) {
    registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: {
          readOnlyHint: def.readOnly === true,
          destructiveHint: def.destructive === true,
        },
      },
      async (args) => {
        try {
          const data = await def.handler(args, ctx);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(data ?? null, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );
  }
}
