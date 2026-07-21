/**
 * Watchlist + manual-jobs domain MCP tools -- wraps the routes mounted at
 * `/api/watchlist` (`orchestrator/src/server/api/routes/watchlist.ts`) and
 * `/api/manual-jobs` (`orchestrator/src/server/api/routes/manual-jobs.ts`)
 * via `selfCall`.
 *
 * Route -> tool grouping (13 routes total across both files, all 13
 * covered -- no exclusions):
 *
 * watchlist.ts (10 routes):
 *  - `jobops_watchlist_sources` -- `GET /api/watchlist/sources` (action
 *    "list", default), `PUT /api/watchlist/sources` (action "select"), and
 *    `POST /api/watchlist/source-branding` (action "branding"). "select"
 *    REPLACES the caller's entire selected-sources set in one transaction
 *    (`watchlistRepo.replaceWatchlistSelectedSources` deletes-then-inserts)
 *    -- any existing selection not included in the call is dropped, so the
 *    whole tool is `destructive: true` even though "list"/"branding" are
 *    pure reads (jobs.ts precedent: one delete-capable action makes the
 *    whole tool destructive). "branding" always requires `sourceType` +
 *    `careersUrl` in the body per the route's zod schema
 *    (`watchlistSourceBrandingSchema`), even when `selectedSourceId` is also
 *    given -- the route does NOT infer them from the selected source.
 *  - `jobops_watchlist_check` -- `POST /api/watchlist/results` (action
 *    "trigger") and `POST /api/watchlist/checks` (action "record"). Both
 *    write watchlist-check state; neither deletes anything, so this tool is
 *    not destructive. TIMEOUT ANALYSIS for "trigger" (per task brief: verify
 *    check-trigger routes aren't sync-blocking past 60s): `POST /results` ->
 *    `getCurrentWatchlistResults` -> `getWatchlistResultsForSources` fans out
 *    to every selected source's adapter via `Promise.all`
 *    (`watchlist/results.ts`), and each individual adapter call is wrapped in
 *    `withWatchlistSourceTimeout` at a fixed 30s
 *    (`WATCHLIST_SOURCE_TIMEOUT_MS`). Because sources are fetched
 *    CONCURRENTLY, not sequentially, worst-case wall time is ~30s regardless
 *    of how many sources are selected -- safely under `selfCall`'s 60s
 *    timeout. Covered directly rather than excluded as timeout-infeasible;
 *    no polling alternative exists for this route anyway (it is fully
 *    synchronous, no job id to poll). "record" is a thin, fast wrapper
 *    around `watchlistRepo.recordWatchlistCheck` with caller-supplied ids --
 *    no adapter/network involved at all.
 *  - `jobops_watchlist_jobs` -- `GET /api/watchlist/states` (action
 *    "list_states"), `PUT /api/watchlist/states/:source/:sourceJobId`
 *    (action "ignore"), `DELETE /api/watchlist/states/:source/:sourceJobId`
 *    (action "unignore"), `POST /api/watchlist/job-details` (action
 *    "get_details"), and `POST /api/watchlist/import-draft` (action
 *    "prepare_import"). "unignore" deletes a stored state row, so the whole
 *    tool is `destructive: true`. `source`/`sourceJobId` are
 *    percent-encoded into the path (matching the client's
 *    `encodeURIComponent` in `client/api/watchlist.ts`) since source ids can
 *    contain characters like `:` (e.g. `"workday:autodesk"`).
 *
 * manual-jobs.ts (3 routes):
 *  - `jobops_manual_job_create` -- `POST /api/manual-jobs/fetch` (action
 *    "fetch_url") and `POST /api/manual-jobs/import` (action "create").
 *    Folded into one tool (rather than a bare `jobops_manual_job_create`
 *    plus a separate fetch tool) because "fetch_url" is purely a
 *    preparatory step for "create" -- it extracts page content from a URL
 *    into free text, it does not persist anything. Not destructive: neither
 *    route deletes. "create" persists a job (and, unless `skipTailoring` is
 *    true or the `autoTailorOnManualImport` setting is off, kicks off
 *    async processing/scoring) but never removes anything.
 *  - `jobops_manual_job_infer` -- `POST /api/manual-jobs/infer` only.
 *    `readOnly: true`: `inferManualJobDetails` runs an LLM extraction over
 *    the pasted description and returns a draft `job` shape, it does not
 *    touch the database. Pass its output into `jobops_manual_job_create`'s
 *    "create" action to actually persist it.
 *
 * Deviation from the task-brief's suggested tool shape: the brief lists
 * `jobops_watchlist_check` as "trigger + results" and `jobops_watchlist_jobs`
 * as "seen/state/import" with no separate sources-branding mention. There is
 * no dedicated "seen jobs" listing route -- the closest equivalent is
 * `jobops_watchlist_check`'s "trigger" action, whose response annotates each
 * job with `rowState` ("new"/"ignored"/"moved_to_workspace") and
 * `isNewSinceLastCheck`. `POST /api/watchlist/source-branding` has no
 * brief-named home, so it was added to `jobops_watchlist_sources` (it reads
 * -- and can act on -- source config, same resource family as "list" and
 * "select").
 */

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

const watchlistSourceSelectionSchema = z.object({
  catalogSourceId: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .nullable()
    .optional()
    .describe(
      "Catalog source id this selection is pinned to, or omit/null for a custom source",
    ),
  sourceType: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe('Adapter source type, e.g. "workday", "bamboohr", "greenhouse"'),
  label: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullable()
    .optional()
    .describe("Display label, or omit/null to derive one from the URL"),
  careersUrl: z
    .string()
    .trim()
    .url()
    .max(2000)
    .describe("Careers page URL for this source"),
});

const watchlistCheckEntrySchema = z.object({
  source: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe('Watchlist source identifier, e.g. "workday:autodesk"'),
  sourceJobIds: z
    .array(z.string().trim().min(1).max(500))
    .max(200)
    .describe("External job ids from this source to record as checked"),
});

const manualJobInputSchema = z.object({
  source: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9:_-]*$/i)
    .optional()
    .describe(
      'Source identifier, e.g. "workday:autodesk"; defaults to "manual" when omitted',
    ),
  sourceJobId: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe(
      "External job id for dedupe against source; import is rejected as a conflict if this (source, sourceJobId) pair already exists",
    ),
  title: z.string().trim().min(1).max(500).describe("Job title"),
  employer: z.string().trim().min(1).max(500).describe("Employer name"),
  jobUrl: z
    .string()
    .trim()
    .url()
    .max(2000)
    .describe("Canonical job posting URL"),
  applicationLink: z
    .string()
    .trim()
    .url()
    .max(2000)
    .optional()
    .describe("Direct application URL"),
  location: z.string().trim().max(200).optional().describe("Job location"),
  salary: z.string().trim().max(200).optional().describe("Salary text"),
  deadline: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe("Application deadline text"),
  jobDescription: z
    .string()
    .trim()
    .min(1)
    .max(40000)
    .describe("Full job description text"),
  jobType: z.string().trim().max(200).optional().describe("Job type"),
  jobLevel: z.string().trim().max(200).optional().describe("Job level"),
  jobFunction: z.string().trim().max(200).optional().describe("Job function"),
  disciplines: z.string().trim().max(200).optional().describe("Disciplines"),
  degreeRequired: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Degree required"),
  starting: z.string().trim().max(200).optional().describe("Start date text"),
});

export const watchlistTools: ToolDef[] = [
  {
    name: "jobops_watchlist_sources",
    description:
      'List catalog + selected watchlist sources and available source types, replace the caller\'s entire set of selected sources, or fetch a source\'s branding metadata (logo/name). Wraps GET /api/watchlist/sources, PUT /api/watchlist/sources, and POST /api/watchlist/source-branding. "select" REPLACES the full selected-sources set -- any existing selection not included is dropped. "branding" always requires sourceType + careersUrl, even when selectedSourceId is also given.',
    destructive: true,
    coverage: [
      "GET /api/watchlist/sources",
      "PUT /api/watchlist/sources",
      "POST /api/watchlist/source-branding",
    ],
    inputSchema: {
      action: z
        .enum(["list", "select", "branding"])
        .optional()
        .describe(
          '"list" (default) fetches catalog + selected sources; "select" replaces the entire selected-sources set; "branding" fetches a source\'s logo/name metadata',
        ),
      selections: z
        .array(watchlistSourceSelectionSchema)
        .max(10)
        .optional()
        .describe(
          'Required for "select" -- the COMPLETE new set of selected sources (replaces, does not merge). Pass an empty array to clear all selections.',
        ),
      selectedSourceId: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .optional()
        .describe(
          'Existing selected-source id to derive branding from (only used by "branding"; sourceType/careersUrl are still required and are NOT inferred from this)',
        ),
      sourceType: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe('Adapter source type (required for "branding")'),
      careersUrl: z
        .string()
        .trim()
        .url()
        .max(2000)
        .optional()
        .describe('Careers page URL (required for "branding")'),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "list";

      if (action === "select") {
        const selections = requireField<unknown[]>(
          args,
          "selections",
          "select",
        );
        return selfCall(ctx, "PUT", "/api/watchlist/sources", { selections });
      }
      if (action === "branding") {
        const sourceType = requireField<string>(args, "sourceType", "branding");
        const careersUrl = requireField<string>(args, "careersUrl", "branding");
        const body = omitUndefined({
          selectedSourceId: args.selectedSourceId,
          sourceType,
          careersUrl,
        });
        return selfCall(ctx, "POST", "/api/watchlist/source-branding", body);
      }
      return selfCall(ctx, "GET", "/api/watchlist/sources");
    },
  },
  {
    name: "jobops_watchlist_check",
    description:
      'Trigger a live check of every selected watchlist source (fetches jobs from each source\'s adapter, records the check, and returns results annotated with rowState/isNewSinceLastCheck), or record a check for explicit source+sourceJobIds without live fetching. Wraps POST /api/watchlist/results (action "trigger") and POST /api/watchlist/checks (action "record"). "trigger" fetches every selected source concurrently, each individually bounded to a 30s adapter timeout -- worst-case wall time is ~30s regardless of source count, well under this tool\'s 60s call timeout.',
    coverage: ["POST /api/watchlist/results", "POST /api/watchlist/checks"],
    inputSchema: {
      action: z
        .enum(["trigger", "record"])
        .describe(
          '"trigger" live-fetches every selected source and returns annotated results; "record" writes explicit source+sourceJobIds as checked without fetching',
        ),
      checks: z
        .array(watchlistCheckEntrySchema)
        .max(20)
        .optional()
        .describe(
          'Required for "record" -- ignored for "trigger" (the server derives its own checks from the live source fetch)',
        ),
    },
    handler: (args, ctx) => {
      const action = requireField<string>(args, "action", "watchlist_check");

      if (action === "trigger") {
        return selfCall(ctx, "POST", "/api/watchlist/results");
      }
      if (action === "record") {
        const checks = requireField<unknown[]>(args, "checks", "record");
        return selfCall(ctx, "POST", "/api/watchlist/checks", { checks });
      }
      throw new Error(`Unknown watchlist_check action: ${action}`);
    },
  },
  {
    name: "jobops_watchlist_jobs",
    description:
      "List per-user watchlist job state (ignored jobs), ignore or un-ignore a specific external job, fetch full details for one external job, or prepare an import draft ready for jobops_manual_job_create. Wraps GET /api/watchlist/states, PUT /api/watchlist/states/:source/:sourceJobId, DELETE /api/watchlist/states/:source/:sourceJobId, POST /api/watchlist/job-details, and POST /api/watchlist/import-draft.",
    destructive: true,
    coverage: [
      "GET /api/watchlist/states",
      "PUT /api/watchlist/states/:source/:sourceJobId",
      "DELETE /api/watchlist/states/:source/:sourceJobId",
      "POST /api/watchlist/job-details",
      "POST /api/watchlist/import-draft",
    ],
    inputSchema: {
      action: z
        .enum([
          "list_states",
          "ignore",
          "unignore",
          "get_details",
          "prepare_import",
        ])
        .describe("Which watchlist-jobs operation to perform"),
      source: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe(
          'Watchlist source identifier (required for "ignore"/"unignore")',
        ),
      sourceJobId: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .optional()
        .describe('External job id (required for "ignore"/"unignore")'),
      selectedSourceId: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .optional()
        .describe(
          'Selected-source id (required for "get_details"/"prepare_import")',
        ),
      jobRef: z
        .string()
        .trim()
        .min(1)
        .max(3000)
        .optional()
        .describe(
          'Adapter-specific job reference (required for "get_details"/"prepare_import")',
        ),
    },
    handler: (args, ctx) => {
      const action = requireField<string>(args, "action", "watchlist_jobs");

      if (action === "list_states") {
        return selfCall(ctx, "GET", "/api/watchlist/states");
      }
      if (action === "ignore" || action === "unignore") {
        const source = requireField<string>(args, "source", action);
        const sourceJobId = requireField<string>(args, "sourceJobId", action);
        const path = `/api/watchlist/states/${encodeURIComponent(source)}/${encodeURIComponent(sourceJobId)}`;
        return selfCall(ctx, action === "ignore" ? "PUT" : "DELETE", path);
      }
      if (action === "get_details" || action === "prepare_import") {
        const selectedSourceId = requireField<string>(
          args,
          "selectedSourceId",
          action,
        );
        const jobRef = requireField<string>(args, "jobRef", action);
        const path =
          action === "get_details"
            ? "/api/watchlist/job-details"
            : "/api/watchlist/import-draft";
        return selfCall(ctx, "POST", path, { selectedSourceId, jobRef });
      }
      throw new Error(`Unknown watchlist_jobs action: ${action}`);
    },
  },
  {
    name: "jobops_manual_job_create",
    description:
      'Fetch and extract job content from a URL as a preparatory step, or import a manually curated job into the workspace (optionally auto-processing/scoring it). Wraps POST /api/manual-jobs/fetch (action "fetch_url") and POST /api/manual-jobs/import (action "create"). "fetch_url" does not persist anything -- feed its extracted content into jobops_manual_job_infer or paste it directly into "create"\'s job.jobDescription. Note: auto-fetch is blocked for LinkedIn and Indeed URLs (they block automated requests) -- "fetch_url" throws a descriptive error for those hosts instead of attempting the request.',
    coverage: ["POST /api/manual-jobs/fetch", "POST /api/manual-jobs/import"],
    inputSchema: {
      action: z
        .enum(["fetch_url", "create"])
        .describe(
          '"fetch_url" extracts job content from a URL; "create" persists a manually curated job',
        ),
      url: z
        .string()
        .trim()
        .url()
        .max(2000)
        .optional()
        .describe(
          'URL to fetch and extract content from (required for "fetch_url")',
        ),
      skipTailoring: z
        .boolean()
        .optional()
        .describe(
          'Skip auto-processing/scoring the created job ("create" only); defaults to the inverse of the autoTailorOnManualImport setting when omitted',
        ),
      job: manualJobInputSchema
        .optional()
        .describe('Job fields to import (required for "create")'),
    },
    handler: (args, ctx) => {
      const action = requireField<string>(args, "action", "manual_job_create");

      if (action === "fetch_url") {
        const url = requireField<string>(args, "url", "fetch_url");
        return selfCall(ctx, "POST", "/api/manual-jobs/fetch", { url });
      }
      if (action === "create") {
        const job = requireField<unknown>(args, "job", "create");
        const body = omitUndefined({
          skipTailoring: args.skipTailoring,
          job,
        });
        return selfCall(ctx, "POST", "/api/manual-jobs/import", body);
      }
      throw new Error(`Unknown manual_job_create action: ${action}`);
    },
  },
  {
    name: "jobops_manual_job_infer",
    description:
      'Infer structured job fields (title, employer, location, etc.) from a pasted job description using AI. Wraps POST /api/manual-jobs/infer. Does not persist anything -- pass the returned job fields into jobops_manual_job_create\'s "create" action to actually import it.',
    readOnly: true,
    coverage: ["POST /api/manual-jobs/infer"],
    inputSchema: {
      jobDescription: z
        .string()
        .trim()
        .min(1)
        .max(60000)
        .describe("Pasted job description text to infer fields from"),
    },
    handler: (args, ctx) => {
      const jobDescription = requireField<string>(
        args,
        "jobDescription",
        "manual_job_infer",
      );
      return selfCall(ctx, "POST", "/api/manual-jobs/infer", {
        jobDescription,
      });
    },
  },
];
