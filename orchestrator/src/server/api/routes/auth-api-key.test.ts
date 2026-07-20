import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("API key bearer auth", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  const AUTH_ENV = {
    BASIC_AUTH_USER: "admin",
    BASIC_AUTH_PASSWORD: "secret",
    JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
    JOBOPS_TEST_AUTH_BYPASS: "0",
  };

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: AUTH_ENV,
    }));
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function getUserId(): Promise<string> {
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
    return meBody.data.user.id as string;
  }

  // Note: /api/auth/me re-verifies the JWT itself rather than relying on the
  // auth guard's resolved request context, so it does not exercise the
  // guard's API-key fallback. /api/settings (like the JWT coverage in
  // auth.test.ts) goes through the guard normally and is used here instead.

  it("accepts a valid API key as bearer auth on a protected route", async () => {
    const userId = await getUserId();
    const { createApiKey } = await import("@server/repositories/api-keys");
    const key = await createApiKey({ userId, name: "t" });

    const res = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${key.plaintextKey}` },
    });

    expect(res.status).not.toBe(401);
  });

  it("rejects a revoked key", async () => {
    const userId = await getUserId();
    const { createApiKey, revokeApiKey } = await import(
      "@server/repositories/api-keys"
    );
    const key = await createApiKey({ userId, name: "t" });
    await revokeApiKey({ userId, id: key.id });

    const res = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${key.plaintextKey}` },
    });

    expect(res.status).toBe(401);
  });

  it("rejects a garbage bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: "Bearer not-a-key" },
    });

    expect(res.status).toBe(401);
  });
});
