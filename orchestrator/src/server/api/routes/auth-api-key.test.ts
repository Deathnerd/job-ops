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

  it("accepts a valid API key as bearer auth on a protected route", async () => {
    const userId = await getUserId();
    const { createApiKey } = await import("@server/repositories/api-keys");
    const key = await createApiKey({ userId, name: "t" });

    const res = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${key.plaintextKey}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns the user's identity from GET /api/auth/me with a valid API key", async () => {
    const userId = await getUserId();
    const { createApiKey } = await import("@server/repositories/api-keys");
    const key = await createApiKey({ userId, name: "t" });

    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${key.plaintextKey}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.user.id).toBe(userId);
    expect(body.data.analyticsDistinctId).toBeTruthy();
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

  describe("API key management endpoints", () => {
    async function getToken(): Promise<string> {
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" }),
      });
      const loginBody = await loginRes.json();
      return loginBody.data.token as string;
    }

    it("creates a key returning the plaintext once, and list never contains it", async () => {
      const token = await getToken();

      const createRes = await fetch(`${baseUrl}/api/auth/api-keys`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "my key" }),
      });
      expect(createRes.status).toBe(201);
      const createBody = await createRes.json();
      expect(createBody.ok).toBe(true);
      expect(createBody.data.key).toBeTruthy();
      expect(createBody.data.name).toBe("my key");
      expect(createBody.data.id).toBeTruthy();
      expect(createBody.data.createdAt).toBeTruthy();

      const listRes = await fetch(`${baseUrl}/api/auth/api-keys`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(listBody.ok).toBe(true);
      expect(Array.isArray(listBody.data.keys)).toBe(true);
      const listedKey = listBody.data.keys.find(
        (k: { id: string }) => k.id === createBody.data.id,
      );
      expect(listedKey).toBeTruthy();
      expect(listedKey.name).toBe("my key");
      expect(listedKey).not.toHaveProperty("key");
      expect(listedKey).not.toHaveProperty("plaintextKey");
      expect(JSON.stringify(listBody)).not.toContain(createBody.data.key);
    });

    it("404s revoking another user's key", async () => {
      const token = await getToken();

      const createRes = await fetch(`${baseUrl}/api/auth/api-keys`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "owned-by-admin" }),
      });
      const createBody = await createRes.json();

      const { createPrivateWorkspaceUser } = await import(
        "@server/repositories/users"
      );
      const otherUser = await createPrivateWorkspaceUser({
        username: "other-user",
        password: "other-secret-password",
      });
      const { signToken } = await import("@server/auth/jwt");
      const { token: otherToken } = await signToken({
        sub: otherUser.id,
        userId: otherUser.id,
        tenantId: otherUser.workspaceId,
        username: otherUser.username,
        isSystemAdmin: otherUser.isSystemAdmin,
      });

      const revokeRes = await fetch(
        `${baseUrl}/api/auth/api-keys/${createBody.data.id}/revoke`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${otherToken}` },
        },
      );
      expect(revokeRes.status).toBe(404);
      const revokeBody = await revokeRes.json();
      expect(revokeBody.ok).toBe(false);
      expect(revokeBody.error.code).toBe("NOT_FOUND");
    });

    it("revokes the caller's own key", async () => {
      const token = await getToken();

      const createRes = await fetch(`${baseUrl}/api/auth/api-keys`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "to-revoke" }),
      });
      const createBody = await createRes.json();

      const revokeRes = await fetch(
        `${baseUrl}/api/auth/api-keys/${createBody.data.id}/revoke`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(revokeRes.status).toBe(200);
      const revokeBody = await revokeRes.json();
      expect(revokeBody.ok).toBe(true);
      expect(revokeBody.data.revoked).toBe(true);
    });

    it("rejects an empty or whitespace-only name", async () => {
      const token = await getToken();

      for (const name of ["", "   "]) {
        const res = await fetch(`${baseUrl}/api/auth/api-keys`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ name }),
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        const body = await res.json();
        expect(body.ok).toBe(false);
      }
    });

    it("requires authentication for all three endpoints", async () => {
      const listRes = await fetch(`${baseUrl}/api/auth/api-keys`);
      expect(listRes.status).toBe(401);

      const createRes = await fetch(`${baseUrl}/api/auth/api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "no-auth" }),
      });
      expect(createRes.status).toBe(401);

      const revokeRes = await fetch(
        `${baseUrl}/api/auth/api-keys/some-id/revoke`,
        { method: "POST" },
      );
      expect(revokeRes.status).toBe(401);
    });
  });
});
