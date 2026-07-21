import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("Database API routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("clears jobs and pipeline runs", async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());

    const { createJob } = await import("@server/repositories/jobs");
    await createJob({
      source: "manual",
      title: "Cleanup Role",
      employer: "Acme",
      jobUrl: "https://example.com/job/cleanup",
      jobDescription: "Test description",
    });

    const res = await fetch(`${baseUrl}/api/database`, { method: "DELETE" });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.jobsDeleted).toBe(1);
    expect(typeof body.meta.requestId).toBe("string");
  });

  describe("system-admin gate", () => {
    // The default startServer() bypasses auth entirely (test-user context is
    // always isSystemAdmin: true -- see createAuthGuard's testAuthBypassEnabled),
    // which is why the test above never exercises the gate at all. These two
    // cases opt out of the bypass (JOBOPS_TEST_AUTH_BYPASS: "0") and log in as
    // real users -- one system admin, one not -- to prove the gate itself
    // works, matching backup.ts's `requireSystemAdmin` mechanism/error shape.
    async function boot() {
      ({ server, baseUrl, closeDb, tempDir } = await startServer({
        env: {
          BASIC_AUTH_USER: "admin",
          BASIC_AUTH_PASSWORD: "secret",
          JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
          JOBOPS_TEST_AUTH_BYPASS: "0",
        },
      }));
    }

    async function login(username: string, password: string): Promise<string> {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json();
      return body.data.token as string;
    }

    it("forbids a non-admin authenticated caller", async () => {
      await boot();
      const adminJwt = await login("admin", "secret");

      const { createPrivateWorkspaceUser } = await import(
        "@server/repositories/users"
      );
      await createPrivateWorkspaceUser({
        username: "regular-user",
        password: "not-an-admin-password",
        isSystemAdmin: false,
        useDefaultTenant: true,
      });
      const memberJwt = await login("regular-user", "not-an-admin-password");

      const res = await fetch(`${baseUrl}/api/database`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${memberJwt}` },
      });
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toBe("System admin access is required");

      // Sanity: the admin JWT from the same boot still works.
      const adminRes = await fetch(`${baseUrl}/api/database`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminJwt}` },
      });
      expect(adminRes.status).toBe(200);
    });

    it("allows a system-admin caller", async () => {
      await boot();
      const adminJwt = await login("admin", "secret");

      const res = await fetch(`${baseUrl}/api/database`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminJwt}` },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(typeof body.data.jobsDeleted).toBe("number");
    });
  });
});
