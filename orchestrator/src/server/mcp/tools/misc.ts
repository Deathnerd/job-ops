/**
 * Misc domain MCP tools -- Task 8g, the FINAL remainder sweep. Wraps every
 * `/api/*` route not already covered by an earlier domain tool file (jobs,
 * pipeline, ghostwriter, design-resume, profile-settings, watchlist,
 * post-application), one tool per source route file except where noted, via
 * `selfCall`.
 *
 * Route -> tool grouping (40 routes total across 11 route files; 33
 * covered, 7 excluded -- see `MISC_DOMAIN_EXCLUSIONS` below for the full
 * exclusion list with categories and justification, consumed by Task 9's
 * route-coverage contract test):
 *
 *  - `jobops_app_status` -- `GET /api/app/status` (action "app_status",
 *    default) and `GET /api/:source/health` (action "extractor_health",
 *    `app-status.ts` + `extractor-health.ts`, 2 routes). Both are public,
 *    no-auth routes at the Express layer (see `isPublicReadOnlyRoute` in
 *    app.ts), but still worth a real MCP tool -- an agent driving JobOps
 *    over MCP wants the same status/health signal a human gets from the UI,
 *    through the same authenticated tool surface as everything else.
 *    `readOnly: true`.
 *  - `jobops_visa_sponsors_search` -- `visa-sponsors.ts` (5 routes, all
 *    covered): `POST /api/visa-sponsors/search` (action "search", default),
 *    `GET /api/visa-sponsors/status` (action "status"), `GET
 *    /api/visa-sponsors/organization/:name` (action "organization"), and
 *    `POST /api/visa-sponsors/update[/:providerId]` (action "update",
 *    `providerId` optional -- omit to refresh every registered provider, or
 *    supply the enum id to target one). Not `readOnly` ("update" mutates
 *    on-disk provider data) and not `destructive` (no delete-capable route
 *    here -- "update" re-downloads/replaces a provider's sponsor CSV, same
 *    non-destructive "refresh" shape as `jobops_profile_get`'s "refresh"
 *    action).
 *  - `jobops_tracer_links` -- `tracer-links.ts` (3 routes, all covered):
 *    `GET /api/tracer-links/analytics` (action "analytics", default), `GET
 *    /api/tracer-links/readiness` (action "readiness"), and `GET
 *    /api/tracer-links/jobs/:jobId` (action "job_analytics"). Note: the
 *    original task-brief bullet described this file as "list/create/stats"
 *    but the actual route file has no create/write route at all -- it is
 *    3 read-only analytics/readiness endpoints, so the tool models the real
 *    surface instead of the brief's guess. `readOnly: true`.
 *  - `jobops_backups` -- `backup.ts` (3 routes, all covered): `GET
 *    /api/backups` (action "list"), `POST /api/backups` (action "create"),
 *    and `DELETE /api/backups/:filename` (action "delete"). Note: the
 *    brief bullet named the third action "restore", but the route file has
 *    no restore endpoint -- the actual destructive operation is deleting a
 *    stored backup file, so `destructive: true` covers "delete" instead.
 *    Every route in this file is gated server-side on `isSystemAdmin()`
 *    (403 for non-admins); the tool does not duplicate that check -- it
 *    surfaces the route's own 403 via `selfCall`'s error path.
 *  - `jobops_workspaces` -- `workspaces.ts` (5 routes, all covered): `GET
 *    /api/workspaces/users` (action "list_users"), `POST
 *    /api/workspaces/users` (action "create_user"), `PATCH
 *    /api/workspaces/users/:id/disabled` (action "set_user_disabled"),
 *    `POST /api/workspaces/users/:id/reset-password` (action
 *    "reset_user_password"), and `POST /api/workspaces/me/password` (action
 *    "change_own_password"). Note: despite the "/workspaces" path and the
 *    brief bullet's guess of "list/current", this route file is entirely
 *    user-administration (create/disable/reset-password for other users,
 *    change-own-password for the caller) -- there is no workspace
 *    list/current-workspace concept in this route file at all, so the tool
 *    models the real user-admin surface under that name instead.
 *    `destructive: true`: no route here issues a SQL DELETE, but
 *    "reset_user_password" force-revokes every one of the target user's
 *    existing auth sessions (`authSessionsRepo.revokeAuthSessionsForUser`)
 *    and "set_user_disabled" can lock a user out entirely -- both are
 *    irreversible-in-effect account actions, the same "clears/revokes real
 *    state" bar `jobops_codex_auth`'s "disconnect" and
 *    `jobops_postapp_providers`'s "disconnect" precedents already set for
 *    `destructive: true` without a literal delete. Every mutating action
 *    except "change_own_password" is gated server-side on `isSystemAdmin()`.
 *  - `jobops_whoami` -- `GET /api/auth/me` only, from `auth.ts`. `readOnly:
 *    true`.
 *  - `jobops_api_keys` -- `GET /api/auth/api-keys` (action "list"), `POST
 *    /api/auth/api-keys` (action "create"), and `POST
 *    /api/auth/api-keys/:id/revoke` (action "revoke"), from `auth.ts`.
 *    `destructive: true`: "revoke" soft-deletes the key
 *    (`UPDATE ... SET revokedAt = ...`, `repositories/api-keys.ts`) -- same
 *    delete-capable bar as `jobs.ts`'s destructive tools, just a
 *    revocation-flag delete instead of a row delete. SECURITY: "create"
 *    returns the plaintext key exactly once (the route's own contract --
 *    the stored row only ever keeps a hash) -- the tool description tells
 *    callers to store it immediately, and no test in this file logs it
 *    beyond a single assertion against the create response.
 *  - `jobops_database_clear` -- `DELETE /api/database` only, from
 *    `database.ts`. `destructive: true` (deletes every job and pipeline
 *    run). FOLLOW-UP FIX (post-8g): this route originally had no
 *    `isSystemAdmin()` gate at all, unlike every other admin-sensitive route
 *    in this sweep -- fixed by adding the same `requireSystemAdmin` gate
 *    `backup.ts` uses (403 `FORBIDDEN` for non-admins); the tool description
 *    now says so.
 *  - `jobops_onboarding_status` -- `GET /api/onboarding/status` only, from
 *    `onboarding.ts`. `readOnly: true`.
 *  - `jobops_onboarding_actions` -- the remaining 9 routes in
 *    `onboarding.ts`: `POST /api/onboarding/actions/profile` (action
 *    "profile"), `POST /api/onboarding/actions/model` (action "model"),
 *    `POST /api/onboarding/actions/resume/confirm` (action
 *    "resume_confirm"), `POST /api/onboarding/actions/rxresume` (action
 *    "rxresume"), `POST /api/onboarding/validate/openrouter` (action
 *    "validate_openrouter"), `POST /api/onboarding/validate/llm` (action
 *    "validate_llm"), `POST /api/onboarding/validate/rxresume` (action
 *    "validate_rxresume"), `GET /api/onboarding/validate/resume` (action
 *    "validate_resume"), and `POST /api/onboarding/search-terms/suggest`
 *    (action "suggest_search_terms"). For "rxresume": the route infers a
 *    `hasRxresumeBaseResumeId` flag from whether the JSON body included
 *    that key AT ALL (even as `null`), not from its value -- this tool's
 *    handler relies on `omitUndefined` only ever stripping `undefined`
 *    (never a real `null`) so an explicit `null` from the caller still
 *    reaches the route and preserves that "field was present" signal,
 *    matching the `jobops_job_stages` "outcome" `Object.hasOwn` precedent.
 *    Not `readOnly` (most actions mutate onboarding/settings state) and not
 *    `destructive` (no delete-capable route in this group).
 *
 * See `MISC_DOMAIN_EXCLUSIONS` for every `/api/*` route intentionally left
 * uncovered, with category + reasoning. See
 * `MISC_NON_API_ROUTES_DOCUMENTATION_ONLY` for two bonus non-`/api` routes
 * noted for completeness -- NOT consumed by Task 9's coverage contract test,
 * since the route walk it runs is scoped to `apiRouter` and would never see
 * these regardless.
 */

import { EXTRACTOR_SOURCE_IDS } from "@shared/extractors";
import { VISA_SPONSOR_PROVIDER_IDS } from "@shared/visa-sponsor-providers";
import { z } from "zod";
import { selfCall, type ToolDef } from "../framework";

function toQueryString(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    qs.set(key, String(value));
  }
  const suffix = qs.toString();
  return suffix ? `?${suffix}` : "";
}

function omitUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  );
}

function requireField<T>(
  args: Record<string, unknown>,
  key: string,
  action: string,
): T {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`"${key}" is required for action "${action}"`);
  }
  return value as T;
}

/**
 * Every `/api/*` (plus one non-API) route intentionally left uncovered by
 * this file, categorized for Task 9's route-coverage contract test. Every
 * category name here matches the task-8-brief's expected exclusion
 * categories verbatim.
 */
export const MISC_DOMAIN_EXCLUSIONS: ReadonlyArray<{
  route: string;
  category: string;
  reason: string;
}> = [
  {
    route: "POST /api/auth/signup",
    category: "auth-bootstrap",
    reason:
      "Creates the FIRST hosted-tenant credential -- calling it requires no prior authentication by design (it IS how auth begins). An MCP tool call already requires a valid bearer credential to reach the server at all, so this route is structurally unreachable from an authenticated MCP session in any meaningful way, and exposing it would let an already-authenticated caller mint unrelated accounts.",
  },
  {
    route: "POST /api/auth/login",
    category: "auth-bootstrap",
    reason:
      "Exchanges username/password for a JWT -- the credential-issuing step that precedes having any bearer token to call MCP with at all. Same structural reason as signup: an MCP session already has a working bearer credential (JWT or API key) by the time any tool call happens.",
  },
  {
    route: "GET /api/auth/bootstrap-status",
    category: "auth-bootstrap",
    reason:
      "Reports whether first-run setup (POST /api/auth/setup) still needs to happen. Only meaningful before any user exists, i.e. before an MCP bearer credential could exist either -- same bootstrap-only lifecycle as signup/login/setup.",
  },
  {
    route: "POST /api/auth/setup",
    category: "auth-bootstrap",
    reason:
      "Creates the very first system-admin user on a fresh instance. Same reasoning as signup/login: this precedes the existence of any credential an MCP call could authenticate with.",
  },
  {
    route: "POST /api/auth/logout",
    category: "auth-bootstrap",
    reason:
      'Blacklists the JWT sent in its own Authorization header. Grouped with the other auth-lifecycle routes per the task brief -- an MCP tool call authenticates via `selfCall`\'s own bearer key wired in at server startup (see `ToolContext`), not a session-scoped JWT an agent is holding and might want to invalidate; there is no meaningful "log this MCP session out" operation to expose.',
  },
  {
    route: "GET /api/demo/info",
    category: "public-bootstrap",
    reason:
      'Explicitly allow-listed as a public, no-auth route in `isPublicReadOnlyRoute` (app.ts) -- static, low-value "is this the public demo" metadata with no parameters and no action an agent would take differently based on the answer. Named directly in the task brief as excluded (contrast with `jobops_app_status`, which IS covered despite also being public -- app/extractor health is operationally useful to an agent in a way demo-mode flavor text is not).',
  },
  {
    route: "POST /api/webhook/trigger",
    category: "external-contract",
    reason:
      "This is n8n's (or any external scheduler's) integration point for triggering a pipeline run out-of-band -- authenticated by a separate `WEBHOOK_SECRET` bearer scheme, not this server's user/API-key auth, and callable from outside the app entirely. `jobops_pipeline_run` (pipeline.ts, Task 8a) already covers \"start a pipeline run\" for MCP callers; this route is the external system's contract, not a redundant second path to expose here.",
  },
];

/**
 * Bonus/out-of-scope notes, not one of the brief's named exclusion
 * categories and NOT part of the `/api/*` contract `MISC_DOMAIN_EXCLUSIONS`
 * documents: none of these routes are mounted under `apiRouter` (routes.ts)
 * at all, so Task 9's coverage-contract test (which walks `apiRouter`
 * only) would never see them regardless of whether they're listed here.
 * Kept purely as documentation of routes a reader might otherwise wonder
 * about -- deliberately a SEPARATE constant from `MISC_DOMAIN_EXCLUSIONS`
 * so it can never accidentally get spread into the map the coverage test
 * actually consumes.
 */
export const MISC_NON_API_ROUTES_DOCUMENTATION_ONLY: ReadonlyArray<{
  route: string;
  category: string;
  reason: string;
}> = [
  {
    route: "ALL /stats/* (app.ts, not under /api)",
    category: "upstream-analytics",
    reason:
      "A raw byte-for-byte reverse proxy to the self-hosted Umami analytics instance (`getUmamiUpstreamUrl`, streamed response body, non-JSON, no `{ ok, data }` envelope) -- not a JobOps API route at all, and not something an MCP tool could usefully wrap without inventing a second, parallel analytics API. Named directly in the task brief as an expected exclusion.",
  },
  {
    route: "GET /health (app.ts, not under /api)",
    category: "non-api-utility",
    reason:
      "A bare liveness probe, not mounted under `apiRouter`, with nothing for an MCP tool to usefully return beyond a 200.",
  },
  {
    route: "GET /cv/:slug (app.ts, not under /api)",
    category: "non-api-utility",
    reason:
      "HTML/redirect passthrough for a human's browser (tracer-link redirect resolution), not mounted under `apiRouter` and not a JSON API call.",
  },
  {
    route: "ALL /challenge-viewer/session (app.ts, not under /api)",
    category: "non-api-utility",
    reason:
      "Cloudflare-challenge-solving viewer UI passthrough for a human's browser, not mounted under `apiRouter` and not a JSON API call.",
  },
];

export const miscTools: ToolDef[] = [
  {
    name: "jobops_app_status",
    description:
      "Fetch overall JobOps app status, or check one extractor source's live health. Wraps GET /api/app/status and GET /api/:source/health.",
    readOnly: true,
    coverage: ["GET /api/app/status", "GET /api/:source/health"],
    inputSchema: {
      action: z
        .enum(["app_status", "extractor_health"])
        .optional()
        .describe(
          '"app_status" (default) fetches overall app mode/config status; "extractor_health" checks one extractor source\'s live health',
        ),
      source: z
        .enum(EXTRACTOR_SOURCE_IDS)
        .optional()
        .describe(
          'Extractor source id (required for action "extractor_health")',
        ),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "app_status";
      if (action === "extractor_health") {
        const source = requireField<string>(args, "source", "extractor_health");
        return selfCall(ctx, "GET", `/api/${source}/health`);
      }
      return selfCall(ctx, "GET", "/api/app/status");
    },
  },
  {
    name: "jobops_visa_sponsors_search",
    description:
      "Search visa sponsor providers, check provider status, look up an organization's sponsor entries, or trigger a provider data refresh. Wraps POST /api/visa-sponsors/search, GET /api/visa-sponsors/status, GET /api/visa-sponsors/organization/:name, and POST /api/visa-sponsors/update[/:providerId].",
    coverage: [
      "POST /api/visa-sponsors/search",
      "GET /api/visa-sponsors/status",
      "GET /api/visa-sponsors/organization/:name",
      "POST /api/visa-sponsors/update",
      "POST /api/visa-sponsors/update/:providerId",
    ],
    inputSchema: {
      action: z
        .enum(["search", "status", "organization", "update"])
        .optional()
        .describe(
          '"search" (default) searches sponsors by query; "status" reports per-provider status; "organization" fetches one organization\'s entries; "update" refreshes provider data',
        ),
      query: z
        .string()
        .min(1)
        .optional()
        .describe('Search query (required for action "search")'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Max results ("search" only)'),
      minScore: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('Minimum match score 0-100 ("search" only)'),
      country: z
        .string()
        .optional()
        .describe(
          'Restrict "search" to a specific provider by country (e.g. "uk", "nl")',
        ),
      name: z
        .string()
        .min(1)
        .optional()
        .describe('Organization name (required for action "organization")'),
      providerId: z
        .enum(VISA_SPONSOR_PROVIDER_IDS)
        .optional()
        .describe(
          'Provider id filter ("organization"); or target provider for "update" (omit to refresh every registered provider)',
        ),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "search";

      if (action === "status") {
        return selfCall(ctx, "GET", "/api/visa-sponsors/status");
      }
      if (action === "organization") {
        const name = requireField<string>(args, "name", "organization");
        const qs = toQueryString({ providerId: args.providerId });
        return selfCall(
          ctx,
          "GET",
          `/api/visa-sponsors/organization/${encodeURIComponent(name)}${qs}`,
        );
      }
      if (action === "update") {
        const providerId = args.providerId as string | undefined;
        const path = providerId
          ? `/api/visa-sponsors/update/${providerId}`
          : "/api/visa-sponsors/update";
        return selfCall(ctx, "POST", path);
      }

      const query = requireField<string>(args, "query", "search");
      const body = omitUndefined({
        query,
        limit: args.limit,
        minScore: args.minScore,
        country: args.country,
      });
      return selfCall(ctx, "POST", "/api/visa-sponsors/search", body);
    },
  },
  {
    name: "jobops_tracer_links",
    description:
      "Read tracer-link analytics, readiness status, or one job's tracer-link analytics. Wraps GET /api/tracer-links/analytics, GET /api/tracer-links/readiness, and GET /api/tracer-links/jobs/:jobId.",
    readOnly: true,
    coverage: [
      "GET /api/tracer-links/analytics",
      "GET /api/tracer-links/readiness",
      "GET /api/tracer-links/jobs/:jobId",
    ],
    inputSchema: {
      action: z
        .enum(["analytics", "readiness", "job_analytics"])
        .optional()
        .describe(
          '"analytics" (default) reports aggregate tracer-link analytics; "readiness" reports whether tracer links are ready to serve; "job_analytics" reports one job\'s tracer-link analytics',
        ),
      jobId: z
        .string()
        .optional()
        .describe(
          'Job id (required for "job_analytics"; optional filter for "analytics")',
        ),
      from: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Unix seconds range start ("analytics"/"job_analytics")'),
      to: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Unix seconds range end ("analytics"/"job_analytics")'),
      includeBots: z
        .boolean()
        .optional()
        .describe(
          'Include bot-classified hits ("analytics"/"job_analytics", default false)',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Max rows returned ("analytics" only)'),
      force: z
        .boolean()
        .optional()
        .describe('Force a fresh readiness check ("readiness" only)'),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "analytics";

      if (action === "readiness") {
        const qs = toQueryString({ force: args.force });
        return selfCall(ctx, "GET", `/api/tracer-links/readiness${qs}`);
      }
      if (action === "job_analytics") {
        const jobId = requireField<string>(args, "jobId", "job_analytics");
        const qs = toQueryString({
          from: args.from,
          to: args.to,
          includeBots: args.includeBots,
        });
        return selfCall(ctx, "GET", `/api/tracer-links/jobs/${jobId}${qs}`);
      }

      const qs = toQueryString({
        jobId: args.jobId,
        from: args.from,
        to: args.to,
        includeBots: args.includeBots,
        limit: args.limit,
      });
      return selfCall(ctx, "GET", `/api/tracer-links/analytics${qs}`);
    },
  },
  {
    name: "jobops_backups",
    description:
      "List, create, or delete database backups. Wraps GET /api/backups, POST /api/backups, and DELETE /api/backups/:filename. Every operation requires system-admin access -- the route itself returns 403 for non-admin callers.",
    destructive: true,
    coverage: [
      "GET /api/backups",
      "POST /api/backups",
      "DELETE /api/backups/:filename",
    ],
    inputSchema: {
      action: z
        .enum(["list", "create", "delete"])
        .describe("Which backup operation to perform"),
      filename: z
        .string()
        .min(1)
        .optional()
        .describe('Backup filename (required for action "delete")'),
    },
    handler: (args, ctx) => {
      const action = requireField<string>(args, "action", "backups");

      if (action === "list") {
        return selfCall(ctx, "GET", "/api/backups");
      }
      if (action === "create") {
        return selfCall(ctx, "POST", "/api/backups");
      }
      if (action === "delete") {
        const filename = requireField<string>(args, "filename", "delete");
        return selfCall(
          ctx,
          "DELETE",
          `/api/backups/${encodeURIComponent(filename)}`,
        );
      }
      throw new Error(`Unknown backups action: ${action}`);
    },
  },
  {
    name: "jobops_workspaces",
    description:
      'Administer user accounts: list users, create one, enable/disable one, force-reset a user\'s password, or change your own password. Wraps GET /api/workspaces/users, POST /api/workspaces/users, PATCH /api/workspaces/users/:id/disabled, POST /api/workspaces/users/:id/reset-password, and POST /api/workspaces/me/password. Every action except "change_own_password" requires system-admin access -- the route itself returns 403 for non-admin callers.',
    destructive: true,
    coverage: [
      "GET /api/workspaces/users",
      "POST /api/workspaces/users",
      "PATCH /api/workspaces/users/:id/disabled",
      "POST /api/workspaces/users/:id/reset-password",
      "POST /api/workspaces/me/password",
    ],
    inputSchema: {
      action: z
        .enum([
          "list_users",
          "create_user",
          "set_user_disabled",
          "reset_user_password",
          "change_own_password",
        ])
        .describe("Which user-administration operation to perform"),
      id: z
        .string()
        .optional()
        .describe(
          'Target user id (required for "set_user_disabled" and "reset_user_password")',
        ),
      username: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe('Username (required for "create_user")'),
      password: z
        .string()
        .min(8)
        .max(500)
        .optional()
        .describe(
          'New password, 8-500 chars (required for "create_user", "reset_user_password", and "change_own_password")',
        ),
      displayName: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe(
          'Display name ("create_user" only; defaults to username if omitted)',
        ),
      isSystemAdmin: z
        .boolean()
        .optional()
        .describe(
          'Grant system-admin privileges ("create_user" only, default false)',
        ),
      isDisabled: z
        .boolean()
        .optional()
        .describe('Target disabled state (required for "set_user_disabled")'),
    },
    handler: (args, ctx) => {
      const action = requireField<string>(args, "action", "workspaces");

      if (action === "list_users") {
        return selfCall(ctx, "GET", "/api/workspaces/users");
      }
      if (action === "create_user") {
        const username = requireField<string>(args, "username", "create_user");
        const password = requireField<string>(args, "password", "create_user");
        const body = omitUndefined({
          username,
          password,
          displayName: args.displayName,
          isSystemAdmin: args.isSystemAdmin,
        });
        return selfCall(ctx, "POST", "/api/workspaces/users", body);
      }
      if (action === "set_user_disabled") {
        const id = requireField<string>(args, "id", "set_user_disabled");
        if (args.isDisabled === undefined) {
          throw new Error(
            '"isDisabled" is required for action "set_user_disabled"',
          );
        }
        return selfCall(ctx, "PATCH", `/api/workspaces/users/${id}/disabled`, {
          isDisabled: args.isDisabled,
        });
      }
      if (action === "reset_user_password") {
        const id = requireField<string>(args, "id", "reset_user_password");
        const password = requireField<string>(
          args,
          "password",
          "reset_user_password",
        );
        return selfCall(
          ctx,
          "POST",
          `/api/workspaces/users/${id}/reset-password`,
          { password },
        );
      }
      if (action === "change_own_password") {
        const password = requireField<string>(
          args,
          "password",
          "change_own_password",
        );
        return selfCall(ctx, "POST", "/api/workspaces/me/password", {
          password,
        });
      }
      throw new Error(`Unknown workspaces action: ${action}`);
    },
  },
  {
    name: "jobops_whoami",
    description:
      "Fetch the authenticated caller's user identity and analytics distinct id. Wraps GET /api/auth/me.",
    readOnly: true,
    coverage: ["GET /api/auth/me"],
    inputSchema: {},
    handler: (_args, ctx) => selfCall(ctx, "GET", "/api/auth/me"),
  },
  {
    name: "jobops_api_keys",
    description:
      'List, create, or revoke this account\'s API keys. Wraps GET /api/auth/api-keys, POST /api/auth/api-keys, and POST /api/auth/api-keys/:id/revoke. SECURITY: action "create" returns the plaintext key exactly once in its response -- the server only ever stores a hash, so this is the only chance to see it. Store it immediately (password manager, fnox/Bitwarden secret, etc.); it cannot be retrieved again.',
    destructive: true,
    coverage: [
      "GET /api/auth/api-keys",
      "POST /api/auth/api-keys",
      "POST /api/auth/api-keys/:id/revoke",
    ],
    inputSchema: {
      action: z
        .enum(["list", "create", "revoke"])
        .describe("Which API-key operation to perform"),
      name: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .optional()
        .describe('Label for the new key (required for action "create")'),
      id: z
        .string()
        .optional()
        .describe('API key id (required for action "revoke")'),
    },
    handler: (args, ctx) => {
      const action = requireField<string>(args, "action", "api_keys");

      if (action === "list") {
        return selfCall(ctx, "GET", "/api/auth/api-keys");
      }
      if (action === "create") {
        const name = requireField<string>(args, "name", "create");
        return selfCall(ctx, "POST", "/api/auth/api-keys", { name });
      }
      if (action === "revoke") {
        const id = requireField<string>(args, "id", "revoke");
        return selfCall(ctx, "POST", `/api/auth/api-keys/${id}/revoke`);
      }
      throw new Error(`Unknown api_keys action: ${action}`);
    },
  },
  {
    name: "jobops_database_clear",
    description:
      "Permanently delete every job and pipeline run from the database. Wraps DELETE /api/database. Requires a system-admin account or API key -- the route returns 403 for non-admin callers. There is no undo short of restoring an earlier backup (see jobops_backups) -- use with extreme caution.",
    destructive: true,
    coverage: ["DELETE /api/database"],
    inputSchema: {},
    handler: (_args, ctx) => selfCall(ctx, "DELETE", "/api/database"),
  },
  {
    name: "jobops_onboarding_status",
    description:
      "Fetch the current first-run onboarding status: completed and outstanding setup steps. Wraps GET /api/onboarding/status.",
    readOnly: true,
    coverage: ["GET /api/onboarding/status"],
    inputSchema: {},
    handler: (_args, ctx) => selfCall(ctx, "GET", "/api/onboarding/status"),
  },
  {
    name: "jobops_onboarding_actions",
    description:
      "Complete an onboarding step (profile, LLM model, resume confirmation, RxResume link) or validate a credential (OpenRouter, generic LLM, RxResume, local resume config), or suggest search terms. Wraps POST /api/onboarding/actions/profile, POST /api/onboarding/actions/model, POST /api/onboarding/actions/resume/confirm, POST /api/onboarding/actions/rxresume, POST /api/onboarding/validate/openrouter, POST /api/onboarding/validate/llm, POST /api/onboarding/validate/rxresume, GET /api/onboarding/validate/resume, and POST /api/onboarding/search-terms/suggest.",
    coverage: [
      "POST /api/onboarding/actions/profile",
      "POST /api/onboarding/actions/model",
      "POST /api/onboarding/actions/resume/confirm",
      "POST /api/onboarding/actions/rxresume",
      "POST /api/onboarding/validate/openrouter",
      "POST /api/onboarding/validate/llm",
      "POST /api/onboarding/validate/rxresume",
      "GET /api/onboarding/validate/resume",
      "POST /api/onboarding/search-terms/suggest",
    ],
    inputSchema: {
      action: z
        .enum([
          "profile",
          "model",
          "resume_confirm",
          "rxresume",
          "validate_openrouter",
          "validate_llm",
          "validate_rxresume",
          "validate_resume",
          "suggest_search_terms",
        ])
        .describe("Which onboarding operation to perform"),
      country: z
        .string()
        .max(100)
        .nullable()
        .optional()
        .describe('Home country, or null to clear ("profile" only)'),
      cities: z
        .array(z.string().trim().min(1).max(120))
        .max(20)
        .optional()
        .describe('Preferred cities, up to 20 (required for "profile")'),
      workplaceTypes: z
        .array(z.enum(["remote", "hybrid", "onsite"]))
        .min(1)
        .max(3)
        .optional()
        .describe('Acceptable workplace types, 1-3 (required for "profile")'),
      requiresVisaSponsorship: z
        .boolean()
        .optional()
        .describe(
          'Whether visa sponsorship is required (required for "profile")',
        ),
      provider: z
        .string()
        .trim()
        .max(100)
        .nullable()
        .optional()
        .describe(
          'LLM provider id, or null to clear ("model"); plain provider name ("validate_llm")',
        ),
      baseUrl: z
        .string()
        .trim()
        .max(2000)
        .nullable()
        .optional()
        .describe(
          'Custom base URL, or null to clear ("model", "rxresume", "validate_llm", "validate_rxresume")',
        ),
      apiKey: z
        .string()
        .trim()
        .max(2000)
        .nullable()
        .optional()
        .describe(
          'API key, or null to clear ("model", "rxresume"); plain API key to validate ("validate_openrouter", "validate_llm", "validate_rxresume")',
        ),
      model: z
        .string()
        .trim()
        .max(200)
        .nullable()
        .optional()
        .describe('Model id, or null to clear ("model" only)'),
      rxresumeBaseResumeId: z
        .string()
        .trim()
        .max(200)
        .nullable()
        .optional()
        .describe(
          'RxResume base resume id, or null to clear ("rxresume" only)',
        ),
      source: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .optional()
        .describe('Confirmed resume source (required for "resume_confirm")'),
    },
    handler: (args, ctx) => {
      const action = requireField<string>(args, "action", "onboarding_actions");

      if (action === "profile") {
        const cities = requireField<string[]>(args, "cities", "profile");
        const workplaceTypes = requireField<string[]>(
          args,
          "workplaceTypes",
          "profile",
        );
        if (args.requiresVisaSponsorship === undefined) {
          throw new Error(
            '"requiresVisaSponsorship" is required for action "profile"',
          );
        }
        const body = omitUndefined({
          country: args.country,
          cities,
          workplaceTypes,
          requiresVisaSponsorship: args.requiresVisaSponsorship,
        });
        return selfCall(ctx, "POST", "/api/onboarding/actions/profile", body);
      }
      if (action === "model") {
        const body = omitUndefined({
          provider: args.provider,
          baseUrl: args.baseUrl,
          apiKey: args.apiKey,
          model: args.model,
        });
        return selfCall(ctx, "POST", "/api/onboarding/actions/model", body);
      }
      if (action === "resume_confirm") {
        const source = requireField<string>(args, "source", "resume_confirm");
        return selfCall(ctx, "POST", "/api/onboarding/actions/resume/confirm", {
          source,
        });
      }
      if (action === "rxresume") {
        // omitUndefined only strips `undefined` -- an explicit `null` for
        // rxresumeBaseResumeId survives into the body, which is required to
        // preserve the route's own hasRxresumeBaseResumeId-from-key-presence
        // signal (see onboarding.ts).
        const body = omitUndefined({
          apiKey: args.apiKey,
          baseUrl: args.baseUrl,
          rxresumeBaseResumeId: args.rxresumeBaseResumeId,
        });
        return selfCall(ctx, "POST", "/api/onboarding/actions/rxresume", body);
      }
      if (action === "validate_openrouter") {
        const body = omitUndefined({ apiKey: args.apiKey });
        return selfCall(
          ctx,
          "POST",
          "/api/onboarding/validate/openrouter",
          body,
        );
      }
      if (action === "validate_llm") {
        const body = omitUndefined({
          apiKey: args.apiKey,
          provider: args.provider,
          baseUrl: args.baseUrl,
        });
        return selfCall(ctx, "POST", "/api/onboarding/validate/llm", body);
      }
      if (action === "validate_rxresume") {
        const body = omitUndefined({
          apiKey: args.apiKey,
          baseUrl: args.baseUrl,
        });
        return selfCall(ctx, "POST", "/api/onboarding/validate/rxresume", body);
      }
      if (action === "validate_resume") {
        return selfCall(ctx, "GET", "/api/onboarding/validate/resume");
      }
      if (action === "suggest_search_terms") {
        return selfCall(ctx, "POST", "/api/onboarding/search-terms/suggest");
      }
      throw new Error(`Unknown onboarding_actions action: ${action}`);
    },
  },
];
