/**
 * Coverage contract test -- the CI gate that makes "every /api route is
 * reachable through an MCP tool, or is deliberately excluded with a reason"
 * mechanically permanent.
 *
 * Walks the REAL `apiRouter` (no fixtures, no hand-maintained route list) and
 * cross-checks it against every domain tool's `coverage` array from
 * `getAllToolDefs()`. Two assertions:
 *
 *  1. Every walked `/api` endpoint is either claimed by some tool's
 *     `coverage` array, or listed in `EXCLUDED` with a reason.
 *  2. Every `coverage` claim corresponds to a real endpoint (catches typos
 *     and stale claims after a route is renamed/removed).
 *
 * Matching is EXACT segment-by-segment equality after normalization
 * (`:name` params -> `:param`, trailing slash stripped, lower-cased). A
 * wildcard match (":param" satisfied by any segment, on either side) was
 * tried first and reverted: it silently matched unrelated same-method,
 * same-segment-count routes -- e.g. `GET /api/jobs/revision` would falsely
 * appear covered by an unrelated `GET /api/jobs/:id` claim purely because
 * both are two segments. That defeats the entire point of this test (see
 * the third `it()` below, which pins this exact regression down
 * permanently).
 *
 * The one legitimate need for anything beyond plain string equality is
 * `post-application-providers.ts`'s single physical dispatcher route (`POST
 * /providers/:provider/actions/:action`), documented in `post-application.ts`
 * per-sub-action using literal action names instead of repeating `:action`.
 * Rather than loosen matching (which is what caused the bug above), the
 * walked dispatcher route is pre-expanded into one literal endpoint per
 * action in `POST_APPLICATION_PROVIDER_ACTIONS` (the actual source of truth
 * the route validates `:action` against, imported from `@shared/types` --
 * not a hand-typed list that could drift), and matched with plain equality
 * like everything else. This is why `sync` now needs (and has) its own
 * `EXCLUDED` entry: post-application.ts's own file header already documents
 * it as intentionally unexposed (timeout-infeasible), and expansion makes
 * that concrete gap visible instead of it being silently absorbed by a
 * same-shape claim for a sibling action.
 *
 * `coverage` entries also occasionally carry a human-readable trailing
 * annotation in parens, e.g. `"POST /api/design-resume/assets (JSON body
 * variant only)"` (see design-resume.ts) -- stripped before comparison.
 */

import { apiRouter } from "@server/api/routes";
import {
  POST_APPLICATION_PROVIDER_ACTIONS,
  type PostApplicationProviderAction,
} from "@shared/types";
import { describe, expect, it } from "vitest";
import { getAllToolDefs, type ToolDef } from "./framework";
import { MISC_DOMAIN_EXCLUSIONS } from "./tools/misc";

// Reconstruct "METHOD /api/<path>" strings from the express 4 router tree.
type Layer = {
  route?: { path: string; methods: Record<string, boolean> };
  name: string;
  handle: { stack?: Layer[] };
  regexp: RegExp & { fast_slash?: boolean };
};

function mountPathOf(layer: Layer): string {
  if (layer.regexp.fast_slash) return "";
  // Express encodes the mount path in the regexp; recover param segments.
  // Mount paths can contain their own params in the middle (e.g.
  // "/jobs/:id/chat", see routes.ts's
  // `apiRouter.use("/jobs/:id/chat", ghostwriterRouter)`), not just at the
  // end, so this has to recover every `:name` segment, not just a trailing
  // one.
  const src = layer.regexp.source
    .replace("\\/?(?=\\/|$)", "")
    .replace(/^\^/, "")
    .replace(/\$\/?$/, "")
    .replace(/\\\//g, "/")
    // Express (path-to-regexp) compiles a mount-path param into a
    // non-capturing wrapper around the capturing group, e.g. `:id` in
    // "/jobs/:id/chat" (a MID-path param, not just a trailing one --
    // apiRouter.use("/jobs/:id/chat", ghostwriterRouter) in routes.ts) compiles
    // to `(?:/([^/]+?))` -- note the `/` living INSIDE the non-capturing
    // group, unlike a simple trailing param where it sits outside. Always
    // emit a leading "/" and collapse any resulting "//" afterwards so both
    // shapes normalize the same way.
    .replace(/\(\?:\/?\(\[\^\/\]\+\?\)\)/g, "/:param")
    .replace(/\/{2,}/g, "/");
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

/**
 * Every route this sweep intentionally leaves uncovered, with a reason.
 * Grow this list deliberately, not to silence failures -- see the domain
 * tool files' own JSDoc headers for the full reasoning behind each entry
 * below; this list only needs to carry enough context to justify itself on
 * its own.
 */
const ADDITIONAL_EXCLUSIONS: ReadonlyArray<{
  route: string;
  category: string;
  reason: string;
}> = [
  {
    route: "POST /api/jobs/actions/stream",
    category: "sse",
    reason:
      "Server-Sent-Events variant of the already-covered POST /api/jobs/actions (jobops_job_actions). MCP tool responses are single JSON-RPC results, not a stream an MCP client can consume incrementally -- the non-streaming route already covers the same bulk-action capability for an agent.",
  },
  {
    route: "GET /api/pipeline/progress",
    category: "sse",
    reason:
      'Server-Sent-Events live-progress stream. Replaced by jobops_pipeline_status\'s "progress" action, which reads the same underlying state (GET /api/pipeline/progress/snapshot) via a normal polled request an MCP client can actually make.',
  },
  {
    route: "POST /api/pipeline/solve-challenge",
    category: "timeout-infeasible",
    reason:
      "Opens a headed browser for a human to solve a Cloudflare challenge and blocks until solved or ~5 minutes elapse -- comfortably exceeds selfCall's fixed 60s timeout, and there is no polling/run-id alternative (the Express handler blocks the whole time). jobops_pipeline_run's \"start_challenge_viewer\" action (POST /api/pipeline/challenge-viewer) already lets an agent open the viewer for a human to solve out-of-band; the pipeline auto-resumes once solved without a second MCP call.",
  },
  {
    route: "GET /api/design-resume/pdf",
    category: "binary-download",
    reason:
      'Serves raw PDF bytes via res.sendFile, not a JSON envelope selfCall can unwrap. jobops_resume_render\'s "download_url" action returns { url: "/api/design-resume/pdf" } for a human/browser to fetch directly instead of proxying the binary through an MCP tool result.',
  },
  {
    route: "GET /api/design-resume/assets/:assetId/content",
    category: "binary-download",
    reason:
      'Serves raw asset bytes with a Content-Type header, not a JSON envelope. jobops_resume_assets\'s "content_url" action returns { url: "/api/design-resume/assets/:assetId/content" } instead of proxying binary content through an MCP tool result.',
  },
  {
    route: "POST /api/post-application/providers/:provider/actions/sync",
    category: "timeout-infeasible",
    reason:
      'gmailProvider.sync -> runGmailIngestionSync is a single fully-synchronous await with no per-call ceiling (see post-application.ts\'s file header for the full latency analysis) -- comfortably exceeds selfCall\'s fixed 60s timeout, with no polling/run-id alternative. Triggering a sync is left to the web UI; jobops_postapp_sync\'s "runs"/"run_messages" actions still let an agent read the results of a UI-triggered sync. The sibling actions on this same physical dispatcher route ("connect", "status", "disconnect") ARE covered by jobops_postapp_providers -- this exclusion only applies to the "sync" literal-action expansion (see DISPATCHER_ACTION_EXPANSIONS below).',
  },
];

const EXCLUDED: ReadonlyArray<{
  route: string;
  category: string;
  reason: string;
}> = [...MISC_DOMAIN_EXCLUSIONS, ...ADDITIONAL_EXCLUSIONS];

// --- Normalization + exact matching ---------------------------------------

type Endpoint = { method: string; segments: string[]; raw: string };

function stripAnnotation(s: string): string {
  // Trailing parenthetical documentation, e.g. "...(JSON body variant
  // only)". Coverage strings never legitimately end in a literal paren
  // group that's part of the path itself.
  return s.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function toEndpoint(raw: string): Endpoint {
  const normalized = stripAnnotation(raw)
    .replace(/:[A-Za-z0-9_]+/g, ":param")
    .replace(/\/+$/, "")
    .toLowerCase();
  const spaceIdx = normalized.indexOf(" ");
  const method = spaceIdx === -1 ? normalized : normalized.slice(0, spaceIdx);
  const path = spaceIdx === -1 ? "" : normalized.slice(spaceIdx + 1);
  const segments = path.split("/").filter(Boolean);
  return { method, segments, raw };
}

function endpointKey(e: Endpoint): string {
  return `${e.method} /${e.segments.join("/")}`;
}

function endpointsMatch(a: Endpoint, b: Endpoint): boolean {
  return endpointKey(a) === endpointKey(b);
}

/**
 * The one physical route documented per-sub-action instead of with a
 * literal `:action` claim -- see the file-header comment. Expanding it here
 * (rather than loosening the matcher) keeps matching everywhere else exact.
 */
const DISPATCHER_ROUTE_KEY =
  "post /api/post-application/providers/:param/actions/:param";

function expandDispatcherActions(real: Endpoint[]): Endpoint[] {
  return real.flatMap((e) => {
    if (endpointKey(e) !== DISPATCHER_ROUTE_KEY) return [e];
    return POST_APPLICATION_PROVIDER_ACTIONS.map(
      (action: PostApplicationProviderAction) => ({
        method: e.method,
        segments: [...e.segments.slice(0, -1), action],
        raw: `${e.raw} [action=${action}]`,
      }),
    );
  });
}

function walkApiRouter(): string[] {
  const endpoints: string[] = [];
  walk((apiRouter as unknown as { stack: Layer[] }).stack, "/api", endpoints);
  return [...new Set(endpoints)];
}

function realEndpoints(): Endpoint[] {
  return expandDispatcherActions(walkApiRouter().map(toEndpoint));
}

function claimedEndpoints(defs: ToolDef[] = getAllToolDefs()): Endpoint[] {
  return defs.flatMap((t) => t.coverage).map(toEndpoint);
}

function findMissing(real: Endpoint[], claimed: Endpoint[]): Endpoint[] {
  const excluded = EXCLUDED.map((e) => toEndpoint(e.route));
  return real.filter(
    (r) =>
      !claimed.some((c) => endpointsMatch(c, r)) &&
      !excluded.some((e) => endpointsMatch(e, r)),
  );
}

describe("MCP route coverage contract", () => {
  it("every /api endpoint is covered by a tool or excluded with a reason", () => {
    const missing = findMissing(realEndpoints(), claimedEndpoints());

    expect(
      missing.map((m) => m.raw),
      `Uncovered endpoints:\n${missing.map((m) => m.raw).join("\n")}`,
    ).toEqual([]);
  });

  it("coverage claims refer to real endpoints (no typos)", () => {
    const real = realEndpoints();
    const claimed = claimedEndpoints();

    const bogus = claimed.filter(
      (claim) => !real.some((r) => endpointsMatch(r, claim)),
    );

    expect(
      bogus.map((b) => b.raw),
      `Coverage claims with no matching real endpoint:\n${bogus.map((b) => b.raw).join("\n")}`,
    ).toEqual([]);
  });

  it("regression: removing a claimed route's coverage is detected as missing", () => {
    // Pins down a real bug this test previously had: an earlier version
    // matched `:param` as a wildcard against ANY segment (including a
    // literal one), so removing "GET /api/jobs/revision" from every tool's
    // coverage stayed green -- it silently matched the unrelated, same
    // method/segment-count claim "GET /api/jobs/:id". This constructs that
    // exact scenario (clone getAllToolDefs()'s output, strip the target
    // route from whichever tool claims it) and asserts the missing-route
    // computation reports exactly the removed route, proving the exploit
    // stays closed.
    const TARGET_ROUTE = "GET /api/jobs/revision";
    const originalDefs = getAllToolDefs();
    const claimedByAnyDef = originalDefs.some((t) =>
      t.coverage.includes(TARGET_ROUTE),
    );
    expect(claimedByAnyDef).toBe(true);

    const tamperedDefs: ToolDef[] = originalDefs.map((t) => ({
      ...t,
      coverage: t.coverage.filter((c) => c !== TARGET_ROUTE),
    }));

    const missing = findMissing(
      realEndpoints(),
      claimedEndpoints(tamperedDefs),
    );

    expect(missing.map((m) => m.raw)).toEqual([TARGET_ROUTE]);
  });
});
