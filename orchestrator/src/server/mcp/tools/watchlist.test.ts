import type { Server } from "node:http";
import { startServer, stopServer } from "@server/api/routes/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

const WATCHLIST_TOOL_NAMES = [
  "jobops_watchlist_sources",
  "jobops_watchlist_check",
  "jobops_watchlist_jobs",
  "jobops_manual_job_create",
  "jobops_manual_job_infer",
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

describe.sequential("watchlist + manual-jobs domain MCP tools", () => {
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
    const key = await createApiKey({ userId, name: "watchlist-mcp-test" });
    apiKey = key.plaintextKey;

    return { jwt };
  }

  it("lists every watchlist tool via tools/list", async () => {
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
    for (const expectedName of WATCHLIST_TOOL_NAMES) {
      expect(names).toContain(expectedName);
    }
  });

  it("marks the sources/jobs tools destructive in tools/list annotations", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    const tools = rpcResponse.result.tools as Array<{
      name: string;
      annotations?: { destructiveHint?: boolean };
    }>;
    for (const name of ["jobops_watchlist_sources", "jobops_watchlist_jobs"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.destructiveHint).toBe(true);
    }
    const check = tools.find((t) => t.name === "jobops_watchlist_check");
    expect(check?.annotations?.destructiveHint).toBe(false);
  });

  it("calls jobops_watchlist_sources list end-to-end and gets the catalog back", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "jobops_watchlist_sources", arguments: {} },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as {
      catalogSources: Array<{ id: string; sourceType: string }>;
      selectedSources: unknown[];
    };
    expect(
      data.catalogSources.some(
        (source) =>
          source.id === "autodesk-workday" && source.sourceType === "workday",
      ),
    ).toBe(true);
    expect(data.selectedSources).toEqual([]);
  });

  it("round-trips a mutating tool call: selects a source, ignores a job, then unignores it", async () => {
    await boot();

    const selectResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "jobops_watchlist_sources",
        arguments: {
          action: "select",
          selections: [
            {
              catalogSourceId: "autodesk-workday",
              sourceType: "workday",
              careersUrl: "https://autodesk.wd1.myworkdayjobs.com/Ext",
            },
          ],
        },
      },
    });
    expect(selectResponse.result.isError).toBeFalsy();
    const selected = toolCallResultData(selectResponse) as {
      selectedSources: Array<{ catalogSourceId: string | null }>;
    };
    expect(
      selected.selectedSources.some(
        (source) => source.catalogSourceId === "autodesk-workday",
      ),
    ).toBe(true);

    const ignoreResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "jobops_watchlist_jobs",
        arguments: {
          action: "ignore",
          source: "workday:autodesk",
          sourceJobId: "R12345",
        },
      },
    });
    expect(ignoreResponse.result.isError).toBeFalsy();
    const ignored = toolCallResultData(ignoreResponse) as {
      state: { state: string };
    };
    expect(ignored.state.state).toBe("ignored");

    const listStatesResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "jobops_watchlist_jobs",
        arguments: { action: "list_states" },
      },
    });
    expect(listStatesResponse.result.isError).toBeFalsy();
    const states = toolCallResultData(listStatesResponse) as {
      states: Array<{ source: string; sourceJobId: string }>;
    };
    expect(
      states.states.some(
        (state) =>
          state.source === "workday:autodesk" && state.sourceJobId === "R12345",
      ),
    ).toBe(true);

    const unignoreResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "jobops_watchlist_jobs",
        arguments: {
          action: "unignore",
          source: "workday:autodesk",
          sourceJobId: "R12345",
        },
      },
    });
    expect(unignoreResponse.result.isError).toBeFalsy();
    expect(toolCallResultData(unignoreResponse)).toEqual({ cleared: true });
  });

  it("select rejects duplicate careersUrl selections with a descriptive isError", async () => {
    await boot();

    const response = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "jobops_watchlist_sources",
        arguments: {
          action: "select",
          selections: [
            {
              sourceType: "workday",
              careersUrl: "https://dupe.wd1.myworkdayjobs.com/Ext",
            },
            {
              sourceType: "workday",
              careersUrl: "https://dupe.wd1.myworkdayjobs.com/Ext",
            },
          ],
        },
      },
    });

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain(
      "Duplicate watchlist URLs are not allowed",
    );
  });

  it("jobops_watchlist_check trigger returns empty results when no sources are selected", async () => {
    await boot();

    const response = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "jobops_watchlist_check",
        arguments: { action: "trigger" },
      },
    });

    expect(response.result.isError).toBeFalsy();
    const data = toolCallResultData(response) as {
      checkedAt: string | null;
      sources: unknown[];
    };
    expect(data.sources).toEqual([]);
  });

  it("jobops_watchlist_check record writes explicit source+sourceJobIds", async () => {
    await boot();

    const response = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "jobops_watchlist_check",
        arguments: {
          action: "record",
          checks: [{ source: "acme", sourceJobIds: ["job-1", "job-2"] }],
        },
      },
    });

    expect(response.result.isError).toBeFalsy();
    const data = toolCallResultData(response) as {
      jobs: Array<{ source: string; sourceJobId: string }>;
    };
    expect(data.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "acme", sourceJobId: "job-1" }),
        expect.objectContaining({ source: "acme", sourceJobId: "job-2" }),
      ]),
    );
  });

  it("jobops_manual_job_create fetch_url rejects blocked LinkedIn hosts with a descriptive isError", async () => {
    await boot();

    const response = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "jobops_manual_job_create",
        arguments: {
          action: "fetch_url",
          url: "https://www.linkedin.com/jobs/view/123",
        },
      },
    });

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain(
      "Auto-fetch is not supported for LinkedIn links",
    );
  });

  it("jobops_manual_job_create create imports a job", async () => {
    await boot();

    const response = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "jobops_manual_job_create",
        arguments: {
          action: "create",
          skipTailoring: true,
          job: {
            title: "Backend Engineer",
            employer: "Acme Corp",
            jobUrl: "https://example.com/jobs/backend-engineer",
            jobDescription: "Build things.",
          },
        },
      },
    });

    expect(response.result.isError).toBeFalsy();
    const data = toolCallResultData(response) as {
      source: string;
      title: string;
    };
    expect(data.source).toBe("manual");
    expect(data.title).toBe("Backend Engineer");
  });

  it("jobops_manual_job_infer returns the mocked inferred job fields", async () => {
    await boot();

    const { inferManualJobDetails } = await import(
      "@server/services/manualJob"
    );
    vi.mocked(inferManualJobDetails).mockResolvedValue({
      job: { title: "Staff Engineer", employer: "Acme" },
      warning: null,
    });

    const response = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "jobops_manual_job_infer",
        arguments: { jobDescription: "We are hiring a staff engineer." },
      },
    });

    expect(response.result.isError).toBeFalsy();
    const data = toolCallResultData(response) as {
      job: { title: string };
      warning: string | null;
    };
    expect(data.job.title).toBe("Staff Engineer");
    expect(data.warning).toBeNull();
  });
});
