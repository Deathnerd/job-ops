# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

JobOps: a self-hostable job-hunting app. It scrapes 10+ job boards, AI-scores jobs against a user profile, tailors CVs per job (Typst/Reactive Resume PDF export), and tracks applications via Gmail. It does not auto-apply.

**Read `AGENTS.md` before touching server routes/services** -- it defines the mandatory `/api/*` response contract (`{ ok, data/error, meta.requestId }`), status/code mapping, request-ID propagation, logger/SSE helper usage, redaction rules, and multi-tenancy defaults. Those standards are not repeated here.

## Commands

npm workspaces monorepo (Node 22, Volta-pinned). Run from repo root.

```bash
npm ci                                          # install
npm --workspace orchestrator run db:migrate     # migrate SQLite db (required before first dev run)
npm --workspace orchestrator run dev            # dev: server (tsx watch, :3001) + client (vite, :5173)
npm run docs:dev                                # docs site (:3006)
```

Tests (Vitest, orchestrator workspace):

```bash
npm --workspace orchestrator run test:run                          # full suite
npm --workspace orchestrator run test:run -- src/server/pipeline/cancellation.test.ts   # single file
npm --workspace orchestrator rebuild better-sqlite3                # fix Node ABI mismatch failures
```

CI-parity checks -- all must pass before considering a change valid:

```bash
./orchestrator/node_modules/.bin/biome ci .     # lint + format (Biome, not ESLint/Prettier)
npm run check:types:shared
npm --workspace orchestrator run check:types
npm --workspace gradcracker-extractor run check:types
npm --workspace ukvisajobs-extractor run check:types
npm --workspace orchestrator run build:client
npm --workspace orchestrator run test:run
```

Other: `npm run typst-theme:generate` / `typst-theme:validate` (resume themes), `npm run knip` (dead code), `docker compose up -d` (full stack on :3005).

## Architecture

Workspaces: `orchestrator` (the app), `shared` (cross-workspace domain logic, published internally as `job-ops-shared`), `extractors/*` (one workspace per job board), `docs-site` (Docusaurus), plus data-only dirs `career-boards/` and `visa-sponsor-providers/`.

### Orchestrator (`orchestrator/src`)

Single workspace containing both halves of the app:

- `src/server/` -- TypeScript API server (run via tsx, no build step). Key areas:
  - `pipeline/` -- the core search->score->tailor pipeline; `orchestrator.ts` drives `steps/`, progress streams over SSE.
  - `extractors/` -- spawns extractor workspaces as subprocesses and reads their manifests; `deployment.test.ts` asserts every extractor is wired into Docker/compose.
  - `watchlist/adapters/` -- adapter registry for company career-board sources (Workday etc.); UI copy, dedupe, job identity, and import drafts all derive from the adapter. Curated company catalogs live in `server/config/career-boards-*.json`.
  - `db/` -- Drizzle ORM + better-sqlite3; schema in `schema.ts`, migrations via `db:migrate`.
  - `services/resume-renderer/typst-themes/` -- folder-per-theme Typst resume themes (`theme.json` + `main.typ`); regenerate shared metadata with `typst-theme:generate` after edits.
  - `infra/` -- shared logger and SSE helpers (mandatory in core paths, per AGENTS.md).
  - `repositories/`, `tenancy/`, `auth/` -- data access and multi-tenant/workspace scoping.
- `src/client/` -- React + Vite + Tailwind 4 + Radix/shadcn-style components, TanStack Query. Client SSE plumbing lives in `client/lib/sse.ts`.

### Extractors (`extractors/*`)

Each extractor is a tiny standalone workspace: `manifest.ts` (declares the source) + `src/main.ts` (entrypoint, run with tsx), depending on `job-ops-shared` for types. The orchestrator discovers and runs them as child processes. Adding one requires updating `docker-compose.yml` watch entries, all relevant `Dockerfile` stages, and `deployment.test.ts` -- otherwise it appears in settings but fails at runtime inside the container. The `jobspy` extractor (LinkedIn/Indeed/Glassdoor) shells out to Python; it needs a one-time venv at `extractors/jobspy/.venv` (auto-detected).

### Shared (`shared/src`)

Domain logic used by both orchestrator and extractors: job matching/scoring, location intelligence, ghostwriter context builders, settings registry/schema, visa-sponsor data. Changes here require `check:types:shared` and can affect every workspace.

## Conventions

- Biome for lint/format (config at repo-root `biome.json`); do not introduce ESLint/Prettier.
- Server code has no build step -- tsx runs TypeScript directly; only the client is bundled (Vite).
- User-visible behavior changes require matching `docs-site/docs` updates (feature-page structure and frontmatter rules in AGENTS.md).
- Releases are cut via the GitHub Actions `release` workflow, never by hand-editing versions; app version displayed in the UI comes from `orchestrator/package.json`.
