import type { Server } from "node:http";
import { startServer, stopServer } from "@server/api/routes/test-utils";
import { afterEach, describe, expect, it } from "vitest";

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

const PIPELINE_TOOL_NAMES = [
  "jobops_pipeline_run",
  "jobops_pipeline_status",
  "jobops_pipeline_cancel",
  "jobops_pipeline_presets",
  "jobops_pipeline_search_plan",
  "jobops_pipeline_history",
];

async function readMcpJsonRpc(res: Response): Promise<any> {
  // Stateless mode defaults to SSE streaming for the response; pull the
  // JSON-RPC payload out of the "data: " line(s) of the event stream, same
  // pattern as mount.test.ts / jobs.test.ts.
  const raw = await res.text();
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  expect(dataLine).toBeTruthy();
  return JSON.parse(dataLine?.slice("data: ".length) ?? "");
}

async function callMcp(
  baseUrl: string,
  bearerKey: string,
  body: unknown,
): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: MCP_ACCEPT_HEADER,
      Authorization: `Bearer ${bearerKey}`,
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return readMcpJsonRpc(res);
}

function toolCallResultData(rpcResponse: any): unknown {
  const content = rpcResponse.result?.content;
  expect(Array.isArray(content)).toBe(true);
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0].text);
}

describe.sequential("pipeline domain MCP tools", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;
  let apiKey: string;

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function boot() {
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: {
        JOBOPS_MCP_ENABLED: "true",
        BASIC_AUTH_USER: "admin",
        BASIC_AUTH_PASSWORD: "secret",
        JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
        JOBOPS_TEST_AUTH_BYPASS: "0",
      },
    }));

    // `mount.ts` builds the selfCall baseUrl from `process.env.PORT` at
    // request time (see server/mcp/index.ts); test-utils.ts always binds to
    // an OS-assigned port (`app.listen(0, ...)`), so we point PORT at the
    // actual bound port after the fact so tool handlers' selfCall reaches
    // this same test server instead of the default :3001.
    process.env.PORT = new URL(baseUrl).port;

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });
    const loginBody = await loginRes.json();
    const jwt = loginBody.data.token as string;

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const meBody = await meRes.json();
    const userId = meBody.data.user.id as string;

    const { createApiKey } = await import("@server/repositories/api-keys");
    const key = await createApiKey({ userId, name: "pipeline-mcp-test" });
    apiKey = key.plaintextKey;

    return { jwt };
  }

  it("lists every pipeline tool via tools/list", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    const names = (rpcResponse.result.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    for (const expectedName of PIPELINE_TOOL_NAMES) {
      expect(names).toContain(expectedName);
    }
  });

  it("marks jobops_pipeline_presets destructive and status/history read-only in tools/list annotations", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    const tools = rpcResponse.result.tools as Array<{
      name: string;
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    }>;

    const presets = tools.find((t) => t.name === "jobops_pipeline_presets");
    expect(presets?.annotations?.destructiveHint).toBe(true);

    for (const name of ["jobops_pipeline_status", "jobops_pipeline_history"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    }

    // The search-plan generator never touches stored presets -- it must not
    // inherit the presets tool's destructive flag.
    const searchPlan = tools.find(
      (t) => t.name === "jobops_pipeline_search_plan",
    );
    expect(searchPlan?.annotations?.destructiveHint).toBe(false);
  });

  it("calls jobops_pipeline_status end-to-end and gets the idle status back", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "jobops_pipeline_status", arguments: {} },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as {
      isRunning: boolean;
      lastRun: unknown;
    };
    expect(data.isRunning).toBe(false);
  });

  it("calls jobops_pipeline_status with action challenges and gets the mocked pending challenges back", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "jobops_pipeline_status",
        arguments: { action: "challenges" },
      },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    // test-utils.ts mocks `getPendingChallenges` to always return [].
    const data = toolCallResultData(rpcResponse) as { challenges: unknown[] };
    expect(data.challenges).toEqual([]);
  });

  it("calls jobops_pipeline_history with action list and gets an empty array back", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "jobops_pipeline_history",
        arguments: { action: "list" },
      },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse);
    expect(Array.isArray(data)).toBe(true);
    expect(data).toEqual([]);
  });

  it("jobops_pipeline_cancel with no running pipeline returns isError with the CONFLICT message", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "jobops_pipeline_cancel", arguments: {} },
    });

    expect(rpcResponse.result.isError).toBe(true);
    expect(rpcResponse.result.content[0].text).toContain(
      "No running pipeline to cancel",
    );
  });
});
