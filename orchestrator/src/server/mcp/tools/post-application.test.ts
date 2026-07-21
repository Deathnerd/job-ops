import type { Server } from "node:http";
import { startServer, stopServer } from "@server/api/routes/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

const POST_APPLICATION_TOOL_NAMES = [
  "jobops_postapp_providers",
  "jobops_postapp_sync",
  "jobops_postapp_review",
  "jobops_workday_import",
];

async function readMcpJsonRpc(res: Response): Promise<any> {
  // Stateless mode defaults to SSE streaming for the response; pull the
  // JSON-RPC payload out of the "data: " line(s) of the event stream, same
  // pattern as jobs.test.ts / mount.test.ts.
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

describe.sequential("post-application/workday domain MCP tools", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;
  let apiKey: string;

  afterEach(async () => {
    vi.unstubAllGlobals();
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
        GMAIL_OAUTH_CLIENT_ID: "test-gmail-client-id",
        GMAIL_OAUTH_CLIENT_SECRET: "test-gmail-client-secret",
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
    const key = await createApiKey({
      userId,
      name: "post-application-mcp-test",
    });
    apiKey = key.plaintextKey;

    return { jwt };
  }

  async function seedManualJob() {
    const res = await fetch(`${baseUrl}/api/manual-jobs/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        skipTailoring: true,
        job: {
          title: "Backend Engineer",
          employer: "Acme Corp",
          jobUrl: "https://example.com/jobs/backend-engineer",
          jobDescription: "Build things.",
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    return body.data as { id: string };
  }

  // No route creates a post-application message directly (ingestion only
  // happens through the excluded, fully-synchronous "sync" action -- see
  // post-application.ts's file header) -- seed one straight through the
  // repository layer instead, same "seed via direct import" pattern
  // jobs.test.ts uses for API keys.
  async function seedPendingMessage(jobId: string) {
    const { upsertPostApplicationMessage } = await import(
      "@server/repositories/post-application-messages"
    );
    const { message } = await upsertPostApplicationMessage({
      provider: "gmail",
      accountKey: "default",
      integrationId: null,
      syncRunId: null,
      externalMessageId: `test-message-${jobId}`,
      fromAddress: "recruiter@acme.example",
      subject: "Interview invite",
      receivedAt: Date.now(),
      snippet: "We'd like to schedule an interview.",
      relevanceDecision: "relevant",
      messageType: "interview",
      processingStatus: "pending_user",
      matchedJobId: jobId,
    });
    return message;
  }

  it("lists every post-application/workday tool via tools/list", async () => {
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
    for (const expectedName of POST_APPLICATION_TOOL_NAMES) {
      expect(names).toContain(expectedName);
    }
  });

  it("marks jobops_postapp_providers destructive, jobops_postapp_sync/jobops_workday_import readOnly, and jobops_postapp_review neither in tools/list annotations", async () => {
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

    const providers = tools.find((t) => t.name === "jobops_postapp_providers");
    expect(providers?.annotations?.destructiveHint).toBe(true);
    expect(providers?.annotations?.readOnlyHint).toBe(false);

    for (const name of ["jobops_postapp_sync", "jobops_workday_import"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    }

    const review = tools.find((t) => t.name === "jobops_postapp_review");
    expect(review?.annotations?.readOnlyHint).toBe(false);
    expect(review?.annotations?.destructiveHint).toBe(false);
  });

  it("calls jobops_postapp_providers status end-to-end for a disconnected account", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "jobops_postapp_providers", arguments: {} },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as {
      status: { connected: boolean; integration: unknown };
    };
    expect(data.status.connected).toBe(false);
    expect(data.status.integration).toBeNull();
  });

  it("jobops_postapp_providers oauth_start returns a relayable Google authorization URL", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "jobops_postapp_providers",
        arguments: { action: "oauth_start" },
      },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as {
      authorizationUrl: string;
      state: string;
    };
    expect(data.authorizationUrl).toContain(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(typeof data.state).toBe("string");
    expect(data.state.length).toBeGreaterThan(0);
  });

  it("round-trips jobops_postapp_providers oauth_exchange without ever leaking the tokens Google returns", async () => {
    await boot();

    const startResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: {
        name: "jobops_postapp_providers",
        arguments: { action: "oauth_start" },
      },
    });
    expect(startResponse.result.isError).toBeFalsy();
    const { state } = toolCallResultData(startResponse) as { state: string };

    // The exchange route makes two real outbound calls to Google
    // (token exchange, then a profile lookup using the returned access
    // token) before ever touching our own selfCall loopback -- pass
    // loopback (http://) traffic straight through to the real network and
    // intercept only those two https:// Google endpoints, same technique
    // the fetch_logo test uses for the Workday upstream call.
    const secretRefreshToken = "1//mcp-test-oauth-exchange-refresh-do-not-leak";
    const secretAccessToken = "ya29.mcp-test-oauth-exchange-access-do-not-leak";
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("http://")) {
        return nativeFetch(input, init);
      }
      if (url === "https://oauth2.googleapis.com/token") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: secretRefreshToken,
              access_token: secretAccessToken,
              expires_in: 3600,
              scope: "https://www.googleapis.com/auth/gmail.readonly",
              token_type: "Bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url === "https://www.googleapis.com/oauth2/v2/userinfo") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ email: "me@example.com", name: "Test User" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected external fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const exchangeResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: {
        name: "jobops_postapp_providers",
        arguments: { action: "oauth_exchange", state, code: "fake-auth-code" },
      },
    });

    expect(exchangeResponse.result.isError).toBeFalsy();
    const fullResponseJson = JSON.stringify(exchangeResponse);
    expect(fullResponseJson).not.toContain(secretRefreshToken);
    expect(fullResponseJson).not.toContain(secretAccessToken);
    const exchangeData = toolCallResultData(exchangeResponse) as {
      status: {
        connected: boolean;
        integration: { credentials: { hasRefreshToken: boolean } };
      };
    };
    expect(exchangeData.status.connected).toBe(true);
    expect(exchangeData.status.integration.credentials.hasRefreshToken).toBe(
      true,
    );
  });

  it("round-trips jobops_postapp_providers connect+status without ever leaking the refresh token", async () => {
    await boot();

    const secretRefreshToken = "1//mcp-test-refresh-token-do-not-leak-abcdef";

    const connectResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "jobops_postapp_providers",
        arguments: {
          action: "connect",
          payload: {
            refreshToken: secretRefreshToken,
            email: "me@example.com",
          },
        },
      },
    });
    expect(connectResponse.result.isError).toBeFalsy();
    expect(JSON.stringify(connectResponse)).not.toContain(secretRefreshToken);
    const connectData = toolCallResultData(connectResponse) as {
      status: { connected: boolean };
    };
    expect(connectData.status.connected).toBe(true);

    const statusResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "jobops_postapp_providers", arguments: {} },
    });
    expect(statusResponse.result.isError).toBeFalsy();
    expect(JSON.stringify(statusResponse)).not.toContain(secretRefreshToken);
    const statusData = toolCallResultData(statusResponse) as {
      status: {
        connected: boolean;
        integration: { credentials: { hasRefreshToken: boolean } };
      };
    };
    expect(statusData.status.connected).toBe(true);
    expect(statusData.status.integration.credentials.hasRefreshToken).toBe(
      true,
    );
  });

  it("calls jobops_postapp_sync runs end-to-end and gets an empty list back", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "jobops_postapp_sync", arguments: {} },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as { runs: unknown[] };
    expect(Array.isArray(data.runs)).toBe(true);
    expect(data.runs).toHaveLength(0);
  });

  it("calls jobops_postapp_review list end-to-end and gets an empty inbox array back", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "jobops_postapp_review",
        arguments: { action: "list" },
      },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as { items: unknown[] };
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items).toHaveLength(0);
  });

  it("round-trips jobops_postapp_review: approves a seeded pending message and links the job", async () => {
    await boot();
    const job = await seedManualJob();
    const seededMessage = await seedPendingMessage(job.id);

    const listResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "jobops_postapp_review",
        arguments: { action: "list" },
      },
    });
    expect(listResponse.result.isError).toBeFalsy();
    const listData = toolCallResultData(listResponse) as {
      items: Array<{ message: { id: string } }>;
    };
    expect(
      listData.items.some((item) => item.message.id === seededMessage.id),
    ).toBe(true);

    const approveResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "jobops_postapp_review",
        arguments: { action: "approve", messageId: seededMessage.id },
      },
    });
    expect(approveResponse.result.isError).toBeFalsy();
    const approveData = toolCallResultData(approveResponse) as {
      message: { processingStatus: string; matchedJobId: string };
    };
    expect(approveData.message.processingStatus).toBe("manual_linked");
    expect(approveData.message.matchedJobId).toBe(job.id);

    const listAfterResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "jobops_postapp_review",
        arguments: { action: "list" },
      },
    });
    expect(listAfterResponse.result.isError).toBeFalsy();
    const listAfterData = toolCallResultData(listAfterResponse) as {
      items: unknown[];
    };
    expect(listAfterData.items).toHaveLength(0);
  });

  it("jobops_postapp_review approve requires messageId", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "jobops_postapp_review",
        arguments: { action: "approve" },
      },
    });

    expect(rpcResponse.result.isError).toBe(true);
    expect(rpcResponse.result.content[0].text).toContain(
      '"messageId" is required for action "approve"',
    );
  });

  it("calls jobops_workday_import fetch_logo end-to-end through the mocked upstream", async () => {
    await boot();

    // Pass loopback traffic (the outer /mcp call, and selfCall's own
    // internal request back into this same server) straight through to the
    // real fetch; intercept only the outbound https:// request the route
    // makes to the Workday logo URL, same technique
    // orchestrator/src/server/api/routes/workday.test.ts uses for the
    // route-level equivalent of this test.
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("http://")) {
        return nativeFetch(input, init);
      }
      return Promise.resolve(
        new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "4",
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "jobops_workday_import",
        arguments: {
          action: "fetch_logo",
          careersUrl: "https://autodesk.wd1.myworkdayjobs.com/Ext",
        },
      },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as {
      mimeType: string;
      imageDataUrl: string;
    };
    expect(data.mimeType).toBe("image/png");
    expect(data.imageDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
