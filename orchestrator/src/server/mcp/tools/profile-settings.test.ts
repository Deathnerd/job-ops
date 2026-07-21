import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Codex sign-in (status/start/disconnect) shells out to the real `codex`
// CLI as a subprocess -- non-deterministic and CI-unsafe to exercise for
// real. Mock at the same module boundary
// `settings.codex-auth.test.ts` (the route-level test for this exact
// surface) already uses, rather than mocking node:child_process directly.
const {
  startCodexDeviceAuthMock,
  consumeCompletedCodexDeviceAuthMock,
  disconnectCodexAuthMock,
  getCodexDeviceAuthSnapshotMock,
  resetCodexSessionMock,
  validateCredentialsMock,
} = vi.hoisted(() => ({
  startCodexDeviceAuthMock: vi.fn(),
  consumeCompletedCodexDeviceAuthMock: vi.fn(),
  disconnectCodexAuthMock: vi.fn(),
  getCodexDeviceAuthSnapshotMock: vi.fn(),
  resetCodexSessionMock: vi.fn(),
  validateCredentialsMock: vi.fn(),
}));

vi.mock("@server/services/llm/codex/client", () => ({
  resetCodexSession: resetCodexSessionMock,
}));

vi.mock("@server/services/llm/codex/login", () => ({
  startCodexDeviceAuth: startCodexDeviceAuthMock,
  consumeCompletedCodexDeviceAuth: consumeCompletedCodexDeviceAuthMock,
  disconnectCodexAuth: disconnectCodexAuthMock,
  getCodexDeviceAuthSnapshot: getCodexDeviceAuthSnapshotMock,
}));

vi.mock("@server/services/llm/service", () => ({
  LlmService: vi.fn(function MockLlmService() {
    return {
      validateCredentials: validateCredentialsMock,
      listModels: vi.fn().mockResolvedValue([]),
    };
  }),
}));

import { startServer, stopServer } from "@server/api/routes/test-utils";

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

const PROFILE_SETTINGS_TOOL_NAMES = [
  "jobops_profile_get",
  "jobops_profile_projects",
  "jobops_settings_get",
  "jobops_settings_set",
  "jobops_codex_auth",
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

describe.sequential("profile-settings domain MCP tools", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;
  let apiKey: string;

  beforeEach(() => {
    vi.clearAllMocks();
    getCodexDeviceAuthSnapshotMock.mockReturnValue({
      status: "idle",
      loginInProgress: false,
      verificationUrl: null,
      userCode: null,
      startedAt: null,
      expiresAt: null,
      message: null,
    });
    validateCredentialsMock.mockResolvedValue({
      valid: false,
      message: "Codex not authenticated",
    });
    startCodexDeviceAuthMock.mockResolvedValue(undefined);
    consumeCompletedCodexDeviceAuthMock.mockReturnValue(null);
    disconnectCodexAuthMock.mockResolvedValue(undefined);
    resetCodexSessionMock.mockResolvedValue(undefined);
  });

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
    const key = await createApiKey({
      userId,
      name: "profile-settings-mcp-test",
    });
    apiKey = key.plaintextKey;

    return { jwt };
  }

  it("lists every profile-settings tool via tools/list", async () => {
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
    for (const expectedName of PROFILE_SETTINGS_TOOL_NAMES) {
      expect(names).toContain(expectedName);
    }
  });

  it("marks the read-only tools readOnly and the mutating tools not readOnly in tools/list annotations", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    const tools = rpcResponse.result.tools as Array<{
      name: string;
      annotations?: { readOnlyHint?: boolean };
    }>;
    for (const name of ["jobops_profile_projects", "jobops_settings_get"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    }
    for (const name of [
      "jobops_profile_get",
      "jobops_settings_set",
      "jobops_codex_auth",
    ]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(false);
    }
  });

  it("marks jobops_codex_auth destructive in tools/list annotations", async () => {
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
    const tool = tools.find((t) => t.name === "jobops_codex_auth");
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });

  it("calls jobops_profile_get end-to-end and gets the (mocked, empty) profile back", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "jobops_profile_get", arguments: {} },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse);
    expect(data).toEqual({});
  });

  it("calls jobops_profile_projects end-to-end and gets an empty catalog array back", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "jobops_profile_projects", arguments: {} },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse);
    expect(Array.isArray(data)).toBe(true);
  });

  it("round-trips a settings write: sets scoringInstructions then reads it back", async () => {
    await boot();

    const setResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "jobops_settings_set",
        arguments: { scoringInstructions: "Prefer remote roles." },
      },
    });
    expect(setResponse.result.isError).toBeFalsy();
    const setData = toolCallResultData(setResponse) as {
      scoringInstructions: { value: string; override: string | null };
    };
    expect(setData.scoringInstructions.value).toBe("Prefer remote roles.");
    expect(setData.scoringInstructions.override).toBe("Prefer remote roles.");

    const getResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "jobops_settings_get", arguments: {} },
    });
    expect(getResponse.result.isError).toBeFalsy();
    const getData = toolCallResultData(getResponse) as {
      scoringInstructions: { value: string };
    };
    expect(getData.scoringInstructions.value).toBe("Prefer remote roles.");
  });

  it("never leaks a plaintext secret through jobops_settings_get after jobops_settings_set writes one", async () => {
    await boot();

    const secretValue = "sk-mcp-test-super-secret-do-not-leak-1234567890";

    const setResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "jobops_settings_set",
        arguments: { llmApiKey: secretValue },
      },
    });
    expect(setResponse.result.isError).toBeFalsy();
    // Even the response to the write itself must not echo the secret back.
    expect(JSON.stringify(setResponse)).not.toContain(secretValue);

    const getRpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "jobops_settings_get", arguments: {} },
    });
    expect(getRpcResponse.result.isError).toBeFalsy();
    expect(JSON.stringify(getRpcResponse)).not.toContain(secretValue);

    const getData = toolCallResultData(getRpcResponse) as {
      llmApiKeyHint: string | null;
    };
    // Only a short truncated hint should ever appear -- confirms redaction
    // is happening, not that the field was simply omitted by accident.
    expect(getData.llmApiKeyHint).toBe(secretValue.slice(0, 4));
  });

  it('calls jobops_codex_auth action "status" (default) without returning a token', async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "jobops_codex_auth", arguments: {} },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as {
      authenticated: boolean;
      flowStatus: string;
      username: string | null;
    };
    expect(data.authenticated).toBe(false);
    expect(data.flowStatus).toBe("idle");
    expect(data).not.toHaveProperty("token");
  });

  it('calls jobops_codex_auth action "start" and returns the device-auth flow\'s verification URL and user code', async () => {
    await boot();

    const runningSnapshot = {
      status: "running",
      loginInProgress: true,
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      startedAt: "2026-04-14T16:00:00.000Z",
      expiresAt: "2026-04-14T16:15:00.000Z",
      message: "Open the verification URL and enter the one-time code.",
    };
    startCodexDeviceAuthMock.mockResolvedValueOnce(runningSnapshot);
    getCodexDeviceAuthSnapshotMock.mockReturnValueOnce(runningSnapshot);

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "jobops_codex_auth",
        arguments: { action: "start" },
      },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as {
      flowStatus: string;
      verificationUrl: string | null;
      userCode: string | null;
    };
    expect(data.flowStatus).toBe("running");
    expect(data.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(data.userCode).toBe("ABCD-EFGH");
    expect(data).not.toHaveProperty("token");
    expect(startCodexDeviceAuthMock).toHaveBeenCalledWith(false);
  });

  it('jobops_codex_auth action "start" passes forceRestart through', async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "jobops_codex_auth",
        arguments: { action: "start", forceRestart: true },
      },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    expect(startCodexDeviceAuthMock).toHaveBeenCalledWith(true);
  });

  it('jobops_codex_auth action "start" surfaces a descriptive error when the login flow fails', async () => {
    await boot();

    startCodexDeviceAuthMock.mockRejectedValueOnce(
      new Error("Codex CLI is not installed in this runtime."),
    );

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "jobops_codex_auth",
        arguments: { action: "start" },
      },
    });

    expect(rpcResponse.result.isError).toBe(true);
    expect(rpcResponse.result.content[0].text).toContain(
      "Codex CLI is not installed in this runtime.",
    );
  });

  it('calls jobops_codex_auth action "disconnect" and revokes codex credentials', async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "jobops_codex_auth",
        arguments: { action: "disconnect" },
      },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as { authenticated: boolean };
    expect(data.authenticated).toBe(false);
    expect(data).not.toHaveProperty("token");
    expect(disconnectCodexAuthMock).toHaveBeenCalledOnce();
    expect(resetCodexSessionMock).toHaveBeenCalledOnce();
  });

  it("jobops_settings_get rx_resume_projects requires resumeId", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "jobops_settings_get",
        arguments: { action: "rx_resume_projects" },
      },
    });

    expect(rpcResponse.result.isError).toBe(true);
    expect(rpcResponse.result.content[0].text).toContain(
      '"resumeId" is required for action "rx_resume_projects"',
    );
  });
});
