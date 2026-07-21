# JobOps MCP Server - Design

Date: 2026-07-20
Status: Approved (design); implementation pending
Owner: Wes Gilleland (Deathnerd/job-ops fork; structured for upstream PR)

## Purpose

Expose the full functionality of JobOps to AI agents via an MCP server, so agents can manage jobs, run pipelines, edit resumes, and query application state without kubectl/SQL surgery. Consumers: agents on the operator's laptop (via the public Cloudflare-Access-gated ingress) and in-cluster agents (direct HTTP).

## Requirements

- Full functional coverage of the `/api/*` surface (~149 endpoints across 26 route modules), consolidated into ~45 domain tools - not 1:1 endpoint mapping.
- Per-user API-key auth (featmap-fork pattern); in-cluster callers bypass Cloudflare Access, so the app enforces auth itself.
- Upstreamable: AGENTS.md `/api/*` contract respected, docs-site page, full tests, feature gated behind an env flag defaulting to off.
- Transport: Streamable HTTP mounted in the existing express app at `/mcp`. No new deployable, no sidecar.

## Rejected alternatives

- Service-layer MCP (tools call services in-process): faster calls, but every tool must manually reconstruct tenancy context and route guards; one missed check is a cross-tenant leak.
- OpenAPI spec + generated bridge (FastMCP OpenAPI, mcp-openapi-proxy): no spec exists; would produce 1:1 tools and an extra sidecar.

## Architecture

- New module `orchestrator/src/server/mcp/` using `@modelcontextprotocol/sdk` (official TS SDK).
- Mounted at `/mcp` in `app.ts`, Streamable HTTP transport in stateless mode - every request carries `Authorization: Bearer <api-key>`; no MCP session state.
- Feature flag: `JOBOPS_MCP_ENABLED=true` enables the mount; absent/false leaves upstream behavior untouched. Enabled in the homelab helm launch values.
- Tools are thin dispatchers that self-call `http://localhost:<PORT>/api/...` forwarding the caller's bearer key. Route middleware (auth, tenancy scoping, demo-mode, redaction) therefore applies to MCP traffic identically to REST traffic. The localhost hop is accepted overhead.
- SSE endpoints (pipeline progress) are not streamed over MCP; polling tools expose run status instead.

## Auth: per-user API keys

- New table `api_keys`: `id, user_id, name, key_hash (SHA-256 of a UUIDv4 key), created_at, last_used_at, revoked_at`. Drizzle schema + migration.
- Key lifecycle: minted and revoked via new `/api/auth/api-keys` endpoints (list/create/revoke) and a Settings UI card. Plaintext key shown exactly once at creation.
- `createAuthGuard.getAuthorizationContext` extended: if the Bearer value fails JWT verification, hash it and look it up in `api_keys` (not revoked, user not disabled) and resolve the same `{userId, tenantId, username, isSystemAdmin}` context. Update `last_used_at` (throttled).
- Effect: API keys authenticate plain REST calls too, not just MCP. This is a standalone upstreamable capability.
- `/mcp` requires a valid key before any MCP handling; unauthenticated requests get 401 with no MCP payload.

## Tool inventory (consolidated, ~45 tools)

Domains mirror the route modules. Naming: `jobops_<domain>_<verb>`. Sub-actions collapse into enum params where natural (e.g. `jobops_job_update` takes `{status? notes? stage?}`). Mutating tools carry MCP `readOnlyHint: false` annotations; destructive ones (delete, db maintenance) carry `destructiveHint`.

| Domain | ~Tools | Covers |
|---|---|---|
| jobs | 10 | list/search/get, status transitions, notes, stages, documents, actions, emails, tailoring |
| pipeline | 5 | start run, run status (polling), cancel, presets, history |
| ghostwriter | 3 | chat threads/messages, generate |
| design-resume | 5 | get/update resume JSON, revisions, assets, render PDF |
| profile | 3 | profile get/status, projects |
| watchlist | 5 | sources, checks, seen/selected state, import drafts |
| manual-jobs | 2 | create/import manual jobs |
| settings | 4 | get/set settings, codex auth status, extractor config |
| post-application | 3 | providers, review queue, sync runs |
| workspaces + auth | 3 | workspace list/switch, api-key management, whoami |
| misc (app-status, visa-sponsors, tracer-links, backups, workday, extractor-health) | ~6 | one tool each |

Exact tool list is finalized during implementation planning; the coverage map (below) is the correctness mechanism, not this table.

## Coverage enforcement (the "full coverage" gate)

- Each tool declares `coverage: ["GET /api/jobs", "POST /api/jobs/:id/status", ...]`.
- A contract test (pattern from `extractors/deployment.test.ts`) walks the express router at test time, enumerates every registered `/api/*` route, and fails if any route is neither claimed by a tool's coverage map nor listed in an explicit exclusion list with a reason.
- Expected exclusions: auth login/logout/signup/setup (session bootstrap), webhook trigger (external contract), asset/PDF binary streaming where a tool returns a URL instead, stats proxy, demo-info.
- Result: adding a REST endpoint without MCP coverage fails CI. Coverage stays true mechanically.

## Error handling

- Tools parse the standard envelope `{ ok, data, error, meta.requestId }`. Non-ok responses become MCP tool errors carrying `error.code`, `error.message`, and `requestId` for log correlation.
- Self-call timeouts (default 60s; pipeline start returns immediately, status is polled) map to a distinct timeout error.
- No secrets in tool output: responses pass through the routes' existing redaction; tools add no logging of their own beyond the shared logger with requestId.

## Testing

- Unit/integration (vitest, orchestrator workspace): api-key auth (valid, revoked, disabled user, wrong tenant), key lifecycle endpoints, cross-tenant isolation through a tool call, coverage contract test, end-to-end `/mcp` initialize + tools/list + a representative tool call per domain via supertest.
- CI parity: biome, `check:types` (all workspaces), `build:client`, `test:run` must pass.

## Docs and deployment

- docs-site feature page per AGENTS.md frontmatter/structure rules (setup, minting a key, client config examples for Claude Code).
- No helm chart change (same port/ingress). `JOBOPS_MCP_ENABLED` + docs added to the homelab launch values; operator key later captured into Bitwarden.

## Out of scope

- MCP resources/prompts (tools only, v1).
- Streaming pipeline progress over MCP.
- OAuth for MCP clients; API keys only.
- Upstream PR submission itself (separate step after the fork proves it).
