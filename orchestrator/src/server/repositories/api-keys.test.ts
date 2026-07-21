import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("api-keys repository", () => {
  const originalEnv = { ...process.env };
  let tempDir = "";
  let closeDb: (() => void) | null = null;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-api-keys-repo-test-"));
    process.env = {
      ...originalEnv,
      DATA_DIR: tempDir,
      NODE_ENV: "test",
    };

    await import("../db/migrate");
    const dbModule = await import("../db");
    closeDb = dbModule.closeDb;

    // api_keys.user_id has a real FOREIGN KEY REFERENCES users(id), so seed
    // the users referenced by these tests before exercising the repository.
    await dbModule.db.insert(dbModule.schema.users).values(
      ["user_1", "user_2", "user_3"].map((id) => ({
        id,
        username: id,
        passwordHash: "test-hash",
        passwordSalt: "test-salt",
      })),
    );
  });

  afterEach(async () => {
    closeDb?.();
    closeDb = null;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    process.env = { ...originalEnv };
  });

  it("creates a key and finds it by hash", async () => {
    const { createApiKey, findActiveKeyByHash, hashApiKey } = await import(
      "./api-keys"
    );

    const created = await createApiKey({ userId: "user_1", name: "laptop" });
    expect(created.plaintextKey).toMatch(/^[0-9a-f-]{36}$/); // UUIDv4
    const found = await findActiveKeyByHash(hashApiKey(created.plaintextKey));
    expect(found).toEqual({ id: created.id, userId: "user_1" });
  });

  it("revoked keys are not findable and revoke is user-scoped", async () => {
    const { createApiKey, findActiveKeyByHash, hashApiKey, revokeApiKey } =
      await import("./api-keys");

    const created = await createApiKey({ userId: "user_1", name: "x" });
    expect(await revokeApiKey({ userId: "user_2", id: created.id })).toBe(
      false,
    );
    expect(await revokeApiKey({ userId: "user_1", id: created.id })).toBe(true);
    expect(
      await findActiveKeyByHash(hashApiKey(created.plaintextKey)),
    ).toBeNull();
  });

  it("never returns hashes from list", async () => {
    const { createApiKey, listApiKeys } = await import("./api-keys");

    await createApiKey({ userId: "user_3", name: "a" });
    const rows = await listApiKeys("user_3");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("keyHash");
  });
});
