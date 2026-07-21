/**
 * Design Resume (Resume Studio) domain MCP tools -- wraps the routes mounted
 * at `/api/design-resume` (see
 * `orchestrator/src/server/api/routes/design-resume.ts`, mounted via
 * `apiRouter.use("/design-resume", designResumeRouter)` in `api/routes.ts`)
 * via `selfCall`.
 *
 * Route -> tool grouping (12 routes total):
 *  - `jobops_resume_get` -- every read of the current document: the document
 *    itself, the lightweight status marker, and the export payload. Wraps
 *    `GET /`, `GET /status`, `GET /export`.
 *  - `jobops_resume_update` -- every write to the resume-document resource:
 *    full-document replace, JSON-patch, importing from Reactive Resume or a
 *    file, and the AI field-suggestion preview. Wraps `PATCH /`,
 *    `POST /import/rxresume`, `POST /import/file`, and
 *    `POST /ai/field-suggestion`. The two import actions and the AI-suggestion
 *    action are folded into this tool rather than given their own tool names
 *    -- they all read or write the same resume-document resource, and the
 *    task brief's 4-tool budget (get/update/render/assets) has no dedicated
 *    slot for "import" or "suggest" as top-level tools. This mirrors Task 8a's
 *    precedent of adding an extra action to an existing tool (`challenges` on
 *    `jobops_pipeline_status`) rather than inventing a new tool name for one
 *    or two extra routes.
 *  - `jobops_resume_render` -- generates the PDF and returns its metadata
 *    (including a download URL), plus a `download_url` action for the direct
 *    binary-serving route. Wraps `POST /generate-pdf` and `GET /pdf`.
 *  - `jobops_resume_assets` -- list, upload, delete, and get-content-URL for
 *    the profile-picture asset. Wraps `POST /assets` (JSON body variant only),
 *    `DELETE /assets/picture`, and `GET /assets/:assetId/content`.
 *
 * Full route enumeration and exclusions (12 routes total; 9 covered outright,
 * 2 excluded outright, 1 route split covered/excluded by request-body shape):
 *  - `GET /`, `GET /status`, `GET /export` -- covered (`jobops_resume_get`).
 *  - `PATCH /`, `POST /import/rxresume`, `POST /import/file`,
 *    `POST /ai/field-suggestion` -- covered (`jobops_resume_update`).
 *  - `POST /generate-pdf` -- covered (`jobops_resume_render`, action
 *    "generate"). This does real (potentially slow) PDF rendering, same
 *    tradeoff already accepted for `jobops_job_documents`' "generate_pdf"
 *    action in jobs.ts -- not flagged timeout-infeasible because rendering a
 *    single resume is not in the same league as pipeline's 5-minute
 *    challenge-solve wait.
 *  - `GET /pdf` -- EXCLUDED, category binary-download: serves raw PDF bytes
 *    via `res.sendFile`. Covered instead by `jobops_resume_render`'s
 *    "download_url" action, which returns `{ url: "/api/design-resume/pdf" }`
 *    -- same pattern as `jobops_job_get`'s "pdf_url" action in jobs.ts.
 *  - `POST /assets` -- SPLIT. This route has two request-body shapes: a
 *    raw-binary path (`Buffer.isBuffer(req.body)`, driven by
 *    `x-file-name`/`x-base-revision` headers and a raw octet-stream body) and
 *    a JSON path (`uploadSchema = pictureMutationSchema.extend({ fileName,
 *    dataUrl })`). The raw-binary path is EXCLUDED, category binary-upload,
 *    reason "multipart upload unsupported over MCP v1" (per task brief) --
 *    genuinely impossible over MCP's JSON-args transport. The JSON path IS
 *    covered, by `jobops_resume_assets`' "upload" action -- it's a plain JSON
 *    body, no different in kind from `jobops_job_documents`' already-covered
 *    "upload"/"upload_pdf" actions in jobs.ts. Note `dataUrl` here is a FULL
 *    `data:<mime>;base64,<bytes>` string (parsed by `parseDataUrl`), NOT a
 *    bare base64 payload like jobs.ts's `dataBase64` -- do not confuse the
 *    two shapes. Also note this route (both branches) calls
 *    `assertPictureSupportEnabled`, which 409s unless JobOps is configured as
 *    publicly reachable -- callers should expect a conflict in most
 *    self-hosted/dev setups, not a bug.
 *  - `GET /assets/:assetId/content` -- EXCLUDED, category binary-download:
 *    serves raw asset bytes with a `Content-Type` header. Covered instead by
 *    `jobops_resume_assets`' "content_url" action, which returns
 *    `{ url: "/api/design-resume/assets/:assetId/content" }`.
 *  - `DELETE /assets/picture` -- covered (`jobops_resume_assets`, action
 *    "delete").
 *
 * `jobops_resume_assets`' "list" action has no dedicated backing route --
 * there is no `GET /assets` list endpoint. Asset metadata is only ever
 * embedded in the document itself (`DesignResumeDocument.assets`). "list"
 * therefore calls `GET /` (the same route `jobops_resume_get`'s "get" action
 * uses) and returns just the `assets` array from that response, rather than
 * fabricating a non-existent route.
 *
 * `jobops_resume_update`'s "document" and "patch" actions both require
 * `baseRevision` (optimistic-concurrency, matching the route's
 * `designResumePatchSchema.baseRevision`, which is mandatory). The "document"
 * action's `document` field must be the COMPLETE resume JSON -- the route
 * replaces the whole stored document with whatever is passed, there is no
 * server-side partial merge, and this tool does not attempt to fake one
 * client-side either. Use the "patch" action's `operations` (RFC 6902 JSON
 * Patch) for partial edits instead.
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

function isJsonPointer(value: string): boolean {
  return value === "" || value.startsWith("/");
}

const patchOperationSchema = z
  .object({
    op: z
      .enum(["add", "remove", "replace", "move", "copy", "test"])
      .describe("JSON Patch (RFC 6902) operation type"),
    path: z
      .string()
      .refine(isJsonPointer, {
        message:
          'Patch paths must be valid JSON Pointers -- start with "/", or "" for the root.',
      })
      .describe('Target JSON Pointer path, e.g. "/basics/name"'),
    value: z
      .unknown()
      .optional()
      .describe('Value for "add", "replace", and "test" operations'),
    from: z
      .string()
      .refine(isJsonPointer, {
        message:
          'Patch "from" paths must be valid JSON Pointers -- start with "/", or "" for the root.',
      })
      .optional()
      .describe('Source JSON Pointer path for "move" and "copy" operations'),
  })
  .superRefine((operation, ctx) => {
    if (
      (operation.op === "add" ||
        operation.op === "replace" ||
        operation.op === "test") &&
      !("value" in operation)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `Patch "${operation.op}" operations require a value.`,
      });
    }
    if (
      (operation.op === "move" || operation.op === "copy") &&
      !("from" in operation)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: `Patch "${operation.op}" operations require a from path.`,
      });
    }
  });

const aiFieldSuggestionFieldSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("JSON path of the field being suggested for"),
  label: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Human-readable field label"),
  value: z
    .union([z.string().max(20000), z.array(z.string().max(500)).max(100)])
    .describe("Current field value"),
  valueType: z
    .enum(["plain_text", "html", "string_list"])
    .describe("Shape of the field's value"),
  section: z
    .string()
    .trim()
    .max(120)
    .nullable()
    .optional()
    .describe("Enclosing section name, or null/omit if not sectioned"),
  itemLabel: z
    .string()
    .trim()
    .max(240)
    .nullable()
    .optional()
    .describe("Enclosing item label (e.g. an experience entry), or null/omit"),
});

export const designResumeTools: ToolDef[] = [
  {
    name: "jobops_resume_get",
    description:
      "Read the current Resume Studio document, its lightweight status marker, or its export payload. Wraps GET /api/design-resume, GET /api/design-resume/status, and GET /api/design-resume/export.",
    readOnly: true,
    coverage: [
      "GET /api/design-resume",
      "GET /api/design-resume/status",
      "GET /api/design-resume/export",
    ],
    inputSchema: {
      action: z
        .enum(["get", "status", "export"])
        .optional()
        .describe(
          '"get" (default) fetches the full document; "status" fetches only the exists/documentId/updatedAt marker; "export" fetches the document wrapped with a suggested file name',
        ),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "get";
      if (action === "status") {
        return selfCall(ctx, "GET", "/api/design-resume/status");
      }
      if (action === "export") {
        return selfCall(ctx, "GET", "/api/design-resume/export");
      }
      return selfCall(ctx, "GET", "/api/design-resume");
    },
  },
  {
    name: "jobops_resume_update",
    description:
      'Write the Resume Studio document: replace it wholesale, apply a JSON Patch, import it from Reactive Resume or an uploaded file, or preview an AI suggestion for one field. Wraps PATCH /api/design-resume, POST /api/design-resume/import/rxresume, POST /api/design-resume/import/file, and POST /api/design-resume/ai/field-suggestion. "document" and "patch" both require baseRevision for optimistic concurrency; "document" replaces the ENTIRE stored document (no partial merge -- use "patch" for partial edits); "suggest_field" does not persist anything, it only returns a preview suggestion.',
    coverage: [
      "PATCH /api/design-resume",
      "POST /api/design-resume/import/rxresume",
      "POST /api/design-resume/import/file",
      "POST /api/design-resume/ai/field-suggestion",
    ],
    inputSchema: {
      action: z
        .enum([
          "document",
          "patch",
          "import_rxresume",
          "import_file",
          "suggest_field",
        ])
        .describe("Which write operation to perform"),
      baseRevision: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Revision the caller last read (optimistic concurrency; required for "document" and "patch")',
        ),
      document: z
        .unknown()
        .optional()
        .describe(
          'Complete resume JSON document (required for "document"; this REPLACES the entire stored document, there is no partial merge). Also the base document for "suggest_field" (required there, used only to generate a suggestion, not persisted).',
        ),
      operations: z
        .array(patchOperationSchema)
        .min(1)
        .optional()
        .describe(
          'RFC 6902 JSON Patch operations to apply to the current document (required for "patch")',
        ),
      fileName: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .optional()
        .describe('Uploaded file name (required for "import_file")'),
      mediaType: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe('Uploaded file MIME type ("import_file" only)'),
      dataBase64: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('Base64-encoded file contents (required for "import_file")'),
      field: aiFieldSuggestionFieldSchema
        .optional()
        .describe(
          'Field to suggest a value for (required for "suggest_field")',
        ),
      prompt: z
        .string()
        .trim()
        .min(1)
        .max(3000)
        .optional()
        .describe(
          'Instruction for the suggestion (required for "suggest_field")',
        ),
    },
    handler: (args, ctx) => {
      const action = requireField<string>(args, "action", "resume_update");

      if (action === "document") {
        const baseRevision = requireField<number>(
          args,
          "baseRevision",
          "document",
        );
        const document = requireField<unknown>(args, "document", "document");
        return selfCall(ctx, "PATCH", "/api/design-resume", {
          baseRevision,
          document,
        });
      }
      if (action === "patch") {
        const baseRevision = requireField<number>(
          args,
          "baseRevision",
          "patch",
        );
        const operations = requireField<unknown[]>(args, "operations", "patch");
        return selfCall(ctx, "PATCH", "/api/design-resume", {
          baseRevision,
          operations,
        });
      }
      if (action === "import_rxresume") {
        return selfCall(ctx, "POST", "/api/design-resume/import/rxresume");
      }
      if (action === "import_file") {
        const fileName = requireField<string>(args, "fileName", "import_file");
        const dataBase64 = requireField<string>(
          args,
          "dataBase64",
          "import_file",
        );
        const body = omitUndefined({
          fileName,
          mediaType: args.mediaType,
          dataBase64,
        });
        return selfCall(ctx, "POST", "/api/design-resume/import/file", body);
      }
      if (action === "suggest_field") {
        const document = requireField<unknown>(
          args,
          "document",
          "suggest_field",
        );
        const field = requireField<unknown>(args, "field", "suggest_field");
        const prompt = requireField<string>(args, "prompt", "suggest_field");
        return selfCall(ctx, "POST", "/api/design-resume/ai/field-suggestion", {
          document,
          field,
          prompt,
        });
      }
      throw new Error(`Unknown resume_update action: ${action}`);
    },
  },
  {
    name: "jobops_resume_render",
    description:
      'Generate the Resume Studio PDF, or fetch the download URL for the currently generated PDF. Wraps POST /api/design-resume/generate-pdf and GET /api/design-resume/pdf. "generate" returns the generated file\'s metadata (including its download URL) -- it does not return raw PDF bytes; use "download_url" to fetch the URL for the binary GET route directly instead.',
    coverage: [
      "POST /api/design-resume/generate-pdf",
      "GET /api/design-resume/pdf",
    ],
    inputSchema: {
      action: z
        .enum(["generate", "download_url"])
        .optional()
        .describe(
          '"generate" (default) renders a fresh PDF and returns its metadata; "download_url" returns the path to the binary download route without rendering',
        ),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "generate";
      if (action === "download_url") {
        // Binary download endpoint -- return the path instead of bytes.
        return Promise.resolve({ url: "/api/design-resume/pdf" });
      }
      return selfCall(ctx, "POST", "/api/design-resume/generate-pdf");
    },
  },
  {
    name: "jobops_resume_assets",
    description:
      'List the current document\'s assets, upload a new profile picture, delete the profile picture asset, or get an asset\'s content-download URL. Wraps GET /api/design-resume (for "list"), POST /api/design-resume/assets (JSON body variant only, for "upload"), DELETE /api/design-resume/assets/picture ("delete"), and GET /api/design-resume/assets/:assetId/content ("content_url"). "list" has no dedicated route -- it reads GET /api/design-resume and returns just its "assets" array. Only JSON-body picture upload is supported: raw multipart/binary upload is NOT supported over MCP v1 (multipart upload unsupported over MCP v1). "upload" (like "delete") requires JobOps to be configured as publicly reachable -- otherwise the route returns a 409 conflict, surfaced here as a thrown error.',
    destructive: true,
    coverage: [
      'GET /api/design-resume (assets field, for "list")',
      "POST /api/design-resume/assets (JSON body variant only)",
      "DELETE /api/design-resume/assets/picture",
      "GET /api/design-resume/assets/:assetId/content",
    ],
    inputSchema: {
      action: z
        .enum(["list", "upload", "delete", "content_url"])
        .optional()
        .describe(
          '"list" (default) returns the document\'s assets array; "upload" replaces the profile picture; "delete" removes the profile picture asset; "content_url" returns an asset\'s download URL',
        ),
      assetId: z
        .string()
        .min(1)
        .optional()
        .describe('Asset id (required for "content_url")'),
      fileName: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .optional()
        .describe('Uploaded picture file name (required for "upload")'),
      dataUrl: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Uploaded picture as a FULL data URL, e.g. "data:image/png;base64,iVBORw0..." -- NOT a bare base64 payload (required for "upload")',
        ),
      baseRevision: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Revision the caller last read, for optimistic concurrency ("upload" and "delete" only)',
        ),
      document: z
        .unknown()
        .optional()
        .describe(
          'Base document to apply the picture change to, if different from the currently stored one ("upload" and "delete" only)',
        ),
    },
    handler: async (args, ctx) => {
      const action = (args.action as string | undefined) ?? "list";

      if (action === "list") {
        const document = (await selfCall(ctx, "GET", "/api/design-resume")) as {
          assets?: unknown[];
        };
        return document.assets ?? [];
      }
      if (action === "upload") {
        const fileName = requireField<string>(args, "fileName", "upload");
        const dataUrl = requireField<string>(args, "dataUrl", "upload");
        const body = omitUndefined({
          fileName,
          dataUrl,
          baseRevision: args.baseRevision,
          document: args.document,
        });
        return selfCall(ctx, "POST", "/api/design-resume/assets", body);
      }
      if (action === "delete") {
        const body = omitUndefined({
          baseRevision: args.baseRevision,
          document: args.document,
        });
        return selfCall(
          ctx,
          "DELETE",
          "/api/design-resume/assets/picture",
          Object.keys(body).length > 0 ? body : undefined,
        );
      }
      if (action === "content_url") {
        const assetId = requireField<string>(args, "assetId", "content_url");
        // Binary download endpoint -- return the path instead of bytes.
        return Promise.resolve({
          url: `/api/design-resume/assets/${assetId}/content`,
        });
      }
      throw new Error(`Unknown resume_assets action: ${action}`);
    },
  },
];
