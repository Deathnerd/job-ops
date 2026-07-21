---
id: mcp-server
title: MCP Server
description: Give an AI agent authenticated access to your JobOps workspace over the Model Context Protocol.
sidebar_position: 15
---

## What it is

The MCP server exposes your JobOps workspace to AI agents (Claude Code, Claude Desktop, or any Model Context Protocol client) over a single endpoint: `POST /mcp`.

It is a thin tool layer over the same `/api/*` surface the web UI uses -- every tool call authenticates the same way as a REST request and is scoped to the calling user's workspace exactly like the UI is. It does not add any capability the API doesn't already have, and it does not bypass tenant isolation: an agent acting on your behalf only ever sees your jobs, your profile, and your settings.

## Why it exists

JobOps already has a full `/api/*` surface. The MCP server makes that surface usable by an agent directly -- searching jobs, updating stages, drafting ghostwriter replies, reading watchlist results -- without the agent having to reverse-engineer REST endpoints or hold a raw JWT. Tool names, descriptions, and input schemas are the contract an MCP client reads to know what it can do and how to call it safely.

## How to use it

### 1. Enable the server

The `/mcp` route is gated behind an environment flag and returns 404 for every method when it is off. Set in your JobOps environment:

```bash
JOBOPS_MCP_ENABLED=true
```

Restart the orchestrator for the flag to take effect.

### 2. Mint an API key

1. Open **Settings -> API Keys** in the JobOps UI.
2. Enter a name for the key and click **Create key**.
3. Copy the plaintext key immediately -- it is shown exactly once. JobOps only ever stores a hash of it, so it cannot be retrieved again. Store it in a password manager or secret store (fnox, Bitwarden, etc.).

A JWT session token also works as a bearer credential for `/mcp`, but an API key is the recommended credential for a long-running agent since it does not expire on a fixed schedule and can be revoked independently of your login session.

### 3. Configure your MCP client

**Claude Code (CLI):**

```bash
claude mcp add --transport http jobops https://<your-host>/mcp --header "Authorization: Bearer <key>"
```

**Claude Code / Claude Desktop (JSON config):**

```json
{
  "mcpServers": {
    "jobops": {
      "type": "http",
      "url": "https://<your-host>/mcp",
      "headers": {
        "Authorization": "Bearer <key>"
      }
    }
  }
}
```

Replace `<your-host>` with your JobOps instance's URL and `<key>` with the API key from step 2.

### Tools by domain

Tools are grouped by the `/api/*` area they wrap, one tool file per domain, roughly one tool per route file with action-enum dispatch inside each:

- **Jobs** (`jobops_jobs_list`, `jobops_job_get`, `jobops_job_update`, `jobops_job_notes`, `jobops_job_stages`, `jobops_job_documents`, `jobops_job_application`, `jobops_job_actions`, `jobops_jobs_maintenance`) -- list, read, update, and manage individual jobs: notes, stage transitions, documents/PDFs, application status, and bulk actions.
- **Pipeline** (`jobops_pipeline_run`, `jobops_pipeline_status`, `jobops_pipeline_cancel`, `jobops_pipeline_presets`, `jobops_pipeline_search_plan`, `jobops_pipeline_history`) -- start/resume/cancel a search-and-score run, manage saved search presets, and read run history.
- **Ghostwriter** (`jobops_chat_threads`, `jobops_chat_send`, `jobops_chat_runs`) -- the per-job chat used to draft outreach and tailoring copy.
- **Design Resume** (`jobops_resume_get`, `jobops_resume_update`, `jobops_resume_render`, `jobops_resume_assets`) -- read/edit the resume document, import from Reactive Resume, and render a PDF.
- **Profile & Settings** (`jobops_profile_get`, `jobops_profile_projects`, `jobops_settings_get`, `jobops_settings_set`, `jobops_codex_auth`) -- the candidate profile used for scoring/tailoring and workspace-level settings.
- **Watchlist** (`jobops_watchlist_sources`, `jobops_watchlist_check`, `jobops_watchlist_jobs`, `jobops_manual_job_create`, `jobops_manual_job_infer`) -- company career-source tracking and manual job import.
- **Post-Application** (`jobops_postapp_providers`, `jobops_postapp_sync`, `jobops_postapp_review`, `jobops_workday_import`) -- Gmail tracking-inbox review and Workday application import.
- **Misc** (`jobops_app_status`, `jobops_visa_sponsors_search`, `jobops_tracer_links`, `jobops_backups`, `jobops_workspaces`, `jobops_whoami`, `jobops_api_keys`, `jobops_database_clear`, `jobops_onboarding_status`, `jobops_onboarding_actions`) -- everything else: app health, visa-sponsor search, tracer links, backups, workspace user admin, identity, API-key management, and onboarding.

Call `tools/list` on the MCP endpoint for the exact, current input schema of every tool -- this page is a map, not the source of truth.

### Streaming endpoints become polling tools

MCP tool calls are single JSON-RPC responses, not a stream a client can consume incrementally. Any `/api/*` route that streams over Server-Sent Events (bulk job actions, pipeline progress) has a non-streaming equivalent route that a tool wraps instead -- for example `jobops_pipeline_status`'s `progress` action polls the same underlying state a UI progress bar reads, and `jobops_job_actions` covers the same bulk-action capability as its SSE variant. Poll the tool instead of expecting a push.

## Common problems

### `/mcp` returns 404

`JOBOPS_MCP_ENABLED` is not set to `true`, or the orchestrator hasn't been restarted since it was set.

### `/mcp` returns 401

The bearer credential is missing, malformed, expired (JWT), or revoked (API key). Mint a fresh API key in **Settings -> API Keys** and update your client config.

### A tool call returns data for the wrong jobs, or nothing at all

It shouldn't -- every tool call is scoped to the workspace the bearer credential belongs to, the same as a REST call with that credential would be. If you are testing with multiple workspace users, confirm you are using the API key that belongs to the user whose data you expect to see.

### I don't see a tool for a route I need

Check `tools/list` first -- most `/api/*` routes are covered, often folded into a broader action-enum tool rather than given a 1:1 tool name. A small number of routes (SSE streams, raw binary downloads, and a couple of timeout-infeasible long-running actions) are intentionally excluded; contributors enforce this with a coverage contract test (`orchestrator/src/server/mcp/coverage.test.ts`) that fails CI if a route is neither wrapped by a tool nor explicitly excluded with a reason.

## Related pages

- [Settings](/docs/next/features/settings)
- [Orchestrator](/docs/next/features/orchestrator)
- [Self-Hosting](/docs/next/getting-started/self-hosting)
