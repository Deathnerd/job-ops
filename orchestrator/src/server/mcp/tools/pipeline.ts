/**
 * Pipeline domain MCP tools -- wraps every route mounted under `/api/pipeline`
 * (see `orchestrator/src/server/api/routes/pipeline.ts`) via `selfCall`.
 *
 * Route -> tool grouping:
 *  - `jobops_pipeline_run` -- the three actions that make the pipeline start
 *    or continue: starting a fresh run, resuming a run paused waiting for LLM
 *    configuration, and starting the noVNC viewer for a pending Cloudflare
 *    challenge.
 *  - `jobops_pipeline_status` -- the three non-streaming, read-only snapshots
 *    of pipeline state: run status, live progress, and pending Cloudflare
 *    challenges.
 *  - `jobops_pipeline_cancel` -- the single cancel-in-flight-run route.
 *  - `jobops_pipeline_presets` -- CRUD over saved search presets. Stored-entity
 *    CRUD only -- the stateless AI search-plan generator lives in its own
 *    tool (`jobops_pipeline_search_plan`) so this tool's `destructive: true`
 *    (from its `delete` action) doesn't mislabel a non-mutating generator.
 *  - `jobops_pipeline_search_plan` -- the AI search-plan generator. Not
 *    preset CRUD (it never touches stored presets), but shares the same
 *    search-configuration shape as `config`/`currentConfig` above.
 *  - `jobops_pipeline_history` -- past pipeline runs and one run's insights.
 *
 * Excluded (no MCP equivalent):
 *  - `GET /api/pipeline/progress` (Server-Sent Events) -- no non-streaming
 *    MCP transport for a live push stream. Poll
 *    `jobops_pipeline_status(action: "progress")` instead, which reads the
 *    same underlying progress state as a point-in-time snapshot.
 *  - `POST /api/pipeline/solve-challenge` -- blocks synchronously for up to
 *    ~5 minutes waiting for a human to solve a Cloudflare challenge in a
 *    headed browser the server launches locally. This exceeds `selfCall`'s
 *    60s timeout and there is no non-interactive equivalent; a human must
 *    solve it through the noVNC viewer UI directly (get its URL via
 *    `jobops_pipeline_run(action: "start_challenge_viewer")` -- the route
 *    auto-resumes the pipeline on success, no separate MCP call needed).
 */

import { PIPELINE_EXTRACTOR_SOURCE_IDS } from "@shared/extractors";
import {
  LOCATION_MATCH_STRICTNESS_VALUES,
  LOCATION_SEARCH_SCOPE_VALUES,
  LOCATION_WORKPLACE_TYPE_VALUES,
} from "@shared/location-preferences.js";
import { MAX_PIPELINE_RUN_BUDGET } from "@shared/types";
import { z } from "zod";
import { selfCall, type ToolDef } from "../framework";

// Mirrors the route file's own `pipelineSourceSchema` construction (see
// api/routes/pipeline.ts) -- built from the same shared constant, not
// duplicated data.
const pipelineSourceSchema = z.enum(
  PIPELINE_EXTRACTOR_SOURCE_IDS as [
    (typeof PIPELINE_EXTRACTOR_SOURCE_IDS)[number],
    ...(typeof PIPELINE_EXTRACTOR_SOURCE_IDS)[number][],
  ],
);

const AUTOMATIC_PRESET_IDS = [
  "fast",
  "balanced",
  "detailed",
  "custom",
] as const;

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

// Mirrors `pipelineSearchPresetConfigSchema` in api/routes/pipeline.ts --
// used both for stored preset `config` (create/update) and `currentConfig`
// on the search-plan generator, since both take a full search configuration.
const pipelineSearchPresetConfigShape = {
  searchTerms: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(100)
    .describe("Search terms/keywords to crawl for"),
  sources: z
    .array(pipelineSourceSchema)
    .min(1)
    .describe("Job board source ids to crawl"),
  country: z.string().trim().max(100).describe("Selected country code/name"),
  cityLocations: z
    .array(z.string().trim().min(1).max(100))
    .max(25)
    .describe("City/location strings to search within"),
  workplaceTypes: z
    .array(z.enum(LOCATION_WORKPLACE_TYPE_VALUES))
    .min(1)
    .max(3)
    .describe("Allowed workplace types"),
  searchScope: z
    .enum(LOCATION_SEARCH_SCOPE_VALUES)
    .describe("Geographic search scope"),
  matchStrictness: z
    .enum(LOCATION_MATCH_STRICTNESS_VALUES)
    .describe("How strictly location matches are enforced"),
  topN: z
    .number()
    .int()
    .min(1)
    .max(50)
    .describe("Number of top jobs to process"),
  minSuitabilityScore: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("Minimum suitability score to auto-process"),
  runBudget: z
    .number()
    .int()
    .max(MAX_PIPELINE_RUN_BUDGET)
    .describe(
      "Max jobs to crawl this run; server clamps to the allowed floor/ceiling",
    ),
  scoringInstructions: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .describe("Extra free-text instructions for the suitability scorer"),
  automaticPresetId: z
    .enum(AUTOMATIC_PRESET_IDS)
    .optional()
    .describe("Which built-in speed/depth preset this config derives from"),
  watchlistSelectedSourceIds: z
    .array(z.string().min(1).max(128))
    .max(200)
    .optional()
    .describe(
      "Watchlist source ids to include; omitted includes every saved source, [] disables Watchlist",
    ),
};

export const pipelineTools: ToolDef[] = [
  {
    name: "jobops_pipeline_run",
    description:
      'Start a new pipeline run, resume a run paused waiting for LLM configuration, or start the noVNC viewer for a pending Cloudflare challenge. Wraps POST /api/pipeline/run, POST /api/pipeline/resume-scoring, and POST /api/pipeline/challenge-viewer. Note: POST /api/pipeline/solve-challenge (the blocking human-solves-the-challenge endpoint) has no MCP equivalent -- use "start_challenge_viewer" to get the viewer URL and solve it there; the pipeline resumes automatically on success.',
    coverage: [
      "POST /api/pipeline/run",
      "POST /api/pipeline/resume-scoring",
      "POST /api/pipeline/challenge-viewer",
    ],
    inputSchema: {
      action: z
        .enum(["run", "resume_scoring", "start_challenge_viewer"])
        .optional()
        .describe(
          '"run" (default) starts a new pipeline run; "resume_scoring" resumes a run paused waiting for LLM configuration; "start_challenge_viewer" starts the noVNC viewer session for a pending Cloudflare challenge and returns its URL',
        ),
      topN: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe('Number of top jobs to process (only used by "run")'),
      minSuitabilityScore: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe(
          'Minimum suitability score to auto-process (only used by "run")',
        ),
      sources: z
        .array(pipelineSourceSchema)
        .min(1)
        .optional()
        .describe('Job board source ids to crawl (only used by "run")'),
      runBudget: z
        .number()
        .int()
        .max(MAX_PIPELINE_RUN_BUDGET)
        .optional()
        .describe(
          'Max jobs to crawl this run; server clamps to the allowed floor/ceiling (only used by "run")',
        ),
      searchTerms: z
        .array(z.string().trim().min(1))
        .optional()
        .describe('Search terms/keywords to crawl for (only used by "run")'),
      scoringInstructions: z
        .string()
        .trim()
        .max(4000)
        .optional()
        .describe(
          'Extra free-text instructions for the suitability scorer (only used by "run")',
        ),
      country: z
        .string()
        .trim()
        .optional()
        .describe('Selected country code/name (only used by "run")'),
      cityLocations: z
        .array(z.string().trim().min(1))
        .optional()
        .describe(
          'City/location strings to search within (only used by "run")',
        ),
      workplaceTypes: z
        .array(z.enum(LOCATION_WORKPLACE_TYPE_VALUES))
        .min(1)
        .max(3)
        .optional()
        .describe('Allowed workplace types (only used by "run")'),
      searchScope: z
        .enum(LOCATION_SEARCH_SCOPE_VALUES)
        .optional()
        .describe('Geographic search scope (only used by "run")'),
      matchStrictness: z
        .enum(LOCATION_MATCH_STRICTNESS_VALUES)
        .optional()
        .describe(
          'How strictly location matches are enforced (only used by "run")',
        ),
      watchlistSelectedSourceIds: z
        .array(z.string().min(1).max(128))
        .optional()
        .describe(
          'Watchlist source ids to include; omitted includes every saved source, [] disables Watchlist (only used by "run")',
        ),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "run";

      if (action === "resume_scoring") {
        return selfCall(ctx, "POST", "/api/pipeline/resume-scoring");
      }
      if (action === "start_challenge_viewer") {
        return selfCall(ctx, "POST", "/api/pipeline/challenge-viewer");
      }
      if (action === "run") {
        const body = omitUndefined({
          topN: args.topN,
          minSuitabilityScore: args.minSuitabilityScore,
          sources: args.sources,
          runBudget: args.runBudget,
          searchTerms: args.searchTerms,
          scoringInstructions: args.scoringInstructions,
          country: args.country,
          cityLocations: args.cityLocations,
          workplaceTypes: args.workplaceTypes,
          searchScope: args.searchScope,
          matchStrictness: args.matchStrictness,
          watchlistSelectedSourceIds: args.watchlistSelectedSourceIds,
        });
        return selfCall(ctx, "POST", "/api/pipeline/run", body);
      }
      throw new Error(`Unknown pipeline_run action: ${action}`);
    },
  },
  {
    name: "jobops_pipeline_status",
    description:
      'Poll the pipeline\'s current status, live progress, or pending Cloudflare challenges. Wraps GET /api/pipeline/status, GET /api/pipeline/progress/snapshot, and GET /api/pipeline/challenges. Note: GET /api/pipeline/progress (the Server-Sent Events live stream) has no MCP equivalent -- poll this tool with action "progress" instead.',
    readOnly: true,
    coverage: [
      "GET /api/pipeline/status",
      "GET /api/pipeline/progress/snapshot",
      "GET /api/pipeline/challenges",
    ],
    inputSchema: {
      action: z
        .enum(["status", "progress", "challenges"])
        .optional()
        .describe(
          '"status" (default) returns whether the pipeline is running plus the last completed run; "progress" returns the current live progress-state snapshot; "challenges" returns pending Cloudflare challenges (non-empty only while the pipeline is paused at the "challenge_required" step)',
        ),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "status";
      if (action === "progress") {
        return selfCall(ctx, "GET", "/api/pipeline/progress/snapshot");
      }
      if (action === "challenges") {
        return selfCall(ctx, "GET", "/api/pipeline/challenges");
      }
      return selfCall(ctx, "GET", "/api/pipeline/status");
    },
  },
  {
    name: "jobops_pipeline_cancel",
    description:
      "Request cancellation of the currently running pipeline. Wraps POST /api/pipeline/cancel.",
    coverage: ["POST /api/pipeline/cancel"],
    inputSchema: {},
    handler: (_args, ctx) => selfCall(ctx, "POST", "/api/pipeline/cancel"),
  },
  {
    name: "jobops_pipeline_presets",
    description:
      "List, create, update, mark used, or delete saved pipeline search presets. Wraps GET/POST /api/pipeline/search-presets, PATCH /api/pipeline/search-presets/:id, POST /api/pipeline/search-presets/:id/used, and DELETE /api/pipeline/search-presets/:id.",
    destructive: true,
    coverage: [
      "GET /api/pipeline/search-presets",
      "POST /api/pipeline/search-presets",
      "PATCH /api/pipeline/search-presets/:id",
      "POST /api/pipeline/search-presets/:id/used",
      "DELETE /api/pipeline/search-presets/:id",
    ],
    inputSchema: {
      action: z
        .enum(["list", "create", "update", "mark_used", "delete"])
        .describe("Which preset operation to perform"),
      id: z
        .string()
        .optional()
        .describe(
          'Preset id (required for "update", "mark_used", and "delete")',
        ),
      name: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe('Preset name (required for "create"; optional for "update")'),
      config: z
        .object(pipelineSearchPresetConfigShape)
        .optional()
        .describe(
          'Full search configuration (required for "create"; for "update" provide "name" and/or "config")',
        ),
    },
    handler: (args, ctx) => {
      const action = requireField<string>(args, "action", "pipeline_presets");

      if (action === "list") {
        return selfCall(ctx, "GET", "/api/pipeline/search-presets");
      }
      if (action === "create") {
        const name = requireField<string>(args, "name", "create");
        const config = requireField<Record<string, unknown>>(
          args,
          "config",
          "create",
        );
        return selfCall(ctx, "POST", "/api/pipeline/search-presets", {
          name,
          config,
        });
      }
      if (action === "update") {
        const id = requireField<string>(args, "id", "update");
        if (args.name === undefined && args.config === undefined) {
          throw new Error(
            'invalid_argument: provide "name" and/or "config" for action "update"',
          );
        }
        const body = omitUndefined({ name: args.name, config: args.config });
        return selfCall(
          ctx,
          "PATCH",
          `/api/pipeline/search-presets/${id}`,
          body,
        );
      }
      if (action === "mark_used") {
        const id = requireField<string>(args, "id", "mark_used");
        return selfCall(ctx, "POST", `/api/pipeline/search-presets/${id}/used`);
      }
      if (action === "delete") {
        const id = requireField<string>(args, "id", "delete");
        return selfCall(ctx, "DELETE", `/api/pipeline/search-presets/${id}`);
      }
      throw new Error(`Unknown pipeline_presets action: ${action}`);
    },
  },
  {
    name: "jobops_pipeline_search_plan",
    description:
      "Generate a suggested search configuration from a natural-language prompt and the current configuration. Wraps POST /api/pipeline/search-plan. Stateless -- does not read or write any stored preset.",
    readOnly: true,
    coverage: ["POST /api/pipeline/search-plan"],
    inputSchema: {
      prompt: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Natural-language description of the desired search changes"),
      currentConfig: z
        .object(pipelineSearchPresetConfigShape)
        .describe("Current search configuration the plan should refine"),
    },
    handler: (args, ctx) => {
      const prompt = requireField<string>(
        args,
        "prompt",
        "pipeline_search_plan",
      );
      const currentConfig = requireField<Record<string, unknown>>(
        args,
        "currentConfig",
        "pipeline_search_plan",
      );
      return selfCall(ctx, "POST", "/api/pipeline/search-plan", {
        prompt,
        currentConfig,
      });
    },
  },
  {
    name: "jobops_pipeline_history",
    description:
      "List recent pipeline runs, or fetch exact/inferred metrics for one run. Wraps GET /api/pipeline/runs and GET /api/pipeline/runs/:id/insights.",
    readOnly: true,
    coverage: ["GET /api/pipeline/runs", "GET /api/pipeline/runs/:id/insights"],
    inputSchema: {
      action: z
        .enum(["list", "insights"])
        .optional()
        .describe(
          '"list" (default) returns the most recent pipeline runs; "insights" returns exact/inferred metrics for one run',
        ),
      id: z
        .string()
        .optional()
        .describe('Pipeline run id (required for "insights")'),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "list";
      if (action === "insights") {
        const id = requireField<string>(args, "id", "insights");
        return selfCall(ctx, "GET", `/api/pipeline/runs/${id}/insights`);
      }
      return selfCall(ctx, "GET", "/api/pipeline/runs");
    },
  },
  {
    name: "jobops_pipeline_location",
    description:
      "Resolve geographic context for proximity search: the country at a map point, or a preview of place names within a radius. Pure lookups, no state changes. Wraps POST /api/pipeline/location-country and POST /api/pipeline/location-area-preview.",
    readOnly: true,
    coverage: [
      "POST /api/pipeline/location-country",
      "POST /api/pipeline/location-area-preview",
    ],
    inputSchema: {
      action: z
        .enum(["country", "area_preview"])
        .describe(
          '"country" resolves the country at the point; "area_preview" lists nearby place names within radiusMiles',
        ),
      latitude: z
        .number()
        .min(-90)
        .max(90)
        .describe("Latitude of the map point (-90 to 90)"),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .describe("Longitude of the map point (-180 to 180)"),
      radiusMiles: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Search radius in miles, 1-200 (required for "area_preview")',
        ),
    },
    handler: (args, ctx) => {
      const point = { latitude: args.latitude, longitude: args.longitude };
      if (args.action === "area_preview") {
        const radiusMiles = requireField<number>(
          args,
          "radiusMiles",
          "area_preview",
        );
        return selfCall(ctx, "POST", "/api/pipeline/location-area-preview", {
          ...point,
          radiusMiles,
        });
      }
      return selfCall(ctx, "POST", "/api/pipeline/location-country", point);
    },
  },
];
