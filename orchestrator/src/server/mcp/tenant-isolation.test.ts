/**
 * Cross-tenant isolation test for the MCP surface -- Task 10's core
 * requirement: an API key scoped to one workspace user must never see (or
 * keep acting on behalf of) another workspace user's data over `/mcp`.
 *
 * Fixture approach mirrors `api/routes/tenant-isolation.test.ts` (admin
 * creates a second workspace user via `POST /api/workspaces/users`, both
 * users get their own REST session) combined with the MCP bootstrap from
 * `tools/jobs.test.ts` (`JOBOPS_MCP_ENABLED`, `JOBOPS_TEST_AUTH_BYPASS: "0"`
 * real-login pattern, `createApiKey` for the bearer key, SSE `data: ` line
 * parsing for the JSON-RPC payload, and pointing `process.env.PORT` at the
 * OS-assigned test port so `selfCall`'s loopback request lands on this same
 * server instance).
 */

import type { Server } from "node:http";
import { startServer, stopServer } from "@server/api/routes/test-utils";
import { afterEach, describe, expect, it } from "vitest";

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

const AUTH_ENV = {
  JOBOPS_MCP_ENABLED: "true",
  BASIC_AUTH_USER: "admin",
  BASIC_AUTH_PASSWORD: "secret",
  JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
  JOBOPS_TEST_AUTH_BYPASS: "0",
};

async function readMcpJsonRpc(res: Response): Promise<any> {
  // Stateless mode defaults to SSE streaming for the response; pull the
  // JSON-RPC payload out of the "data: " line(s) of the event stream, same
  // pattern as mount.test.ts / tools/jobs.test.ts.
  const raw = await res.text();
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  expect(dataLine).toBeTruthy();
  return JSON.parse(dataLine?.slice("data: ".length) ?? "");
}

async function callMcpRaw(
  baseUrl: string,
  bearerKey: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: MCP_ACCEPT_HEADER,
      Authorization: `Bearer ${bearerKey}`,
    },
    body: JSON.stringify(body),
  });
}

async function callMcp(
  baseUrl: string,
  bearerKey: string,
  body: unknown,
): Promise<any> {
  const res = await callMcpRaw(baseUrl, bearerKey, body);
  expect(res.status).toBe(200);
  return readMcpJsonRpc(res);
}

function toolCallResultData(rpcResponse: any): unknown {
  expect(rpcResponse.result?.isError).toBeFalsy();
  const content = rpcResponse.result?.content;
  expect(Array.isArray(content)).toBe(true);
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0].text);
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  expect(res.status).toBe(200);
  return body.data.token as string;
}

async function currentUserId(baseUrl: string, token: string) {
  const res = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return body.data.user.id as string;
}

async function importManualJob(baseUrl: string, token: string, title: string) {
  const res = await fetch(`${baseUrl}/api/manual-jobs/import`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      skipTailoring: true,
      job: {
        title,
        employer: "Acme",
        jobUrl: `https://example.com/jobs/${encodeURIComponent(title)}`,
        jobDescription: "Tenant isolation MCP role",
      },
    }),
  });
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.ok).toBe(true);
  return body.data as { id: string; title: string };
}

describe.sequential("MCP tenant isolation", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function boot() {
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: AUTH_ENV,
    }));

    // `mount.ts` builds the selfCall baseUrl from `process.env.PORT` at
    // request time (see server/mcp/index.ts); test-utils.ts always binds to
    // an OS-assigned port (`app.listen(0, ...)`), so we point PORT at the
    // actual bound port after the fact so tool handlers' selfCall reaches
    // this same test server instance instead of the default :3001.
    process.env.PORT = new URL(baseUrl).port;
  }

  it("user B's API key cannot see user A's job over jobops_jobs_list, and A's key does see it", async () => {
    await boot();

    // User A: the seeded admin workspace user.
    const adminToken = await login(baseUrl, "admin", "secret");
    const adminUserId = await currentUserId(baseUrl, adminToken);
    const adminJob = await importManualJob(baseUrl, adminToken, "Admin Role");

    // User B: a second workspace user created by the admin, mirroring
    // api/routes/tenant-isolation.test.ts's fixture.
    const createUserRes = await fetch(`${baseUrl}/api/workspaces/users`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        username: "adam",
        displayName: "Adam",
        password: "adam-secret",
      }),
    });
    expect(createUserRes.status).toBe(201);

    const adamToken = await login(baseUrl, "adam", "adam-secret");
    const adamUserId = await currentUserId(baseUrl, adamToken);
    expect(adamUserId).not.toBe(adminUserId);

    const { createApiKey } = await import("@server/repositories/api-keys");
    const adminKey = await createApiKey({
      userId: adminUserId,
      name: "admin-mcp-key",
    });
    const adamKey = await createApiKey({
      userId: adamUserId,
      name: "adam-mcp-key",
    });

    // Sanity: A's own key DOES see A's job -- proves the negative below
    // isn't vacuous (e.g. an empty list because the tool is broken).
    const adminListResponse = await callMcp(baseUrl, adminKey.plaintextKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "jobops_jobs_list", arguments: {} },
    });
    const adminData = toolCallResultData(adminListResponse) as {
      jobs: Array<{ id: string }>;
    };
    expect(adminData.jobs.map((j) => j.id)).toContain(adminJob.id);

    // B's key, calling the same tool over the same /mcp endpoint, must NOT
    // see A's job.
    const adamListResponse = await callMcp(baseUrl, adamKey.plaintextKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "jobops_jobs_list", arguments: {} },
    });
    const adamData = toolCallResultData(adamListResponse) as {
      jobs: Array<{ id: string }>;
    };
    expect(adamData.jobs.map((j) => j.id)).not.toContain(adminJob.id);
  });

  it("401s over /mcp once the caller's API key is revoked", async () => {
    await boot();

    const adminToken = await login(baseUrl, "admin", "secret");
    const adminUserId = await currentUserId(baseUrl, adminToken);

    const createUserRes = await fetch(`${baseUrl}/api/workspaces/users`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        username: "adam",
        displayName: "Adam",
        password: "adam-secret",
      }),
    });
    expect(createUserRes.status).toBe(201);

    const adamToken = await login(baseUrl, "adam", "adam-secret");
    const adamUserId = await currentUserId(baseUrl, adamToken);

    const { createApiKey, revokeApiKey } = await import(
      "@server/repositories/api-keys"
    );
    const adamKey = await createApiKey({
      userId: adamUserId,
      name: "adam-mcp-key",
    });

    // Before revocation, the key works.
    const beforeRes = await callMcpRaw(baseUrl, adamKey.plaintextKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "jobops_jobs_list", arguments: {} },
    });
    expect(beforeRes.status).toBe(200);

    const revoked = await revokeApiKey({ userId: adamUserId, id: adamKey.id });
    expect(revoked).toBe(true);

    const afterRes = await callMcpRaw(baseUrl, adamKey.plaintextKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "jobops_jobs_list", arguments: {} },
    });
    expect(afterRes.status).toBe(401);
    const afterBody = await afterRes.json();
    expect(afterBody.jsonrpc).toBe("2.0");
    expect(afterBody.error.code).toBe(-32001);

    // adminUserId only used to keep the fixture parallel to the first test
    // and document that revocation is scoped per-user, not global.
    expect(adminUserId).not.toBe(adamUserId);
  });
});
