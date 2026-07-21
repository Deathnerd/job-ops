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
 * Matching is intentionally more permissive than plain string equality on
 * the normalized "METHOD /path" string, for two reasons that are real
 * properties of this codebase's already-committed domain tool files (not
 * something introduced here):
 *
 *  - Several `coverage` entries carry a human-readable trailing annotation
 *    in parens, e.g. `"POST /api/design-resume/assets (JSON body variant
 *    only)"` (see design-resume.ts) -- stripped before comparison.
 *  - Several Express routes are generic action dispatchers with a single
 *    `:action`-style param (e.g. `POST
 *    /api/post-application/providers/:provider/actions/:action`), but the
 *    domain file's `coverage` array documents each logical sub-action
 *    separately using the literal action name in that position (e.g.
 *    `"POST .../actions/status"`, `"POST .../actions/connect"`) rather than
 *    repeating the generic `:action` placeholder -- see the file header of
 *    post-application.ts, which explains this is intentional
 *    (audit-readability at the cost of not being a literal 1:1 string match
 *    with the walked route). A real Express route with a `:param` segment
 *    can be satisfied by ANY literal (or `:param`) segment in that same
 *    position on the claim side, and vice versa -- segment-wise matching
 *    with `:param` acting as a wildcard on either side.
 *
 * This is verified NOT to hide genuine gaps: matching still requires the
 * same HTTP method and the same number of path segments, and every other
 * segment to match literally. It only widens the single dynamic-segment
 * position(s) that already carry no discriminating information at the
 * Express-routing layer.
 */

import { apiRouter } from "@server/api/routes";
import { describe, expect, it } from "vitest";
import { getAllToolDefs } from "./framework";
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
];

const EXCLUDED: ReadonlyArray<{
  route: string;
  category: string;
  reason: string;
}> = [...MISC_DOMAIN_EXCLUSIONS, ...ADDITIONAL_EXCLUSIONS];

// --- Normalization + segment-wise matching -------------------------------
//
// Plain string equality on the normalized "METHOD /path" string is not
// enough on its own -- see the file-header comment for why. Matching is
// done segment-by-segment, with a `:param` segment on EITHER side acting as
// a wildcard for that position.

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

function endpointsMatch(a: Endpoint, b: Endpoint): boolean {
  if (a.method !== b.method) return false;
  if (a.segments.length !== b.segments.length) return false;
  return a.segments.every((seg, i) => {
    const other = b.segments[i];
    return seg === other || seg === ":param" || other === ":param";
  });
}

function walkApiRouter(): string[] {
  const endpoints: string[] = [];
  walk((apiRouter as unknown as { stack: Layer[] }).stack, "/api", endpoints);
  return [...new Set(endpoints)];
}

describe("MCP route coverage contract", () => {
  it("every /api endpoint is covered by a tool or excluded with a reason", () => {
    const realEndpoints = walkApiRouter().map(toEndpoint);
    const claimedEndpoints = getAllToolDefs()
      .flatMap((t) => t.coverage)
      .map(toEndpoint);
    const excludedEndpoints = EXCLUDED.map((e) => toEndpoint(e.route));

    const missing = realEndpoints.filter(
      (real) =>
        !claimedEndpoints.some((c) => endpointsMatch(c, real)) &&
        !excludedEndpoints.some((e) => endpointsMatch(e, real)),
    );

    expect(
      missing.map((m) => m.raw),
      `Uncovered endpoints:\n${missing.map((m) => m.raw).join("\n")}`,
    ).toEqual([]);
  });

  it("coverage claims refer to real endpoints (no typos)", () => {
    const realEndpoints = walkApiRouter().map(toEndpoint);
    const claimedEndpoints = getAllToolDefs()
      .flatMap((t) => t.coverage)
      .map(toEndpoint);

    const bogus = claimedEndpoints.filter(
      (claim) => !realEndpoints.some((real) => endpointsMatch(real, claim)),
    );

    expect(
      bogus.map((b) => b.raw),
      `Coverage claims with no matching real endpoint:\n${bogus.map((b) => b.raw).join("\n")}`,
    ).toEqual([]);
  });
});
