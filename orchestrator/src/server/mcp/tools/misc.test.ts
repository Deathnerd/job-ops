import type { Server } from "node:http";
import { startServer, stopServer } from "@server/api/routes/test-utils";
import { afterEach, describe, expect, it } from "vitest";

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

const MISC_TOOL_NAMES = [
  "jobops_app_status",
  "jobops_visa_sponsors_search",
  "jobops_tracer_links",
  "jobops_backups",
  "jobops_workspaces",
  "jobops_whoami",
  "jobops_api_keys",
  "jobops_database_clear",
  "jobops_onboarding_status",
  "jobops_onboarding_actions",
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

describe.sequential("misc domain MCP tools", () => {
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
    const key = await createApiKey({ userId, name: "misc-mcp-test" });
    apiKey = key.plaintextKey;

    return { jwt };
  }

  it("lists every misc tool via tools/list", async () => {
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
    for (const expectedName of MISC_TOOL_NAMES) {
      expect(names).toContain(expectedName);
    }
  });

  it("marks the delete/revoke-capable tools destructive in tools/list annotations", async () => {
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
    for (const name of [
      "jobops_backups",
      "jobops_workspaces",
      "jobops_api_keys",
      "jobops_database_clear",
    ]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.destructiveHint).toBe(true);
    }
  });

  it("calls jobops_whoami end-to-end and gets the authenticated identity back", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "jobops_whoami", arguments: {} },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as {
      user: { username: string };
    };
    expect(data.user.username).toBe("admin");
  });

  it("calls jobops_app_status end-to-end and gets app status back", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "jobops_app_status", arguments: {} },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as Record<string, unknown>;
    expect(data).toBeTruthy();
  });

  it("round-trips jobops_api_keys create/list/revoke -- plaintext key appears only in the create response", async () => {
    await boot();

    const createResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "jobops_api_keys",
        arguments: { action: "create", name: "round-trip-test-key" },
      },
    });
    expect(createResponse.result.isError).toBeFalsy();
    const created = toolCallResultData(createResponse) as {
      id: string;
      name: string;
      key: string;
    };
    expect(created.name).toBe("round-trip-test-key");
    expect(typeof created.key).toBe("string");
    expect(created.key.length).toBeGreaterThan(0);

    const listResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "jobops_api_keys", arguments: { action: "list" } },
    });
    expect(listResponse.result.isError).toBeFalsy();
    const listedRaw = listResponse.result.content[0].text as string;
    // The plaintext key must NEVER leak into a list response -- only the
    // one-time create response is allowed to contain it.
    expect(listedRaw).not.toContain(created.key);
    const listed = JSON.parse(listedRaw) as {
      keys: Array<{ id: string; name: string; revokedAt: string | null }>;
    };
    const listedKey = listed.keys.find((k) => k.id === created.id);
    expect(listedKey).toBeTruthy();
    expect(listedKey?.revokedAt).toBeNull();

    const revokeResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "jobops_api_keys",
        arguments: { action: "revoke", id: created.id },
      },
    });
    expect(revokeResponse.result.isError).toBeFalsy();
    const revokeRaw = revokeResponse.result.content[0].text as string;
    expect(revokeRaw).not.toContain(created.key);
    const revoked = JSON.parse(revokeRaw) as { revoked: boolean };
    expect(revoked.revoked).toBe(true);

    const listAfterRevokeResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "jobops_api_keys", arguments: { action: "list" } },
    });
    const listedAfterRevoke = toolCallResultData(listAfterRevokeResponse) as {
      keys: Array<{ id: string; revokedAt: string | null }>;
    };
    const revokedKeyRow = listedAfterRevoke.keys.find(
      (k) => k.id === created.id,
    );
    expect(revokedKeyRow?.revokedAt).toBeTruthy();
  });

  it("round-trips jobops_backups create/list without touching the database (safe, non-destructive path)", async () => {
    await boot();

    const createResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "jobops_backups", arguments: { action: "create" } },
    });
    expect(createResponse.result.isError).toBeFalsy();
    const created = toolCallResultData(createResponse) as {
      filename: string;
    };
    expect(typeof created.filename).toBe("string");

    const listResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "jobops_backups", arguments: { action: "list" } },
    });
    expect(listResponse.result.isError).toBeFalsy();
    const listed = toolCallResultData(listResponse) as {
      backups: Array<{ filename: string }>;
    };
    expect(listed.backups.some((b) => b.filename === created.filename)).toBe(
      true,
    );
  });
});
