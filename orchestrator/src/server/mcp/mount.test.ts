import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "../api/routes/test-utils";

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

function initializeBody() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });
}

describe.sequential("MCP mount", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("404s when the flag is off", async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: MCP_ACCEPT_HEADER,
      },
      body: initializeBody(),
    });

    expect(res.status).toBe(404);
  });

  it("401s with a JSON-RPC error when no auth is provided", async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: {
        JOBOPS_MCP_ENABLED: "true",
        JOBOPS_TEST_AUTH_BYPASS: "0",
      },
    }));

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: MCP_ACCEPT_HEADER,
      },
      body: initializeBody(),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32001);
    expect(body.id).toBeNull();
  });

  it("answers initialize with a valid API key", async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: {
        JOBOPS_MCP_ENABLED: "true",
        BASIC_AUTH_USER: "admin",
        BASIC_AUTH_PASSWORD: "secret",
        JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
        JOBOPS_TEST_AUTH_BYPASS: "0",
      },
    }));

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });
    const loginBody = await loginRes.json();

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${loginBody.data.token}` },
    });
    const meBody = await meRes.json();
    const userId = meBody.data.user.id as string;

    const { createApiKey } = await import("@server/repositories/api-keys");
    const key = await createApiKey({ userId, name: "mcp-test" });

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: MCP_ACCEPT_HEADER,
        Authorization: `Bearer ${key.plaintextKey}`,
      },
      body: initializeBody(),
    });

    expect(res.status).toBe(200);
    // Stateless mode defaults to SSE streaming for the response; pull the
    // JSON-RPC payload out of the "data: " line(s) of the event stream.
    const raw = await res.text();
    const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeTruthy();
    const body = JSON.parse(dataLine?.slice("data: ".length) ?? "");
    expect(body.result.serverInfo.name).toBe("jobops");
  });

  it("returns a 500 JSON-RPC error instead of crashing when the handler throws", async () => {
    // Force an internal throw inside the POST /mcp try block (registerAllTools)
    // to prove the async-rejection guard routes it to a proper JSON-RPC 500
    // instead of an unhandled rejection that would kill the process.
    vi.doMock("./framework", () => ({
      registerAllTools: vi.fn(() => {
        throw new Error("boom: simulated registerAllTools failure");
      }),
    }));

    try {
      ({ server, baseUrl, closeDb, tempDir } = await startServer({
        env: {
          JOBOPS_MCP_ENABLED: "true",
          BASIC_AUTH_USER: "admin",
          BASIC_AUTH_PASSWORD: "secret",
          JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
          JOBOPS_TEST_AUTH_BYPASS: "0",
        },
      }));

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" }),
      });
      const loginBody = await loginRes.json();

      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: MCP_ACCEPT_HEADER,
          Authorization: `Bearer ${loginBody.data.token}`,
        },
        body: initializeBody(),
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error.code).toBe(-32603);
      expect(body.id).toBeNull();
    } finally {
      vi.doUnmock("./framework");
    }
  });
});
