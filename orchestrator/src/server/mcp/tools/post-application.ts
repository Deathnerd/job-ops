/**
 * Post-application + Workday domain MCP tools -- wraps the routes mounted at
 * `/api/post-application`
 * (`orchestrator/src/server/api/routes/post-application-providers.ts` and
 * `post-application-review.ts`) and `/api/workday`
 * (`orchestrator/src/server/api/routes/workday.ts`) via `selfCall`.
 *
 * Route -> tool grouping (15 logical actions total across the three files,
 * 14 covered, 1 excluded -- counted at coverage-string granularity: the
 * generic `POST /providers/:provider/actions/:action` dispatcher is 1
 * physical route but 4 logical actions (connect/status/sync/disconnect),
 * each listed separately in the `coverage` arrays below):
 *
 * post-application-providers.ts (6 logical actions: 2 dedicated OAuth
 * routes + 4 sub-actions of the generic dispatcher route; 5 covered, 1
 * excluded):
 *  - `jobops_postapp_providers` -- `GET /api/post-application/providers/gmail/oauth/start`
 *    (action "oauth_start"), `POST
 *    /api/post-application/providers/gmail/oauth/exchange` (action
 *    "oauth_exchange"), and `POST
 *    /api/post-application/providers/:provider/actions/:action` for the
 *    "connect"/"status"/"disconnect" sub-actions (actions "connect",
 *    "status", "disconnect" -- see EXCLUSION below for "sync"). "oauth_start"
 *    is a device/OAuth-style flow that returns a relayable
 *    `authorizationUrl` for a human to complete in a browser (2026-07
 *    codex-auth precedent: covered, not auth-bootstrap-excluded).
 *    "oauth_exchange" consumes the `code`+`state` a human reads back out of
 *    the browser's address bar after completing that consent (the redirect
 *    target is the app's own client-rendered `/oauth/gmail/callback` page,
 *    not an external callback endpoint Google calls directly -- so this is
 *    a normal, human-completable API call, not an external-contract
 *    endpoint). `destructive: true`: "disconnect" clears the integration's
 *    stored credentials (UPDATE ... SET credentials = NULL, not a DELETE,
 *    but functionally destroys the stored refresh token exactly like
 *    `jobops_codex_auth`'s "disconnect" precedent) and revokes the token
 *    with Google when one is on file.
 *
 * DEVIATION from the task brief's suggested shape ("jobops_postapp_providers
 * (list/config status)" + a separate "jobops_postapp_sync (trigger/status)"):
 * there is no dedicated "list providers" route (`POST_APPLICATION_PROVIDERS`
 * is just a fixed `["gmail", "imap"]` enum, not a queryable catalog) and no
 * dedicated OAuth-flow tool in the brief's shape, so both live here instead,
 * grouped with the other single-provider config actions they belong next to
 * (jobs.ts precedent: one tool per route file/resource family, action-enum
 * dispatch inside).
 *
 * EXCLUSION -- timeout-infeasible: `POST
 * /api/post-application/providers/:provider/actions/:action` with
 * `action=sync` is NOT covered by any tool. `gmailProvider.sync` ->
 * `runGmailIngestionSync` is a single fully-synchronous await with no
 * per-call ceiling: it lists up to `maxMessages` (route cap: 500) Gmail
 * messages, then classifies each one that needs it through
 * `classifyWithSmartRouter`, which is a full LLM call per message (see
 * `email-router.ts`), bounded only by a concurrency-of-3 worker pool (no
 * per-item timeout wrapper analogous to watchlist's
 * `withWatchlistSourceTimeout`). Even at the route's DEFAULT params
 * (100 messages / 90 days, `DEFAULT_MAX_MESSAGES` / `DEFAULT_SEARCH_DAYS` in
 * `gmail-sync.ts`), ~34 sequential batches of Gmail API + LLM calls at
 * realistic per-call latency comfortably exceeds `selfCall`'s fixed 60s
 * timeout, and the route has no polling/run-id alternative (unlike
 * `jobops_pipeline_run`'s fire-and-forget design) -- the Express handler
 * blocks until the whole sync finishes before responding at all. Triggering
 * a sync is left to the web UI; `jobops_postapp_sync`'s "runs"/"run_messages"
 * actions below still let an agent read the results of a UI-triggered sync.
 *
 * post-application-review.ts (6 routes, all covered):
 *  - `jobops_postapp_sync` -- `GET /api/post-application/runs` (action
 *    "runs", default) and `GET /api/post-application/runs/:runId/messages`
 *    (action "run_messages"). `readOnly: true`. This is the "status" half
 *    of the brief's "trigger/status" pairing for sync -- "trigger" itself is
 *    excluded above.
 *  - `jobops_postapp_review` -- `GET /api/post-application/inbox` (action
 *    "list"), `POST /api/post-application/inbox/:messageId/approve` (action
 *    "approve"), `POST /api/post-application/inbox/:messageId/deny` (action
 *    "deny"), and `POST /api/post-application/inbox/actions` (action
 *    "bulk_decide", bulk-approves or bulk-denies every currently pending
 *    item). None of these four routes delete a row -- approve/deny only
 *    flip `processingStatus` on an existing message -- so this tool is not
 *    `destructive`.
 *
 * workday.ts (3 routes, all covered):
 *  - `jobops_workday_import` -- `POST /api/workday/fetch-jobs` (action
 *    "fetch_jobs"), `POST /api/workday/fetch-job-details` (action
 *    "fetch_job_details"), and `POST /api/workday/fetch-logo` (action
 *    "fetch_logo"). `readOnly: true`: despite the brief's "_import" name,
 *    none of these three routes persist anything -- they are read-only
 *    proxies over the Workday CXS API (each individually bounded to a 30s
 *    internal `AbortController` timeout, `WORKDAY_ROUTE_TIMEOUT_MS`, well
 *    under `selfCall`'s 60s ceiling), mirroring `jobops_manual_job_infer`'s
 *    "prep step, not a persist step" role -- feed "fetch_jobs"/
 *    "fetch_job_details" output into `jobops_manual_job_create`'s "create"
 *    action to actually import a job. "fetch_logo" returns a base64
 *    `imageDataUrl` (capped at 1MB upstream by `WORKDAY_LOGO_MAX_BYTES`) as
 *    structured JSON, not a raw binary stream, so it is not
 *    binary-excluded (same precedent as `jobops_job_documents`'
 *    `dataBase64` fields).
 *
 * SECURITY: every route wrapped here already redacts secret material at the
 * source, before this file ever sees a response.
 *  - `PostApplicationProviderActionResponse` (the shape every "connect"/
 *    "status"/"sync"/"disconnect" call returns) is `{ provider, action,
 *    accountKey, status, message? }` -- `status.integration.credentials` is
 *    built by each provider adapter's own redaction step
 *    (`gmailProvider`'s `toPublicIntegration`) into boolean flags
 *    (`hasRefreshToken`, `hasAccessToken`) plus non-secret metadata
 *    (`scope`, `tokenType`, `expiryDate`, `email`) -- the raw
 *    `refreshToken`/`accessToken` values are never serialized into any
 *    response this file's tools can produce, including "connect" (which
 *    accepts a caller-supplied credential payload as write-only input, same
 *    write-only pattern as `jobops_settings_set`'s secret fields, but never
 *    echoes it back).
 *  - `GET /providers/gmail/oauth/start` returns only `authorizationUrl` (a
 *    Google-hosted consent URL) and an opaque `state` token, never a
 *    credential.
 *  - `POST /providers/gmail/oauth/exchange` performs the token exchange with
 *    Google server-side and passes the resulting `refreshToken`/
 *    `accessToken` straight into `executePostApplicationProviderAction`'s
 *    "connect" action -- its HTTP response is that same redacted
 *    `PostApplicationProviderActionResponse`, never the raw token payload.
 *  - `post-application.test.ts` asserts this by connecting a fake Gmail
 *    credential through "connect" and scanning the full JSON-RPC response
 *    (via `JSON.stringify`) for the plaintext refresh token, both on the
 *    write itself and on the following "status" read.
 */

import {
  APPLICATION_STAGES,
  POST_APPLICATION_PROVIDERS,
  POST_APPLICATION_ROUTER_STAGE_TARGETS,
} from "@shared/types";
import { z } from "zod";
import { selfCall, type ToolDef } from "../framework";

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

function toQueryString(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    qs.set(key, String(value));
  }
  const suffix = qs.toString();
  return suffix ? `?${suffix}` : "";
}

export const postApplicationTools: ToolDef[] = [
  {
    name: "jobops_postapp_providers",
    description:
      'Check a post-application email provider\'s connection status, connect it (with caller-supplied credentials), disconnect (revoke) it, or run the Gmail OAuth consent flow. Wraps POST /api/post-application/providers/:provider/actions/status|connect|disconnect, GET /api/post-application/providers/gmail/oauth/start, and POST /api/post-application/providers/gmail/oauth/exchange. "oauth_start" returns a Google consent authorizationUrl to relay to a human; once they complete consent and land on the app\'s own callback page, relay the code+state query params it received back into "oauth_exchange" to finish connecting. Only "gmail" is implemented today -- "imap" always throws provider_not_implemented. Note: the live "sync" action of the underlying route is intentionally NOT exposed here (see jobops_postapp_sync for reading sync results, and the file header for why triggering a sync is excluded).',
    destructive: true,
    coverage: [
      "POST /api/post-application/providers/:provider/actions/status",
      "POST /api/post-application/providers/:provider/actions/connect",
      "POST /api/post-application/providers/:provider/actions/disconnect",
      "GET /api/post-application/providers/gmail/oauth/start",
      "POST /api/post-application/providers/gmail/oauth/exchange",
    ],
    inputSchema: {
      action: z
        .enum([
          "status",
          "connect",
          "disconnect",
          "oauth_start",
          "oauth_exchange",
        ])
        .optional()
        .describe(
          '"status" (default) checks connection status; "connect" persists caller-supplied credentials; "disconnect" revokes and clears stored credentials; "oauth_start" begins the Gmail OAuth consent flow and returns a URL to relay to a human; "oauth_exchange" completes it with the code+state the human read back from the browser',
        ),
      provider: z
        .enum(POST_APPLICATION_PROVIDERS)
        .optional()
        .describe(
          'Provider id (only used by "status"/"connect"/"disconnect"; "oauth_start"/"oauth_exchange" are Gmail-only by route design); defaults to "gmail" when omitted',
        ),
      accountKey: z
        .string()
        .min(1)
        .max(255)
        .optional()
        .describe(
          'Account key identifying this connection; defaults to "default"',
        ),
      payload: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Provider-specific credential payload (only used by "connect"), e.g. { refreshToken, accessToken, ... } for gmail; write-only -- never echoed back in any response',
        ),
      state: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Opaque state token from "oauth_start" (required for "oauth_exchange")',
        ),
      code: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Authorization code the human read back from the browser after completing Google consent (required for "oauth_exchange")',
        ),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "status";
      const provider = (args.provider as string | undefined) ?? "gmail";
      const accountKey = args.accountKey as string | undefined;

      if (action === "oauth_start") {
        const qs = toQueryString({ accountKey });
        return selfCall(
          ctx,
          "GET",
          `/api/post-application/providers/gmail/oauth/start${qs}`,
        );
      }
      if (action === "oauth_exchange") {
        const state = requireField<string>(args, "state", "oauth_exchange");
        const code = requireField<string>(args, "code", "oauth_exchange");
        const body = omitUndefined({ accountKey, state, code });
        return selfCall(
          ctx,
          "POST",
          "/api/post-application/providers/gmail/oauth/exchange",
          body,
        );
      }
      if (action === "connect") {
        const body = omitUndefined({ accountKey, payload: args.payload });
        return selfCall(
          ctx,
          "POST",
          `/api/post-application/providers/${provider}/actions/connect`,
          body,
        );
      }
      if (action === "disconnect") {
        const body = omitUndefined({ accountKey });
        return selfCall(
          ctx,
          "POST",
          `/api/post-application/providers/${provider}/actions/disconnect`,
          body,
        );
      }
      const body = omitUndefined({ accountKey });
      return selfCall(
        ctx,
        "POST",
        `/api/post-application/providers/${provider}/actions/status`,
        body,
      );
    },
  },
  {
    name: "jobops_postapp_sync",
    description:
      'List past post-application sync runs, or list the messages ingested by one specific run. Wraps GET /api/post-application/runs and GET /api/post-application/runs/:runId/messages. There is no "trigger" action here -- triggering a live sync is excluded as timeout-infeasible (see post-application.ts file header); this tool only reads the results of syncs triggered elsewhere (the web UI).',
    readOnly: true,
    coverage: [
      "GET /api/post-application/runs",
      "GET /api/post-application/runs/:runId/messages",
    ],
    inputSchema: {
      action: z
        .enum(["runs", "run_messages"])
        .optional()
        .describe(
          '"runs" (default) lists past sync runs; "run_messages" lists the messages ingested by one run',
        ),
      provider: z
        .enum(POST_APPLICATION_PROVIDERS)
        .optional()
        .describe('Provider id; defaults to "gmail"'),
      accountKey: z
        .string()
        .min(1)
        .max(255)
        .optional()
        .describe('Account key; defaults to "default"'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Max rows to return; server applies its own default when omitted",
        ),
      runId: z
        .string()
        .uuid()
        .optional()
        .describe('Sync run id (required for "run_messages")'),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "runs";
      const qsBase = {
        provider: args.provider,
        accountKey: args.accountKey,
        limit: args.limit,
      };

      if (action === "run_messages") {
        const runId = requireField<string>(args, "runId", "run_messages");
        const qs = toQueryString(qsBase);
        return selfCall(
          ctx,
          "GET",
          `/api/post-application/runs/${runId}/messages${qs}`,
        );
      }
      const qs = toQueryString(qsBase);
      return selfCall(ctx, "GET", `/api/post-application/runs${qs}`);
    },
  },
  {
    name: "jobops_postapp_review",
    description:
      "List the pending post-application review queue, approve or deny a single queued message, or bulk-approve/bulk-deny every currently pending message. Wraps GET /api/post-application/inbox, POST /api/post-application/inbox/:messageId/approve, POST /api/post-application/inbox/:messageId/deny, and POST /api/post-application/inbox/actions. Approving links the message's suggested (or caller-supplied) job and logs a stage-transition event; denying just marks the message ignored. Bulk decisions skip messages with no suggested job match (approve only) or that were already decided by another request.",
    coverage: [
      "GET /api/post-application/inbox",
      "POST /api/post-application/inbox/:messageId/approve",
      "POST /api/post-application/inbox/:messageId/deny",
      "POST /api/post-application/inbox/actions",
    ],
    inputSchema: {
      action: z
        .enum(["list", "approve", "deny", "bulk_decide"])
        .describe("Which review operation to perform"),
      provider: z
        .enum(POST_APPLICATION_PROVIDERS)
        .optional()
        .describe('Provider id; defaults to "gmail"'),
      accountKey: z
        .string()
        .min(1)
        .max(255)
        .optional()
        .describe('Account key; defaults to "default"'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Max rows to return (only used by "list")'),
      messageId: z
        .string()
        .uuid()
        .optional()
        .describe('Message id (required for "approve"/"deny")'),
      jobId: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Job id to link ("approve" only); falls back to the message\'s suggested match when omitted',
        ),
      stageTarget: z
        .enum(POST_APPLICATION_ROUTER_STAGE_TARGETS)
        .optional()
        .describe('Stage-transition target ("approve" only)'),
      toStage: z
        .enum(APPLICATION_STAGES)
        .optional()
        .describe(
          'Application stage to transition to ("approve" only); stageTarget takes precedence when both are given',
        ),
      note: z
        .string()
        .max(2000)
        .optional()
        .describe(
          'Free-text note attached to the stage event ("approve" only)',
        ),
      decidedBy: z
        .string()
        .max(255)
        .optional()
        .describe(
          'Who/what made this decision ("approve"/"deny"/"bulk_decide")',
        ),
      bulkAction: z
        .enum(["approve", "deny"])
        .optional()
        .describe(
          'Which decision to apply to every pending item (required for "bulk_decide")',
        ),
    },
    handler: (args, ctx) => {
      const action = requireField<string>(args, "action", "postapp_review");
      const provider = args.provider as string | undefined;
      const accountKey = args.accountKey as string | undefined;

      if (action === "list") {
        const qs = toQueryString({ provider, accountKey, limit: args.limit });
        return selfCall(ctx, "GET", `/api/post-application/inbox${qs}`);
      }
      if (action === "approve") {
        const messageId = requireField<string>(args, "messageId", "approve");
        const body = omitUndefined({
          provider,
          accountKey,
          jobId: args.jobId,
          stageTarget: args.stageTarget,
          toStage: args.toStage,
          note: args.note,
          decidedBy: args.decidedBy,
        });
        return selfCall(
          ctx,
          "POST",
          `/api/post-application/inbox/${messageId}/approve`,
          body,
        );
      }
      if (action === "deny") {
        const messageId = requireField<string>(args, "messageId", "deny");
        const body = omitUndefined({
          provider,
          accountKey,
          decidedBy: args.decidedBy,
        });
        return selfCall(
          ctx,
          "POST",
          `/api/post-application/inbox/${messageId}/deny`,
          body,
        );
      }
      if (action === "bulk_decide") {
        const bulkAction = requireField<string>(
          args,
          "bulkAction",
          "bulk_decide",
        );
        const body = omitUndefined({
          action: bulkAction,
          provider,
          accountKey,
          decidedBy: args.decidedBy,
        });
        return selfCall(
          ctx,
          "POST",
          "/api/post-application/inbox/actions",
          body,
        );
      }
      throw new Error(`Unknown postapp_review action: ${action}`);
    },
  },
  {
    name: "jobops_workday_import",
    description:
      'Fetch a Workday careers page\'s job list, one job\'s full details, or the company logo, all as a preparatory step for jobops_manual_job_create -- none of these three routes persist anything despite the "_import" name. Wraps POST /api/workday/fetch-jobs (action "fetch_jobs"), POST /api/workday/fetch-job-details (action "fetch_job_details"), and POST /api/workday/fetch-logo (action "fetch_logo"). Each is individually bounded to a 30s upstream timeout server-side.',
    readOnly: true,
    coverage: [
      "POST /api/workday/fetch-jobs",
      "POST /api/workday/fetch-job-details",
      "POST /api/workday/fetch-logo",
    ],
    inputSchema: {
      action: z
        .enum(["fetch_jobs", "fetch_job_details", "fetch_logo"])
        .describe("Which Workday operation to perform"),
      careersUrl: z
        .string()
        .trim()
        .url()
        .max(2000)
        .optional()
        .describe(
          'Workday careers page URL (required for "fetch_jobs"/"fetch_logo")',
        ),
      maxJobs: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(
          'Max jobs to fetch (only used by "fetch_jobs"); server defaults to 40',
        ),
      jobUrl: z
        .string()
        .trim()
        .url()
        .max(2000)
        .optional()
        .describe('Single job posting URL (required for "fetch_job_details")'),
    },
    handler: (args, ctx) => {
      const action = requireField<string>(args, "action", "workday_import");

      if (action === "fetch_jobs") {
        const careersUrl = requireField<string>(
          args,
          "careersUrl",
          "fetch_jobs",
        );
        const body = omitUndefined({ careersUrl, maxJobs: args.maxJobs });
        return selfCall(ctx, "POST", "/api/workday/fetch-jobs", body);
      }
      if (action === "fetch_job_details") {
        const jobUrl = requireField<string>(
          args,
          "jobUrl",
          "fetch_job_details",
        );
        return selfCall(ctx, "POST", "/api/workday/fetch-job-details", {
          jobUrl,
        });
      }
      if (action === "fetch_logo") {
        const careersUrl = requireField<string>(
          args,
          "careersUrl",
          "fetch_logo",
        );
        return selfCall(ctx, "POST", "/api/workday/fetch-logo", { careersUrl });
      }
      throw new Error(`Unknown workday_import action: ${action}`);
    },
  },
];
