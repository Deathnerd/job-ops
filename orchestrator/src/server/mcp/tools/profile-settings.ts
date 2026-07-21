/**
 * Profile + Settings domain MCP tools -- wraps the routes mounted at
 * `/api/profile` (`orchestrator/src/server/api/routes/profile.ts`) and
 * `/api/settings` (`orchestrator/src/server/api/routes/settings.ts`) via
 * `selfCall`.
 *
 * Route -> tool grouping (12 routes total across both files; 10 covered, 2
 * excluded):
 *
 * profile.ts (4 routes, all covered):
 *  - `jobops_profile_get` -- `GET /api/profile`, `GET /api/profile/status`,
 *    `POST /api/profile/refresh`. "refresh" clears the cached profile (and
 *    the Reactive Resume resume cache) and refetches -- it mutates
 *    server-side cache state, so this tool is NOT marked readOnly even
 *    though two of its three actions are pure reads (jobs.ts precedent:
 *    a tool mixing reads and one mutating action stays unmarked, not
 *    readOnly).
 *  - `jobops_profile_projects` -- `GET /api/profile/projects` only. Given
 *    its own dedicated tool (matching the task brief's target shape)
 *    rather than folded into `jobops_profile_get` as a third action --
 *    it's the one route in this file that's always side-effect-free and
 *    worth its own `readOnly: true` annotation without the "refresh"
 *    action dragging it down.
 *
 * settings.ts (8 routes; 6 covered, 2 excluded):
 *  - `jobops_settings_get` -- `GET /api/settings`, `POST
 *    /api/settings/llm-models`, `GET /api/settings/rx-resumes`, `GET
 *    /api/settings/rx-resumes/:id/projects`. All four are non-persisting
 *    reads/queries -- `POST /llm-models` takes a body to test a
 *    provider's credentials and list its available models, but writes
 *    nothing to storage -- so the whole tool is `readOnly: true`.
 *  - `jobops_settings_set` -- `PATCH /api/settings` only. The route's body
 *    schema (`updateSettingsSchema`, `shared/src/settings-schema.ts`) is
 *    generated dynamically from `settingsRegistry`'s 60+ heterogeneous
 *    entries (plain strings, numbers, enums, arrays, nested objects, and
 *    write-only secrets). Rather than hand-duplicating every field here
 *    (drift-prone busywork against a source that is already the single
 *    source of truth), this tool's `inputSchema` reuses
 *    `updateSettingsSchema.shape` directly -- every key, every nested
 *    type, every enum, byte-for-byte identical to what the route itself
 *    validates -- and layers a human-readable `.describe()` onto each
 *    field from the `SETTINGS_FIELD_DESCRIPTIONS` lookup below. This is a
 *    deliberate deviation from the usual hand-written-shape convention
 *    (see jobs.ts/design-resume.ts): full fidelity with the real route
 *    schema by construction, forever, instead of a second copy that can
 *    silently drift when the registry grows.
 *  - `jobops_codex_auth_status` -- `GET /api/settings/codex-auth` only,
 *    `readOnly: true`.
 *  - EXCLUDED, category "auth-bootstrap": `POST
 *    /api/settings/codex-auth/start` and `POST
 *    /api/settings/codex-auth/disconnect`. Both drive an in-process OAuth
 *    device-auth session -- "start" spawns a `codex login --device-auth`
 *    subprocess and returns a verification URL + user code that a human
 *    must complete out-of-band in a browser (an MCP tool call can trigger
 *    it but cannot usefully finish it); "disconnect" spawns `codex
 *    logout`, tearing down that same session/credential state. The task
 *    brief's target shape names only the read-side
 *    `jobops_codex_auth_status` tool, matching this call: sign-in/sign-out
 *    stays on the JobOps web UI's Settings page, and only the
 *    headlessly-useful status check is exposed here.
 *
 * SECURITY: every route wrapped here is already redacted at the source,
 * before this file ever sees a response.
 *  - `GET /api/settings` never serializes a raw secret value: the
 *    settings-registry `kind: "secret"` fields (`llmApiKey`,
 *    `llmPurposeApiKeys`, `rxresumeApiKey`, `ukvisajobsPassword`,
 *    `adzunaAppKey`, `apifyToken`, `webhookSecret`) are skipped entirely by
 *    `getEffectiveSettings`'s typed/model/string assembly loop
 *    (`orchestrator/src/server/services/settings.ts`) and are instead
 *    surfaced ONLY as `<key>Hint` fields -- a <=4-char truncated preview
 *    computed by `getEnvSettingsData`
 *    (`orchestrator/src/server/services/envSettings.ts`). There is no
 *    action on `jobops_settings_get` that can produce the full secret.
 *  - `jobops_codex_auth_status` (`GET /api/settings/codex-auth`) returns
 *    only `authenticated` (boolean), `username`, and status/message
 *    strings -- never a token or session credential.
 *  - `jobops_settings_set` (`PATCH /api/settings`) is write-only for
 *    secrets: its response is `getEffectiveSettings()`, subject to the
 *    same redaction above, so even the tool call that just wrote a secret
 *    never echoes it back.
 *  - `profile-settings.test.ts` asserts this by writing a known plaintext
 *    secret via `jobops_settings_set`, then scanning a `jobops_settings_get`
 *    response for that plaintext -- it must never appear.
 */

import type { settingsRegistry } from "@shared/settings-registry";
import { updateSettingsSchema } from "@shared/settings-schema";
import { LLM_PURPOSE_VALUES } from "@shared/types";
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

/**
 * Human-readable description per `settingsRegistry` key, layered onto
 * `updateSettingsSchema.shape` below. Keep this in sync when new keys are
 * added to the registry -- unlisted keys still work (a generic fallback
 * description is used) but lose the specific context.
 */
const SETTINGS_FIELD_DESCRIPTIONS: Partial<
  Record<keyof typeof settingsRegistry, string>
> = {
  model: "Default LLM model id used unless a purpose-specific override applies",
  llmProvider:
    "LLM provider id (e.g. openrouter, openai, anthropic, gemini, gemini_cli, ollama, lmstudio, glm, openai_compatible, codex)",
  llmBaseUrl:
    "Base URL override for the configured LLM provider (relevant for ollama/lmstudio/glm/openai_compatible)",
  llmPurposeOverrides:
    "Per-purpose (scoring/tailoring/projectSelection) provider+baseUrl+model overrides, keyed by LlmPurpose",
  pipelineWebhookUrl:
    "Webhook URL notified on pipeline run progress/completion",
  jobCompleteWebhookUrl:
    "Webhook URL notified when an individual job finishes processing",
  resumeProjects:
    "Resume project-selection settings: { maxProjects, lockedProjectIds, aiSelectableProjectIds } -- all three fields required together, this is a full replace not a partial merge",
  pdfRenderer:
    "Which backend renders the resume PDF (rxresume, latex, or typst)",
  typstTheme: "Typst resume theme id (only used when pdfRenderer is typst)",
  ukvisajobsMaxJobs: "Max jobs to pull per UKVisaJobs search run",
  adzunaMaxJobsPerTerm: "Max jobs to pull per search term from Adzuna",
  gradcrackerMaxJobsPerTerm:
    "Max jobs to pull per search term from Gradcracker",
  startupjobsMaxJobsPerTerm:
    "Max jobs to pull per search term from StartupJobs",
  seekMaxJobsPerTerm: "Max jobs to pull per search term from Seek",
  naukriMaxJobsPerTerm: "Max jobs to pull per search term from Naukri",
  jobindexMaxJobsPerTerm: "Max jobs to pull per search term from Jobindex",
  searchTerms: "Job search query terms used across extractors",
  workplaceTypes:
    "Allowed workplace types to search for (remote/hybrid/onsite)",
  onboardingProfileCompleted:
    "Whether the profile-setup onboarding step is done",
  onboardingLlmCompleted: "Whether the LLM-setup onboarding step is done",
  onboardingResumeConfirmedSource:
    "Which resume source the user confirmed during onboarding",
  blockedCompanyKeywords:
    "Employer-name keywords that cause a job to be auto-skipped",
  scoringInstructions: "Extra free-text instructions injected into job scoring",
  ghostwriterSystemPromptTemplate:
    "System prompt template for the ghostwriter chat feature",
  ghostwriterStopSlopEnabled:
    "Whether ghostwriter's anti-AI-slop style guard is enabled",
  tailoringPromptTemplate: "Prompt template used when tailoring resume content",
  scoringPromptTemplate: "Prompt template used when scoring job suitability",
  searchCities: "Free-text city/location search string used by extractors",
  locationSearchScope: "How broadly to search by location (geo scope)",
  locationMatchStrictness:
    "How strictly a job's location must match preferences",
  jobspyResultsWanted:
    "Max results requested per jobspy (LinkedIn/Indeed/Glassdoor) run",
  jobspyCountryIndeed: "Country code jobspy passes to the Indeed backend",
  showSponsorInfo: "Whether visa-sponsor match info is shown in the UI",
  renderMarkdownInJobDescriptions:
    "Whether job descriptions are rendered as Markdown in the UI",
  autoTailorOnManualImport:
    "Whether manually-imported jobs are auto-tailored immediately",
  chatStyleTone: "Tone used for ghostwriter-generated chat/content",
  chatStyleFormality: "Formality level used for ghostwriter-generated content",
  chatStyleConstraints: "Free-text style constraints for ghostwriter content",
  chatStyleDoNotUse: "Words/phrases ghostwriter content must avoid",
  chatStyleSummaryMaxWords:
    "Max word count for generated summaries, or null for no limit",
  chatStyleMaxKeywordsPerSkill:
    "Max keywords per tailored skill group, or null for no limit",
  chatStyleLanguageMode:
    "Whether chat-style language is auto-detected or manual",
  chatStyleManualLanguage:
    "Manually-selected chat-style language (only used when chatStyleLanguageMode is manual)",
  backupEnabled: "Whether scheduled database backups are enabled",
  backupHour: "Hour of day (0-23, server local time) scheduled backups run",
  backupMaxCount: "Max number of scheduled backups retained before pruning",
  penalizeMissingSalary:
    "Whether jobs missing salary info get a scoring penalty",
  missingSalaryPenalty:
    "Scoring penalty (0-100) applied when penalizeMissingSalary is on",
  autoSkipScoreThreshold:
    "Suitability score below which jobs are auto-skipped, or null to disable",
  modelScorer:
    "Model override used specifically for scoring (falls back to model)",
  modelTailoring:
    "Model override used specifically for tailoring (falls back to model)",
  modelProjectSelection:
    "Model override used specifically for project selection (falls back to model)",
  rxresumeBaseResumeId: "Reactive Resume resume id used as the base profile",
  rxresumeUrl: "Reactive Resume instance base URL",
  ukvisajobsEmail: "UKVisaJobs account email used for authenticated search",
  adzunaAppId: "Adzuna API application id",
  llmApiKey:
    "LLM provider API key (secret, write-only -- jobops_settings_get never returns this, only a truncated llmApiKeyHint)",
  llmPurposeApiKeys:
    "Per-purpose (scoring/tailoring/projectSelection) API key overrides (secret, write-only -- surfaced only as llmPurposeApiKeyHints)",
  rxresumeApiKey:
    "Reactive Resume API key (secret, write-only -- surfaced only as rxresumeApiKeyHint)",
  ukvisajobsPassword:
    "UKVisaJobs account password (secret, write-only -- surfaced only as ukvisajobsPasswordHint)",
  adzunaAppKey:
    "Adzuna API key (secret, write-only -- surfaced only as adzunaAppKeyHint)",
  apifyToken:
    "Apify API token (secret, write-only -- surfaced only as apifyTokenHint)",
  webhookSecret:
    "Shared secret sent with outgoing webhook requests (secret, write-only -- surfaced only as webhookSecretHint)",
  jobspyLocation:
    "Legacy alias for searchCities -- both keys map to the same stored setting",
};

function describeSettingsKey(key: string): string {
  return (
    SETTINGS_FIELD_DESCRIPTIONS[key as keyof typeof settingsRegistry] ??
    `Settings registry key "${key}"`
  ).concat(
    ". Omit to leave unchanged; pass null to clear the stored override back to its default.",
  );
}

const settingsUpdateShape: z.ZodRawShape = Object.fromEntries(
  Object.entries(updateSettingsSchema.shape).map(([key, fieldSchema]) => [
    key,
    (fieldSchema as z.ZodTypeAny).describe(describeSettingsKey(key)),
  ]),
);

export const profileSettingsTools: ToolDef[] = [
  {
    name: "jobops_profile_get",
    description:
      'Fetch the base-resume profile, check whether one is configured and accessible, or clear the cache and refetch. Wraps GET /api/profile, GET /api/profile/status, and POST /api/profile/refresh. "refresh" mutates server-side cache state (it is NOT a pure read).',
    coverage: [
      "GET /api/profile",
      "GET /api/profile/status",
      "POST /api/profile/refresh",
    ],
    inputSchema: {
      action: z
        .enum(["get", "status", "refresh"])
        .optional()
        .describe(
          '"get" (default) fetches the full base-resume profile; "status" checks whether a base resume is configured and reachable without fetching it; "refresh" clears the cached profile (and Reactive Resume resume cache) and refetches',
        ),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "get";
      if (action === "status") {
        return selfCall(ctx, "GET", "/api/profile/status");
      }
      if (action === "refresh") {
        return selfCall(ctx, "POST", "/api/profile/refresh");
      }
      return selfCall(ctx, "GET", "/api/profile");
    },
  },
  {
    name: "jobops_profile_projects",
    description:
      "List every project available in the base resume's project catalog. Wraps GET /api/profile/projects.",
    readOnly: true,
    coverage: ["GET /api/profile/projects"],
    inputSchema: {},
    handler: (_args, ctx) => selfCall(ctx, "GET", "/api/profile/projects"),
  },
  {
    name: "jobops_settings_get",
    description:
      "Read effective app settings (values, defaults, and overrides -- secrets appear only as truncated hints), list Reactive Resume resumes, fetch a Reactive Resume resume's project catalog, or test an LLM provider's credentials and list its available models. Wraps GET /api/settings, POST /api/settings/llm-models, GET /api/settings/rx-resumes, and GET /api/settings/rx-resumes/:id/projects. None of these persist anything, including \"list_llm_models\" (its body is used only to test credentials for that one call).",
    readOnly: true,
    coverage: [
      "GET /api/settings",
      "POST /api/settings/llm-models",
      "GET /api/settings/rx-resumes",
      "GET /api/settings/rx-resumes/:id/projects",
    ],
    inputSchema: {
      action: z
        .enum(["get", "list_llm_models", "rx_resumes", "rx_resume_projects"])
        .optional()
        .describe(
          '"get" (default) fetches effective settings; "list_llm_models" tests provider credentials and lists available models; "rx_resumes" lists Reactive Resume resumes; "rx_resume_projects" fetches one resume\'s project catalog',
        ),
      provider: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe(
          'LLM provider id to test/list models for (only used by "list_llm_models"); defaults to the stored/env provider when omitted',
        ),
      apiKey: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .optional()
        .describe(
          'API key to test against the provider (only used by "list_llm_models"); used only for this one call, never persisted or echoed back in the response',
        ),
      baseUrl: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .optional()
        .describe(
          'Base URL override to test (only used by "list_llm_models"; relevant for lmstudio/ollama/glm/openai_compatible providers)',
        ),
      purpose: z
        .enum(LLM_PURPOSE_VALUES)
        .optional()
        .describe(
          'LLM purpose (scoring/tailoring/projectSelection) whose stored per-purpose API key is considered as a fallback when "apiKey" is omitted (only used by "list_llm_models")',
        ),
      resumeId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Reactive Resume resume id (required for "rx_resume_projects")',
        ),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "get";
      if (action === "list_llm_models") {
        const body = omitUndefined({
          provider: args.provider,
          apiKey: args.apiKey,
          baseUrl: args.baseUrl,
          purpose: args.purpose,
        });
        return selfCall(ctx, "POST", "/api/settings/llm-models", body);
      }
      if (action === "rx_resumes") {
        return selfCall(ctx, "GET", "/api/settings/rx-resumes");
      }
      if (action === "rx_resume_projects") {
        const resumeId = requireField<string>(
          args,
          "resumeId",
          "rx_resume_projects",
        );
        return selfCall(
          ctx,
          "GET",
          `/api/settings/rx-resumes/${resumeId}/projects`,
        );
      }
      return selfCall(ctx, "GET", "/api/settings");
    },
  },
  {
    name: "jobops_settings_set",
    description:
      "Update app settings overrides. Wraps PATCH /api/settings. Every field is optional and independently nullable: omit a field to leave it unchanged, pass null to clear the stored override back to its default (or back to the environment-variable value, for env-backed settings). Secret fields (llmApiKey, llmPurposeApiKeys, rxresumeApiKey, ukvisajobsPassword, adzunaAppKey, apifyToken, webhookSecret) are write-only here -- the response (effective settings) never echoes a secret back, only a truncated hint. Setting rxresumeUrl or rxresumeApiKey triggers a save-time Reactive Resume credential check; on a validation failure the call throws a descriptive error instead of silently saving bad credentials.",
    coverage: ["PATCH /api/settings"],
    inputSchema: settingsUpdateShape,
    handler: (args, ctx) =>
      selfCall(ctx, "PATCH", "/api/settings", omitUndefined(args)),
  },
  {
    name: "jobops_codex_auth_status",
    description:
      "Check whether Codex CLI sign-in is currently authenticated, including any in-progress device-auth flow status. Wraps GET /api/settings/codex-auth. Returns only a boolean, an optional username, and human-readable status/flow fields -- never a token. Starting or disconnecting the Codex sign-in flow (POST /api/settings/codex-auth/start, POST /api/settings/codex-auth/disconnect) is intentionally NOT exposed here: both drive an interactive OAuth device-code flow that requires a human to complete a verification step out-of-band in a browser, which a headless MCP tool call cannot usefully do -- use the JobOps web UI's Settings page to sign in or out of Codex.",
    readOnly: true,
    coverage: ["GET /api/settings/codex-auth"],
    inputSchema: {},
    handler: (_args, ctx) => selfCall(ctx, "GET", "/api/settings/codex-auth"),
  },
];
