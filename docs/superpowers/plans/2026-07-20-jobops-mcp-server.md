# JobOps MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose full JobOps functionality to AI agents via a Streamable-HTTP MCP server mounted at `/mcp`, authenticated by new per-user API keys, with CI-enforced endpoint coverage.

**Architecture:** MCP tools are thin dispatchers that self-call the app's own REST API on `localhost:${PORT}` forwarding the caller's bearer API key, so auth/tenancy/demo/redaction middleware apply unchanged. API keys are a new first-class auth credential accepted by the existing `createAuthGuard` bearer path. A router-walking contract test fails CI if any `/api/*` endpoint is neither claimed by a tool's coverage list nor explicitly excluded.

**Tech Stack:** TypeScript (tsx, no build step), express 4, drizzle + better-sqlite3, zod ^3 (already present), `@modelcontextprotocol/sdk` (new dep), vitest + supertest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-20-jobops-mcp-server-design.md`. Read it first.
- AGENTS.md `/api/*` contract is mandatory: `{ ok, data/error, meta.requestId }` via `ok()`/`fail()` from `@infra/http`; errors via `toAppError`; shared logger only.
- Biome for lint/format (`./orchestrator/node_modules/.bin/biome ci .` from repo root must pass). No ESLint/Prettier.
- Feature flag `JOBOPS_MCP_ENABLED` (string `"true"` enables). Default off; upstream behavior untouched when off.
- Multi-tenancy: never bypass the auth guard or tenancy context; MCP traffic must flow through the same middleware as REST.
- **Host policy: the npm CLI is blocked for agents on this machine.** Any `npm install` step must be run by the operator (ask, or have them run `! cd <repo> && npm install ...`). Test runs use the workspace binaries directly: `./orchestrator/node_modules/.bin/vitest run <file>` from repo root with `cwd` orchestrator (see task steps).
- Run tests as: `cd orchestrator && ./node_modules/.bin/vitest run src/server/<path>.test.ts`.
- Commit after every green task. Branch: `mcp-server` (already exists, spec committed).
- ASCII punctuation in all new markdown/docs.

---

### Task 1: `api_keys` table + repository

**Files:**
- Modify: `orchestrator/src/server/db/schema.ts` (append after `authSessions` table)
- Modify: `orchestrator/src/server/db/migrate.ts` (add table create, follow existing `tableExists` pattern)
- Create: `orchestrator/src/server/repositories/api-keys.ts`
- Test: `orchestrator/src/server/repositories/api-keys.test.ts`

**Interfaces:**
- Consumes: `users` table, drizzle `db` from `@server/db`, `@paralleldrive/cuid2` `createId`.
- Produces (used by Tasks 2, 3):
  - `hashApiKey(plaintext: string): string` (sha256 hex)
  - `createApiKey(input: { userId: string; name: string }): Promise<{ id: string; name: string; plaintextKey: string; createdAt: string }>`
  - `findActiveKeyByHash(keyHash: string): Promise<{ id: string; userId: string } | null>` (excludes revoked)
  - `listApiKeys(userId: string): Promise<Array<{ id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }>>`
  - `revokeApiKey(input: { userId: string; id: string }): Promise<boolean>`
  - `touchLastUsed(id: string): void` (fire-and-forget, throttle to 1 write/60s per key via in-memory Map)

- [ ] **Step 1: Write failing repository test**

```ts
// orchestrator/src/server/repositories/api-keys.test.ts
import { describe, expect, it } from "vitest";
import {
  createApiKey,
  findActiveKeyByHash,
  hashApiKey,
  listApiKeys,
  revokeApiKey,
} from "./api-keys";
// Follow the db test-bootstrap pattern used by sibling repository tests in
// this directory (temp sqlite via migrate; see existing *.test.ts here).

describe("api-keys repository", () => {
  it("creates a key and finds it by hash", async () => {
    const created = await createApiKey({ userId: "user_1", name: "laptop" });
    expect(created.plaintextKey).toMatch(/^[0-9a-f-]{36}$/); // UUIDv4
    const found = await findActiveKeyByHash(hashApiKey(created.plaintextKey));
    expect(found).toEqual({ id: created.id, userId: "user_1" });
  });

  it("revoked keys are not findable and revoke is user-scoped", async () => {
    const created = await createApiKey({ userId: "user_1", name: "x" });
    expect(await revokeApiKey({ userId: "user_2", id: created.id })).toBe(false);
    expect(await revokeApiKey({ userId: "user_1", id: created.id })).toBe(true);
    expect(await findActiveKeyByHash(hashApiKey(created.plaintextKey))).toBeNull();
  });

  it("never returns hashes from list", async () => {
    await createApiKey({ userId: "user_3", name: "a" });
    const rows = await listApiKeys("user_3");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("keyHash");
  });
});
```

- [ ] **Step 2: Run test, verify it fails** (`cd orchestrator && ./node_modules/.bin/vitest run src/server/repositories/api-keys.test.ts`) - FAIL: module not found.

- [ ] **Step 3: Add schema table**

```ts
// schema.ts, after authSessions
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => ({
    keyHashIndex: index("idx_api_keys_key_hash").on(table.keyHash),
    userIdIndex: index("idx_api_keys_user_id").on(table.userId),
  }),
);
```

- [ ] **Step 4: Add migration** in `migrate.ts` following the existing `tableExists` guard pattern:

```ts
if (!tableExists("api_keys")) {
  sqlite.exec(`CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at TEXT
  )`);
  sqlite.exec(`CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash)`);
  sqlite.exec(`CREATE INDEX idx_api_keys_user_id ON api_keys(user_id)`);
}
```

- [ ] **Step 5: Implement repository**

```ts
// orchestrator/src/server/repositories/api-keys.ts
import { createHash, randomUUID } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { db } from "@server/db";
import { apiKeys } from "@server/db/schema";
import { and, eq, isNull } from "drizzle-orm";

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export async function createApiKey(input: { userId: string; name: string }) {
  const plaintextKey = randomUUID();
  const id = createId();
  const createdAt = new Date().toISOString();
  await db.insert(apiKeys).values({
    id,
    userId: input.userId,
    name: input.name,
    keyHash: hashApiKey(plaintextKey),
    createdAt,
  });
  return { id, name: input.name, plaintextKey, createdAt };
}

export async function findActiveKeyByHash(keyHash: string) {
  const row = await db
    .select({ id: apiKeys.id, userId: apiKeys.userId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .get();
  return row ?? null;
}

export async function listApiKeys(userId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .all();
}

export async function revokeApiKey(input: { userId: string; id: string }) {
  const result = await db
    .update(apiKeys)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(apiKeys.id, input.id),
        eq(apiKeys.userId, input.userId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .run();
  return result.changes > 0;
}

const lastTouched = new Map<string, number>();
export function touchLastUsed(id: string): void {
  const now = Date.now();
  const prev = lastTouched.get(id) ?? 0;
  if (now - prev < 60_000) return;
  lastTouched.set(id, now);
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, id))
    .run();
}
```

(Adjust drizzle call style - `.get()/.all()/.run()` vs `await` only - to match whatever sibling repositories in `orchestrator/src/server/repositories/` actually do; copy their db import and test bootstrap exactly.)

- [ ] **Step 6: Run test, verify PASS. Run `./node_modules/.bin/biome check --write src/server/repositories/api-keys.ts src/server/db/schema.ts src/server/db/migrate.ts` from orchestrator.**

- [ ] **Step 7: Commit** `git add -A && git commit -m "feat(auth): add api_keys table and repository"` (stage and commit as separate Bash calls - a repo hook requires it).

---

### Task 2: Accept API keys in the auth guard

**Files:**
- Modify: `orchestrator/src/server/app.ts` (`getAuthorizationContext`, ~line 165)
- Test: `orchestrator/src/server/api/routes/auth-api-key.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`hashApiKey`, `findActiveKeyByHash`, `touchLastUsed`), `usersRepo.getUserById`.
- Produces: any `/api/*` request with `Authorization: Bearer <api-key>` resolves the same `{userId, tenantId, username, isSystemAdmin}` context as a JWT.

- [ ] **Step 1: Write failing test.** Use the app-bootstrap pattern from `orchestrator/src/server/api/routes/auth.test.ts` (copy its createApp/supertest setup verbatim, including `test-utils` mocks). Cases:

```ts
it("accepts a valid API key as bearer auth on a protected route", async () => {
  // create user via existing signup/setup flow used in auth.test.ts,
  // then: const key = await createApiKey({ userId, name: "t" });
  const res = await request(server)
    .get("/api/auth/me")
    .set("Authorization", `Bearer ${key.plaintextKey}`);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

it("rejects a revoked key", async () => {
  // revokeApiKey then same call
  expect(res.status).toBe(401);
});

it("rejects a garbage bearer token", async () => {
  const res = await request(server)
    .get("/api/auth/me")
    .set("Authorization", "Bearer not-a-key");
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run, verify FAIL** (valid-key case 401s today).

- [ ] **Step 3: Implement.** In `getAuthorizationContext` in `app.ts`, replace the catch-return-null tail so a failed JWT verify falls through to key lookup:

```ts
const token = authHeader.slice("Bearer ".length).trim();
let payload: Awaited<ReturnType<typeof verifyToken>> | null = null;
try {
  payload = await verifyToken(token);
} catch {
  payload = null;
}
if (payload) {
  const user = await usersRepo.getUserById(payload.userId);
  if (!user || user.isDisabled || user.workspaceId !== payload.tenantId) {
    return null;
  }
  return {
    userId: user.id,
    tenantId: user.workspaceId,
    username: user.username,
    isSystemAdmin: user.isSystemAdmin,
  };
}
// API-key fallback
const keyRow = await findActiveKeyByHash(hashApiKey(token));
if (!keyRow) return null;
const user = await usersRepo.getUserById(keyRow.userId);
if (!user || user.isDisabled) return null;
touchLastUsed(keyRow.id);
return {
  userId: user.id,
  tenantId: user.workspaceId,
  username: user.username,
  isSystemAdmin: user.isSystemAdmin,
};
```

Add imports from `@server/repositories/api-keys`.

- [ ] **Step 4: Run new test + existing `auth.test.ts`, verify PASS.**
- [ ] **Step 5: Commit** `feat(auth): accept API keys as bearer credentials`.

---

### Task 3: API-key management endpoints

**Files:**
- Modify: `orchestrator/src/server/api/routes/auth.ts`
- Test: extend `orchestrator/src/server/api/routes/auth-api-key.test.ts`

**Interfaces:**
- Produces REST surface (also consumed by Task 4 UI and excluded-from-MCP list in Task 8):
  - `GET /api/auth/api-keys` -> `ok(res, { keys: [...] })` (listApiKeys, current user)
  - `POST /api/auth/api-keys` body `{ name: string }` -> `ok(res, { id, name, createdAt, key: plaintextKey }, 201)` - only response that ever contains the plaintext
  - `POST /api/auth/api-keys/:id/revoke` -> `ok(res, { revoked: true })` or 404 via `fail(res, notFound(...))`

- [ ] **Step 1: Write failing tests** for the three endpoints (auth'd via the JWT session pattern from `auth.test.ts`): create returns plaintext once and list never does; revoke of another user's key 404s; unauthenticated requests 401.
- [ ] **Step 2: Verify FAIL.**
- [ ] **Step 3: Implement** in `auth.ts` following its existing handler style (`try { ... ok(res, ...) } catch (e) { fail(res, toAppError(e)) }`; read the authed user the same way `GET /api/auth/me` does - it is in this file). Validate `name` with zod: `z.object({ name: z.string().trim().min(1).max(64) })`, on parse failure `fail` with the same invalid-input error the file already uses for bad bodies.
- [ ] **Step 4: Verify PASS, biome, commit** `feat(auth): API key management endpoints`.

---

### Task 4: Settings UI card for API keys

**Files:**
- Create: `orchestrator/src/client/pages/settings/ApiKeysCard.tsx` (place beside existing settings section components - find where `SettingsPage.tsx` renders its cards and match that directory/naming; if settings sections live inline in `SettingsPage.tsx`, add the card component next to it and render it last in the page)
- Modify: `orchestrator/src/client/pages/SettingsPage.tsx` (render the card)
- Test: `orchestrator/src/client/pages/settings/ApiKeysCard.test.tsx` (mirror `SettingsPage.test.tsx` harness)

**Interfaces:**
- Consumes Task 3 endpoints via the client's existing fetch/query helpers (find how SettingsPage calls `/api/settings` - TanStack Query - and copy that pattern).

- [ ] **Step 1: Failing render test**: card lists keys from a mocked `GET /api/auth/api-keys`; "Create key" posts and then shows the returned plaintext in a copyable field with a "you will not see this again" note; each row has a Revoke button posting to `/api/auth/api-keys/:id/revoke`.
- [ ] **Step 2: Verify FAIL. Step 3: Implement** with the repo's existing UI kit (Radix/shadcn-style components used across SettingsPage - reuse `Button`, `Card`, `Input` from `orchestrator/src/client/components/ui/`). Plaintext display: readonly input + copy button; stored only in component state.
- [ ] **Step 4: PASS + `npm`-free check run: `cd orchestrator && ./node_modules/.bin/vitest run src/client/pages/settings/ApiKeysCard.test.tsx` and `./node_modules/.bin/tsc --noEmit`. Commit** `feat(client): API keys settings card`.

---

### Task 5: MCP dependency + gated `/mcp` mount

**Files:**
- Modify: `orchestrator/package.json` (dependency - OPERATOR-RUN install)
- Create: `orchestrator/src/server/mcp/index.ts`
- Modify: `orchestrator/src/server/app.ts` (mount before the `app.get("*", ...)` SPA catch-all)
- Modify: `.env.example` (document `JOBOPS_MCP_ENABLED=false`)
- Test: `orchestrator/src/server/mcp/mount.test.ts`

**Interfaces:**
- Consumes: auth guard context resolver. Export the guard's `getAuthorizationContext` for reuse: in `app.ts`, `createAuthGuard` currently keeps it private - lift it to a module-scope exported function `resolveBearerContext(req)` used by both the guard and MCP.
- Produces: `mountMcp(app: express.Express): void` - when `process.env.JOBOPS_MCP_ENABLED === "true"`, handles `POST /mcp` (Streamable HTTP, stateless); 401 JSON-RPC error when bearer resolution fails; `GET /mcp` and `DELETE /mcp` return 405 (stateless mode). Also produces `ToolContext = { bearerKey: string; baseUrl: string }` passed to tools (Task 6).

- [ ] **Step 1: ASK OPERATOR to run** `cd <repo>/orchestrator && npm install @modelcontextprotocol/sdk` (npm blocked for agents; lockfile must stay npm-format for upstreamability). Verify `package.json` gains the dep.
- [ ] **Step 2: Failing test** (supertest against the real app factory used by route tests):

```ts
it("404s when flag off", async () => {
  delete process.env.JOBOPS_MCP_ENABLED;
  // build app; POST /mcp -> 404
});
it("401s without a valid key when flag on", async () => {
  process.env.JOBOPS_MCP_ENABLED = "true";
  // POST /mcp with initialize body, no auth -> 401
});
it("answers initialize with a valid API key", async () => {
  // create user + key (Task 1-2 helpers); POST /mcp initialize
  // Accept: "application/json, text/event-stream" header REQUIRED
  // expect 200 and result.serverInfo.name === "jobops"
});
```

- [ ] **Step 3: Implement stateless mount** (per-request server+transport is the SDK's documented stateless pattern):

```ts
// orchestrator/src/server/mcp/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type express from "express";
import { resolveBearerContext } from "@server/app-auth"; // wherever Step-interface lift lands
import { registerAllTools } from "./framework";

export function mountMcp(app: express.Express): void {
  if (process.env.JOBOPS_MCP_ENABLED !== "true") return;
  app.post("/mcp", express.json({ limit: "4mb" }), async (req, res) => {
    const ctx = await resolveBearerContext(req);
    if (!ctx) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }
    const server = new McpServer({ name: "jobops", version: "1.0.0" });
    const bearerKey = (req.headers.authorization ?? "").slice("Bearer ".length).trim();
    registerAllTools(server, {
      bearerKey,
      baseUrl: `http://localhost:${process.env.PORT || 3001}`,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get("/mcp", (_req, res) => res.status(405).end());
  app.delete("/mcp", (_req, res) => res.status(405).end());
}
```

`registerAllTools` is a stub for now: `export function registerAllTools(_s: McpServer, _ctx: ToolContext): void {}` in `./framework.ts`. Wire `mountMcp(app)` in `app.ts` BEFORE the SPA catch-all. If the SDK import paths differ in the installed version, follow the SDK README's streamableHttp stateless example - the shape above is the contract.

- [ ] **Step 4: PASS, biome, tsc, commit** `feat(mcp): gated /mcp mount with API-key auth`.

---

### Task 6: Tool framework (self-call + registration + coverage type)

**Files:**
- Create: `orchestrator/src/server/mcp/framework.ts` (replacing stub)
- Test: `orchestrator/src/server/mcp/framework.test.ts`

**Interfaces (used by every domain task):**

```ts
export type ToolContext = { bearerKey: string; baseUrl: string };

export type ToolDef = {
  name: string;                 // jobops_<domain>_<verb>
  description: string;
  inputSchema: z.ZodRawShape;   // zod shape, NOT z.object()
  coverage: string[];           // e.g. ["GET /api/jobs", "POST /api/jobs/:id/status"]
  readOnly?: boolean;           // default false
  destructive?: boolean;        // default false
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
};

export function selfCall(
  ctx: ToolContext,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,                                  // concrete path, query included
  body?: unknown,
): Promise<unknown>;  // resolves envelope.data; throws Error with
                      // message `${error.code}: ${error.message} (requestId=...)`
                      // on ok:false or non-2xx; 60s AbortSignal timeout

export function getAllToolDefs(): ToolDef[];     // aggregates all domain arrays
export function registerAllTools(server: McpServer, ctx: ToolContext): void;
```

- [ ] **Step 1: Failing tests** for `selfCall` (spin a tiny express server in-test that returns ok/fail envelopes; assert data unwrap, error propagation with code+requestId, auth header forwarding) and for `registerAllTools` (registers every def; readOnly maps to `annotations.readOnlyHint`, destructive to `destructiveHint`).
- [ ] **Step 2: FAIL. Step 3: Implement**:

```ts
export async function selfCall(ctx, method, path, body?) {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.bearerKey}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => null)) as {
    ok?: boolean; data?: unknown;
    error?: { code?: string; message?: string };
    meta?: { requestId?: string };
  } | null;
  if (!json || json.ok !== true) {
    const code = json?.error?.code ?? `http_${res.status}`;
    const message = json?.error?.message ?? res.statusText;
    const requestId = json?.meta?.requestId ?? "unknown";
    throw new Error(`${code}: ${message} (requestId=${requestId})`);
  }
  return json.data;
}

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  for (const def of getAllToolDefs()) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: {
          readOnlyHint: def.readOnly === true,
          destructiveHint: def.destructive === true,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const data = await def.handler(args, ctx);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: (error as Error).message }],
          };
        }
      },
    );
  }
}
```

`getAllToolDefs` imports each `./tools/<domain>` array and concats; starts empty and grows per domain task: `export function getAllToolDefs(): ToolDef[] { return [...jobsTools, ...pipelineTools, /* one spread per domain file */]; }`

- [ ] **Step 4: PASS, biome, commit** `feat(mcp): tool framework with self-call dispatch`.

---

### Task 7: Jobs domain tools (canonical exemplar)

**Files:**
- Create: `orchestrator/src/server/mcp/tools/jobs.ts`
- Modify: `orchestrator/src/server/mcp/framework.ts` (spread `jobsTools`)
- Test: `orchestrator/src/server/mcp/tools/jobs.test.ts`

**Interfaces:** Produces `export const jobsTools: ToolDef[]`. Before writing tools, READ `orchestrator/src/server/api/routes/jobs/*.ts` and enumerate every route (method, path, params, body). The tool set below is the target shape; adjust paths/params to what the routes actually declare (the coverage test in Task 15 is the completeness authority, not this table):

| Tool | readOnly | Covers (adjust to actual routes) |
|---|---|---|
| `jobops_jobs_list` | yes | `GET /api/jobs` with query passthrough params: `status?`, `search?`, `limit?`, `offset?`, `sort?` |
| `jobops_job_get` | yes | `GET /api/jobs/:id` (+ any read sub-resources routes expose, e.g. emails: `GET /api/jobs/:id/emails`) |
| `jobops_job_update` | no | job mutation routes in `mutations.ts` (status transitions, field edits) - single tool, `action` enum param |
| `jobops_job_notes` | no | notes list/create/update/delete routes - `action: "list"\|"add"\|"update"\|"delete"` |
| `jobops_job_stages` | no | stage routes in `stages.ts` - `action` enum |
| `jobops_job_documents` | mixed -> no | `documents.ts` routes; binary download endpoints return `{ url }` instead of bytes |
| `jobops_job_application` | no | `application.ts` routes |
| `jobops_job_actions` | no | `actions.ts` routes (retailor, re-score, regenerate PDF etc.) - `action` enum |
| `jobops_jobs_maintenance` | destructive | `maintenance.ts` routes (bulk delete/expire) |

Every tool: zod shape with `.describe()` on each field; description sentence naming the underlying REST paths.

Example (full pattern, repeat for each row):

```ts
import { z } from "zod";
import { selfCall, type ToolDef } from "../framework";

export const jobsTools: ToolDef[] = [
  {
    name: "jobops_jobs_list",
    description:
      "List jobs with optional filters. Wraps GET /api/jobs.",
    readOnly: true,
    coverage: ["GET /api/jobs"],
    inputSchema: {
      status: z.string().optional().describe("Filter by job status"),
      search: z.string().optional().describe("Free-text search"),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
    handler: (args, ctx) => {
      const qs = new URLSearchParams(
        Object.entries(args).filter(([, v]) => v !== undefined) as [string, string][],
      ).toString();
      return selfCall(ctx, "GET", `/api/jobs${qs ? `?${qs}` : ""}`);
    },
  },
  // ... one entry per table row
];
```

- [ ] **Step 1: Failing integration test**: boot the real app (route-test bootstrap + `JOBOPS_MCP_ENABLED=true`), create user+key, call `tools/list` (expect all jobs tool names) and call `jobops_jobs_list` end-to-end via a `tools/call` POST to `/mcp`; expect a JSON array in content (empty db is fine).
- [ ] **Step 2: FAIL. Step 3: Implement all table rows. Step 4: PASS, biome, commit** `feat(mcp): jobs domain tools`.

---

### Task 8: Remaining domain tools (7 sibling tasks, same recipe as Task 7)

Execute as separate commits, one per file. For EACH: read the route file(s) first, enumerate routes, build consolidated ToolDefs exactly per the Task 7 pattern (zod shapes, coverage strings, readOnly/destructive flags, selfCall handlers), add the spread to `getAllToolDefs`, add a `tools/list` + one `tools/call` integration test mirroring `jobs.test.ts`.

- [ ] **8a `tools/pipeline.ts`**: `jobops_pipeline_run` (POST start; returns run id immediately), `jobops_pipeline_status` (GET status/progress - the SSE stream endpoint is EXCLUDED, polling replaces it), `jobops_pipeline_cancel`, `jobops_pipeline_presets` (CRUD via action enum), `jobops_pipeline_history`. Routes: `pipeline.ts`.
- [ ] **8b `tools/ghostwriter.ts`**: `jobops_chat_threads` (list/get), `jobops_chat_send`, `jobops_chat_runs` (status). Routes: `ghostwriter.ts` (mounted at `/api/jobs/:id/chat`).
- [ ] **8c `tools/design-resume.ts`**: `jobops_resume_get`, `jobops_resume_update` (full resume_json put/patch), `jobops_resume_render` (returns `{ url }` for PDF), `jobops_resume_assets` (list/delete; binary upload EXCLUDED with reason "multipart upload unsupported over MCP v1"). Routes: `design-resume.ts`.
- [ ] **8d `tools/profile-settings.ts`**: `jobops_profile_get`, `jobops_profile_projects`, `jobops_settings_get`, `jobops_settings_set`, `jobops_codex_auth_status`. Routes: `profile.ts`, `settings.ts` (codex-auth secrets stay redacted by the route layer - verify test asserts no token material in output).
- [ ] **8e `tools/watchlist.ts`**: `jobops_watchlist_sources` (list/select), `jobops_watchlist_check` (trigger + results), `jobops_watchlist_jobs` (seen/state/import). Routes: `watchlist.ts`, `manual-jobs.ts` -> also `jobops_manual_job_create`, `jobops_manual_job_infer`.
- [ ] **8f `tools/post-application.ts`**: `jobops_postapp_providers` (list/config status), `jobops_postapp_review` (queue list/decide), `jobops_postapp_sync` (trigger/status). Routes: `post-application-providers.ts`, `post-application-review.ts`. Plus `jobops_workday_import` for `workday.ts`.
- [ ] **8g `tools/misc.ts`**: `jobops_app_status` (app-status + extractor-health), `jobops_visa_sponsors_search`, `jobops_tracer_links` (list/create/stats), `jobops_backups` (list/create/restore - restore is destructive), `jobops_workspaces` (list/current), `jobops_whoami` (`GET /api/auth/me`), `jobops_api_keys` (list/create/revoke via Task 3 endpoints).

Commit each: `feat(mcp): <domain> tools`.

---

### Task 9: Coverage contract test (the full-coverage gate)

**Files:**
- Create: `orchestrator/src/server/mcp/coverage.test.ts`

**Interfaces:** Consumes `getAllToolDefs()` and the express `apiRouter`.

- [ ] **Step 1: Write the test** (it should FAIL if any endpoint is unclaimed - that is its job; fix claims until green):

```ts
import { describe, expect, it } from "vitest";
import { apiRouter } from "@server/api/routes";
import { getAllToolDefs } from "./framework";

// Reconstruct "METHOD /api/<path>" strings from the express 4 router tree.
type Layer = {
  route?: { path: string; methods: Record<string, boolean> };
  name: string;
  handle: { stack?: Layer[] };
  regexp: RegExp & { fast_slash?: boolean };
};

function mountPathOf(layer: Layer): string {
  if (layer.regexp.fast_slash) return "";
  // express encodes the mount path in the regexp; recover param segments
  const src = layer.regexp.source
    .replace("\\/?(?=\\/|$)", "")
    .replace(/^\^/, "")
    .replace(/\$\/?$/, "")
    .replace(/\\\//g, "/")
    .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, ":param");
  return src;
}

function walk(stack: Layer[], prefix: string, out: string[]): void {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        out.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
      }
    } else if (layer.name === "router" && layer.handle.stack) {
      walk(layer.handle.stack, prefix + mountPathOf(layer), out);
    }
  }
}

const EXCLUDED: Record<string, string> = {
  "POST /api/auth/login": "session bootstrap - not an agent operation",
  "POST /api/auth/logout": "session bootstrap",
  "POST /api/auth/signup": "session bootstrap",
  "POST /api/auth/setup": "session bootstrap",
  "GET /api/auth/bootstrap-status": "session bootstrap",
  "POST /api/webhook/trigger": "external webhook contract",
  // + demo info, stats proxy, binary asset/PDF streams (tools return URLs),
  // SSE progress stream (replaced by jobops_pipeline_status polling).
  // EVERY entry needs a reason string. Grow this list deliberately, not to
  // silence failures.
};

it("every /api endpoint is covered by a tool or excluded with a reason", () => {
  const endpoints: string[] = [];
  walk((apiRouter as unknown as { stack: Layer[] }).stack, "/api", endpoints);
  // Normalize express param names (:id, :slug...) to :param on BOTH sides
  const normalize = (s: string) =>
    s.replace(/:[A-Za-z0-9_]+/g, ":param").replace(/\/+$/, "");
  const claimed = new Set(
    getAllToolDefs().flatMap((t) => t.coverage.map(normalize)),
  );
  const excluded = new Set(Object.keys(EXCLUDED).map(normalize));
  const missing = [...new Set(endpoints.map(normalize))].filter(
    (e) => !claimed.has(e) && !excluded.has(e),
  );
  expect(missing, `Uncovered endpoints:\n${missing.join("\n")}`).toEqual([]);
});

it("coverage claims refer to real endpoints (no typos)", () => {
  const endpoints: string[] = [];
  walk((apiRouter as unknown as { stack: Layer[] }).stack, "/api", endpoints);
  const normalize = (s: string) =>
    s.replace(/:[A-Za-z0-9_]+/g, ":param").replace(/\/+$/, "");
  const real = new Set(endpoints.map(normalize));
  const bogus = getAllToolDefs()
    .flatMap((t) => t.coverage)
    .map(normalize)
    .filter((c) => !real.has(c));
  expect(bogus).toEqual([]);
});
```

If the regexp reconstruction proves brittle against this codebase's actual mounts (e.g. `/jobs/:id/chat`), fall back to also walking `app._router` from a constructed app - but get the two assertions above green against the REAL router, not a fixture.

- [ ] **Step 2: Run; enumerate real gaps; fix by adding coverage entries/tools/justified exclusions until green.**
- [ ] **Step 3: Commit** `test(mcp): enforce full endpoint coverage`.

---

### Task 10: Tenant isolation test + docs + deploy config

**Files:**
- Test: `orchestrator/src/server/mcp/tenant-isolation.test.ts`
- Create: `docs-site/docs/features/mcp-server.md` (copy frontmatter/structure from an existing feature page per AGENTS.md; content: what it is, enabling `JOBOPS_MCP_ENABLED`, minting a key in Settings, Claude Code client config example with `type: "http"`, url `https://<host>/mcp`, `Authorization: Bearer <key>` header)
- Modify: `.env.example` (if not done in Task 5), `README`-adjacent docs only if AGENTS.md demands

**Steps:**
- [ ] **Step 1: Isolation test**: two users in two workspaces (use the tenancy fixtures from `tenant-isolation.test.ts` in routes/ as the template); user A creates a job via REST; user B's API key calling `jobops_jobs_list` over `/mcp` must NOT see it; B's key revoked -> `/mcp` 401.
- [ ] **Step 2: PASS. Step 3: Write docs page. Step 4: Commit** `docs(mcp): feature page + env example`.
- [ ] **Step 5 (deploy, infra repo - separate commit there):** add `JOBOPS_MCP_ENABLED: "true"` to `app.env` in the helm launch values (`scratchpad/launch/launch-values.yaml` for now; chart values comment). NOT part of this repo's commits.

---

### Task 11: Full CI-parity gate

- [ ] From repo root: `./orchestrator/node_modules/.bin/biome ci .`
- [ ] `cd shared && ../orchestrator/node_modules/.bin/tsc --noEmit` (or the repo's `check:types:shared` equivalent without npm: `./node_modules/.bin/tsc -p shared` - inspect root package.json for the actual tsconfig target)
- [ ] `cd orchestrator && ./node_modules/.bin/tsc --noEmit`
- [ ] `cd orchestrator && ./node_modules/.bin/vitest run`
- [ ] `cd orchestrator && ./node_modules/.bin/vite build`
- [ ] Fix everything; final commit `chore(mcp): CI parity green`.

## Self-Review Notes

- Spec coverage: schema/repo (T1), guard (T2), key endpoints (T3), UI (T4), mount+flag (T5), framework/self-call/errors (T6), ~45 tools (T7-8), coverage gate (T9), isolation+docs+deploy flag (T10), CI parity (T11). SSE-as-polling: T8a. Plaintext-once: T3/T4. No-secrets-in-output: T8d test.
- Deliberate deferrals: exact tool/param shapes bend to the real route files (read-first instruction per domain task); T9 is the completeness authority. This is by design in the approved spec ("coverage map is the correctness mechanism").
- Type consistency: `ToolDef`/`ToolContext`/`selfCall`/`getAllToolDefs` defined once (T6), consumed by T7-T9 with identical signatures.
