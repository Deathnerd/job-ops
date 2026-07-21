import type { Server } from "node:http";
import { startServer, stopServer } from "@server/api/routes/test-utils";
import { afterEach, describe, expect, it } from "vitest";

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

const PROFILE_SETTINGS_TOOL_NAMES = [
  "jobops_profile_get",
  "jobops_profile_projects",
  "jobops_settings_get",
  "jobops_settings_set",
  "jobops_codex_auth_status",
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
    for (const name of [
      "jobops_profile_projects",
      "jobops_settings_get",
      "jobops_codex_auth_status",
    ]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    }
    for (const name of ["jobops_profile_get", "jobops_settings_set"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(false);
    }
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

  it("calls jobops_codex_auth_status end-to-end without returning a token", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "jobops_codex_auth_status", arguments: {} },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as {
      authenticated: boolean;
      username: string | null;
    };
    expect(typeof data.authenticated).toBe("boolean");
    expect(data).not.toHaveProperty("token");
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
