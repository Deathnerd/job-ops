/**
 * Jobs domain MCP tools -- the canonical exemplar every later domain tool
 * file copies. Wraps every route mounted under `/api/jobs` (see
 * `orchestrator/src/server/api/routes/jobs/*.ts`) via `selfCall`.
 *
 * Route -> tool grouping mirrors the route files themselves (one tool per
 * file, action-enum dispatch inside each), except `POST /api/jobs/actions/stream`
 * (Server-Sent Events) which has no non-streaming MCP equivalent and is
 * intentionally NOT covered -- `POST /api/jobs/actions` (the non-streaming
 * bulk endpoint) is covered instead and returns the same final payload.
 */

import { APPLICATION_OUTCOMES, APPLICATION_STAGES } from "@shared/types";
import { z } from "zod";
import { selfCall, type ToolDef } from "../framework";

const JOB_STATUSES = [
  "discovered",
  "processing",
  "ready",
  "applied",
  "in_progress",
  "skipped",
  "expired",
] as const;

const stageEventMetadataShape = {
  note: z
    .string()
    .nullable()
    .optional()
    .describe("Free-text note on the event"),
  actor: z
    .enum(["system", "user"])
    .optional()
    .describe("Who triggered the event"),
  groupId: z
    .string()
    .nullable()
    .optional()
    .describe("Correlates related events together"),
  groupLabel: z
    .string()
    .nullable()
    .optional()
    .describe("Human-readable label for the event group"),
  eventLabel: z
    .string()
    .nullable()
    .optional()
    .describe("Human-readable label for this event"),
  externalUrl: z
    .string()
    .nullable()
    .optional()
    .describe("Related external URL (e.g. calendar invite)"),
  reasonCode: z
    .string()
    .nullable()
    .optional()
    .describe("Machine-readable reason code"),
  eventType: z
    .enum(["interview_log", "status_update", "note"])
    .nullable()
    .optional()
    .describe("Category of this stage event"),
};

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

export const jobsTools: ToolDef[] = [
  {
    name: "jobops_jobs_list",
    description:
      "List jobs or fetch the jobs-list revision marker. Wraps GET /api/jobs and GET /api/jobs/revision.",
    readOnly: true,
    coverage: ["GET /api/jobs", "GET /api/jobs/revision"],
    inputSchema: {
      action: z
        .enum(["list", "revision"])
        .optional()
        .describe(
          '"list" (default) fetches jobs; "revision" fetches only the revision marker',
        ),
      status: z
        .string()
        .optional()
        .describe('Comma-separated JobStatus filter, e.g. "ready,applied"'),
      view: z
        .enum(["full", "list"])
        .optional()
        .describe(
          '"list" (default) returns lightweight list items; "full" returns full Job records',
        ),
    },
    handler: (args, ctx) => {
      const action = (args.action as string | undefined) ?? "list";
      if (action === "revision") {
        const qs = toQueryString({ status: args.status });
        return selfCall(ctx, "GET", `/api/jobs/revision${qs}`);
      }
      const qs = toQueryString({ status: args.status, view: args.view });
      return selfCall(ctx, "GET", `/api/jobs${qs}`);
    },
  },
  {
    name: "jobops_job_get",
    description:
      "Fetch a single job, its post-application emails, or its generated-PDF URL. Wraps GET /api/jobs/:id, GET /api/jobs/:id/emails, and GET /api/jobs/:id/pdf.",
    readOnly: true,
    coverage: [
      "GET /api/jobs/:id",
      "GET /api/jobs/:id/emails",
      "GET /api/jobs/:id/pdf",
    ],
    inputSchema: {
      id: z.string().min(1).describe("Job id"),
      action: z
        .enum(["get", "emails", "pdf_url"])
        .optional()
        .describe(
          '"get" (default) fetches the job; "emails" lists post-application emails; "pdf_url" returns the PDF download path',
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Max emails to return (only used by action "emails"; server applies its own default/max)',
        ),
    },
    handler: (args, ctx) => {
      const id = requireField<string>(args, "id", "get_job");
      const action = (args.action as string | undefined) ?? "get";
      if (action === "emails") {
        const qs = toQueryString({ limit: args.limit });
        return selfCall(ctx, "GET", `/api/jobs/${id}/emails${qs}`);
      }
      if (action === "pdf_url") {
        // Binary download endpoint -- return the path instead of bytes.
        return Promise.resolve({ url: `/api/jobs/${id}/pdf` });
      }
      return selfCall(ctx, "GET", `/api/jobs/${id}`);
    },
  },
  {
    name: "jobops_job_update",
    description:
      "Update a job's editable fields (status, outcome, tailoring content, etc). Wraps PATCH /api/jobs/:id.",
    coverage: ["PATCH /api/jobs/:id"],
    inputSchema: {
      id: z.string().min(1).describe("Job id"),
      title: z.string().min(1).max(500).optional().describe("Job title"),
      employer: z.string().min(1).max(500).optional().describe("Employer name"),
      jobUrl: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe("Canonical job posting URL"),
      applicationLink: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Direct application URL, or null to clear"),
      location: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe("Job location, or null to clear"),
      salary: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe("Salary text, or null to clear"),
      deadline: z
        .string()
        .max(100)
        .nullable()
        .optional()
        .describe("Application deadline text, or null to clear"),
      status: z.enum(JOB_STATUSES).optional().describe("New job status"),
      outcome: z
        .enum(APPLICATION_OUTCOMES)
        .nullable()
        .optional()
        .describe("Application outcome, or null to clear"),
      closedAt: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "Unix seconds timestamp the application was closed, or null to clear",
        ),
      jobDescription: z
        .string()
        .max(40000)
        .nullable()
        .optional()
        .describe("Full job description text, or null to clear"),
      suitabilityScore: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Suitability score (0-100)"),
      suitabilityReason: z
        .string()
        .optional()
        .describe("Explanation for the suitability score"),
      jobBrief: z
        .string()
        .nullable()
        .optional()
        .describe("Generated job brief, or null to clear"),
      tailoredSummary: z
        .string()
        .optional()
        .describe("Tailored resume summary text"),
      tailoredHeadline: z
        .string()
        .optional()
        .describe("Tailored resume headline text"),
      tailoredSkills: z
        .string()
        .optional()
        .describe("JSON-encoded array of { name, keywords } skill groups"),
      selectedProjectIds: z
        .string()
        .optional()
        .describe("Serialized selected project ids"),
      pdfPath: z
        .string()
        .optional()
        .describe("Server-relative path to the generated PDF"),
      tracerLinksEnabled: z
        .boolean()
        .optional()
        .describe("Whether tracer links are enabled for this job"),
      sponsorMatchScore: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Visa sponsor match score (0-100)"),
      sponsorMatchNames: z
        .string()
        .optional()
        .describe("Serialized matched sponsor names"),
    },
    handler: (args, ctx) => {
      const id = requireField<string>(args, "id", "update_job");
      const { id: _id, ...rest } = args;
      return selfCall(ctx, "PATCH", `/api/jobs/${id}`, omitUndefined(rest));
    },
  },
  {
    name: "jobops_job_notes",
    description:
      "List, add, update, or delete notes on a job. Wraps GET/POST /api/jobs/:id/notes and PATCH/DELETE /api/jobs/:id/notes/:noteId.",
    destructive: true,
    coverage: [
      "GET /api/jobs/:id/notes",
      "POST /api/jobs/:id/notes",
      "PATCH /api/jobs/:id/notes/:noteId",
      "DELETE /api/jobs/:id/notes/:noteId",
    ],
    inputSchema: {
      id: z.string().min(1).describe("Job id"),
      action: z
        .enum(["list", "add", "update", "delete"])
        .describe("Which note operation to perform"),
      noteId: z
        .string()
        .optional()
        .describe('Note id (required for "update" and "delete")'),
      title: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('Note title (required for "add" and "update")'),
      content: z
        .string()
        .min(1)
        .max(20000)
        .optional()
        .describe('Note content (required for "add" and "update")'),
    },
    handler: (args, ctx) => {
      const id = requireField<string>(args, "id", "job_notes");
      const action = requireField<string>(args, "action", "job_notes");

      if (action === "list") {
        return selfCall(ctx, "GET", `/api/jobs/${id}/notes`);
      }
      if (action === "add") {
        const title = requireField<string>(args, "title", "add");
        const content = requireField<string>(args, "content", "add");
        return selfCall(ctx, "POST", `/api/jobs/${id}/notes`, {
          title,
          content,
        });
      }
      if (action === "update") {
        const noteId = requireField<string>(args, "noteId", "update");
        const title = requireField<string>(args, "title", "update");
        const content = requireField<string>(args, "content", "update");
        return selfCall(ctx, "PATCH", `/api/jobs/${id}/notes/${noteId}`, {
          title,
          content,
        });
      }
      if (action === "delete") {
        const noteId = requireField<string>(args, "noteId", "delete");
        return selfCall(ctx, "DELETE", `/api/jobs/${id}/notes/${noteId}`);
      }
      throw new Error(`Unknown job_notes action: ${action}`);
    },
  },
  {
    name: "jobops_job_stages",
    description:
      "Manage a job's application-stage timeline: list stage events/tasks, transition to a new stage, edit or delete a stage event, or set the final outcome. Wraps GET /api/jobs/:id/events, GET /api/jobs/:id/tasks, POST /api/jobs/:id/stages, PATCH /api/jobs/:id/events/:eventId, DELETE /api/jobs/:id/events/:eventId, and PATCH /api/jobs/:id/outcome.",
    destructive: true,
    coverage: [
      "GET /api/jobs/:id/events",
      "GET /api/jobs/:id/tasks",
      "POST /api/jobs/:id/stages",
      "PATCH /api/jobs/:id/events/:eventId",
      "DELETE /api/jobs/:id/events/:eventId",
      "PATCH /api/jobs/:id/outcome",
    ],
    inputSchema: {
      id: z.string().min(1).describe("Job id"),
      action: z
        .enum([
          "list_events",
          "list_tasks",
          "transition",
          "update_event",
          "delete_event",
          "set_outcome",
        ])
        .describe("Which stage operation to perform"),
      eventId: z
        .string()
        .optional()
        .describe(
          'Stage event id (required for "update_event" and "delete_event")',
        ),
      includeCompleted: z
        .boolean()
        .optional()
        .describe('Include completed tasks (only used by "list_tasks")'),
      toStage: z
        .enum([...APPLICATION_STAGES, "no_change"])
        .optional()
        .describe(
          'Target stage; "transition" requires one of the application stages or "no_change", "update_event" accepts an application stage only',
        ),
      occurredAt: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          'Unix seconds timestamp the event occurred ("transition"/"update_event")',
        ),
      metadata: z
        .object(stageEventMetadataShape)
        .nullable()
        .optional()
        .describe('Stage event metadata ("transition"/"update_event")'),
      outcome: z
        .enum(APPLICATION_OUTCOMES)
        .nullable()
        .optional()
        .describe(
          'Application outcome ("transition", "update_event", required for "set_outcome")',
        ),
      closedAt: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          'Unix seconds timestamp the application closed (only used by "set_outcome")',
        ),
    },
    handler: (args, ctx) => {
      const id = requireField<string>(args, "id", "job_stages");
      const action = requireField<string>(args, "action", "job_stages");

      if (action === "list_events") {
        return selfCall(ctx, "GET", `/api/jobs/${id}/events`);
      }
      if (action === "list_tasks") {
        const qs = toQueryString({ includeCompleted: args.includeCompleted });
        return selfCall(ctx, "GET", `/api/jobs/${id}/tasks${qs}`);
      }
      if (action === "transition") {
        const toStage = requireField<string>(args, "toStage", "transition");
        const body = omitUndefined({
          toStage,
          occurredAt: args.occurredAt,
          metadata: args.metadata,
          outcome: args.outcome,
        });
        return selfCall(ctx, "POST", `/api/jobs/${id}/stages`, body);
      }
      if (action === "update_event") {
        const eventId = requireField<string>(args, "eventId", "update_event");
        if (args.toStage === "no_change") {
          throw new Error(
            'invalid_argument: toStage "no_change" is not valid for update_event',
          );
        }
        const body = omitUndefined({
          toStage: args.toStage,
          // PATCH /api/jobs/:id/events/:eventId's occurredAt is NOT
          // nullable (unlike POST /api/jobs/:id/stages), so a null value
          // here would be a guaranteed 400. Treat null as omitted.
          occurredAt: args.occurredAt === null ? undefined : args.occurredAt,
          metadata: args.metadata,
          outcome: args.outcome,
        });
        return selfCall(
          ctx,
          "PATCH",
          `/api/jobs/${id}/events/${eventId}`,
          body,
        );
      }
      if (action === "delete_event") {
        const eventId = requireField<string>(args, "eventId", "delete_event");
        return selfCall(ctx, "DELETE", `/api/jobs/${id}/events/${eventId}`);
      }
      if (action === "set_outcome") {
        if (!Object.hasOwn(args, "outcome")) {
          throw new Error('"outcome" is required for action "set_outcome"');
        }
        const body = omitUndefined({
          outcome: args.outcome ?? null,
          closedAt: args.closedAt,
        });
        return selfCall(ctx, "PATCH", `/api/jobs/${id}/outcome`, body);
      }
      throw new Error(`Unknown job_stages action: ${action}`);
    },
  },
  {
    name: "jobops_job_documents",
    description:
      "Manage a job's PDF and supporting documents: upload the tailored resume PDF, list/upload/delete supporting documents, fetch a document's content URL, trigger tailoring summarization, or regenerate the resume PDF. Wraps POST /api/jobs/:id/pdf, GET/POST /api/jobs/:id/documents, GET /api/jobs/:id/documents/:documentId/content, DELETE /api/jobs/:id/documents/:documentId, POST /api/jobs/:id/summarize, and POST /api/jobs/:id/generate-pdf.",
    destructive: true,
    coverage: [
      "POST /api/jobs/:id/pdf",
      "GET /api/jobs/:id/documents",
      "POST /api/jobs/:id/documents",
      "GET /api/jobs/:id/documents/:documentId/content",
      "DELETE /api/jobs/:id/documents/:documentId",
      "POST /api/jobs/:id/summarize",
      "POST /api/jobs/:id/generate-pdf",
    ],
    inputSchema: {
      id: z.string().min(1).describe("Job id"),
      action: z
        .enum([
          "upload_pdf",
          "list",
          "upload",
          "get_content_url",
          "delete",
          "summarize",
          "generate_pdf",
        ])
        .describe("Which document operation to perform"),
      documentId: z
        .string()
        .optional()
        .describe('Document id (required for "get_content_url" and "delete")'),
      fileName: z
        .string()
        .min(1)
        .max(255)
        .optional()
        .describe(
          'Uploaded file name (required for "upload_pdf" and "upload")',
        ),
      mediaType: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe('Uploaded file MIME type ("upload_pdf" and "upload")'),
      dataBase64: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Base64-encoded file contents (required for "upload_pdf" and "upload")',
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          'Force re-summarization even if tailoring looks current (only used by "summarize")',
        ),
      fields: z
        .string()
        .optional()
        .describe(
          'Comma-separated subset of "summary,headline,skills" to regenerate (only used by "summarize")',
        ),
    },
    handler: (args, ctx) => {
      const id = requireField<string>(args, "id", "job_documents");
      const action = requireField<string>(args, "action", "job_documents");

      if (action === "upload_pdf" || action === "upload") {
        const fileName = requireField<string>(args, "fileName", action);
        const dataBase64 = requireField<string>(args, "dataBase64", action);
        // POST /api/jobs/:id/pdf's mediaType is optional but NOT nullable
        // (unlike POST /api/jobs/:id/documents), so a null value here would
        // be a guaranteed 400. Treat null as omitted for upload_pdf only.
        const mediaType =
          action === "upload_pdf" && args.mediaType === null
            ? undefined
            : args.mediaType;
        const body = omitUndefined({
          fileName,
          mediaType,
          dataBase64,
        });
        const path =
          action === "upload_pdf"
            ? `/api/jobs/${id}/pdf`
            : `/api/jobs/${id}/documents`;
        return selfCall(ctx, "POST", path, body);
      }
      if (action === "list") {
        return selfCall(ctx, "GET", `/api/jobs/${id}/documents`);
      }
      if (action === "get_content_url") {
        const documentId = requireField<string>(
          args,
          "documentId",
          "get_content_url",
        );
        // Binary download endpoint -- return the path instead of bytes.
        return Promise.resolve({
          url: `/api/jobs/${id}/documents/${documentId}/content`,
        });
      }
      if (action === "delete") {
        const documentId = requireField<string>(args, "documentId", "delete");
        return selfCall(
          ctx,
          "DELETE",
          `/api/jobs/${id}/documents/${documentId}`,
        );
      }
      if (action === "summarize") {
        const qs = toQueryString({ force: args.force, fields: args.fields });
        return selfCall(ctx, "POST", `/api/jobs/${id}/summarize${qs}`);
      }
      if (action === "generate_pdf") {
        return selfCall(ctx, "POST", `/api/jobs/${id}/generate-pdf`);
      }
      throw new Error(`Unknown job_documents action: ${action}`);
    },
  },
  {
    name: "jobops_job_application",
    description:
      "Check visa-sponsor match for a job's employer, or mark a job as applied. Wraps POST /api/jobs/:id/check-sponsor and POST /api/jobs/:id/apply.",
    coverage: ["POST /api/jobs/:id/check-sponsor", "POST /api/jobs/:id/apply"],
    inputSchema: {
      id: z.string().min(1).describe("Job id"),
      action: z
        .enum(["check_sponsor", "apply"])
        .describe("Which application operation to perform"),
    },
    handler: (args, ctx) => {
      const id = requireField<string>(args, "id", "job_application");
      const action = requireField<string>(args, "action", "job_application");

      if (action === "check_sponsor") {
        return selfCall(ctx, "POST", `/api/jobs/${id}/check-sponsor`);
      }
      if (action === "apply") {
        return selfCall(ctx, "POST", `/api/jobs/${id}/apply`);
      }
      throw new Error(`Unknown job_application action: ${action}`);
    },
  },
  {
    name: "jobops_job_actions",
    description:
      'Run bulk or single-job pipeline actions: bulk skip/rescore/move-to-ready across many jobs, or move a single job to ready, skip it, or rescore it. Wraps POST /api/jobs/actions, POST /api/jobs/:id/process, POST /api/jobs/:id/skip, and POST /api/jobs/:id/rescore. Note: POST /api/jobs/actions/stream (the Server-Sent Events progress variant of the bulk endpoint) has no MCP equivalent -- use "bulk" for the same final result without streaming.',
    coverage: [
      "POST /api/jobs/actions",
      "POST /api/jobs/:id/process",
      "POST /api/jobs/:id/skip",
      "POST /api/jobs/:id/rescore",
    ],
    inputSchema: {
      action: z
        .enum(["bulk", "process", "skip", "rescore"])
        .describe("Which job-action operation to perform"),
      id: z
        .string()
        .optional()
        .describe('Job id (required for "process", "skip", and "rescore")'),
      jobIds: z
        .array(z.string().min(1))
        .min(1)
        .max(100)
        .optional()
        .describe('Job ids to act on (required for "bulk")'),
      bulkAction: z
        .enum(["skip", "rescore", "move_to_ready"])
        .optional()
        .describe('Which bulk action to run (required for "bulk")'),
      force: z
        .boolean()
        .optional()
        .describe(
          'Force the move even if not otherwise eligible ("bulk" move_to_ready, and "process")',
        ),
    },
    handler: (args, ctx) => {
      const action = requireField<string>(args, "action", "job_actions");

      if (action === "bulk") {
        const jobIds = requireField<string[]>(args, "jobIds", "bulk");
        const bulkAction = requireField<string>(args, "bulkAction", "bulk");
        const body: Record<string, unknown> = {
          action: bulkAction,
          jobIds,
        };
        if (bulkAction === "move_to_ready" && args.force !== undefined) {
          body.options = { force: args.force };
        }
        return selfCall(ctx, "POST", "/api/jobs/actions", body);
      }

      const id = requireField<string>(args, "id", action);
      if (action === "process") {
        const qs = toQueryString({ force: args.force });
        return selfCall(ctx, "POST", `/api/jobs/${id}/process${qs}`);
      }
      if (action === "skip") {
        return selfCall(ctx, "POST", `/api/jobs/${id}/skip`);
      }
      if (action === "rescore") {
        return selfCall(ctx, "POST", `/api/jobs/${id}/rescore`);
      }
      throw new Error(`Unknown job_actions action: ${action}`);
    },
  },
  {
    name: "jobops_jobs_maintenance",
    description:
      "Bulk-delete jobs by status or by suitability score threshold. Wraps DELETE /api/jobs/status/:status and DELETE /api/jobs/score/:threshold.",
    destructive: true,
    coverage: [
      "DELETE /api/jobs/status/:status",
      "DELETE /api/jobs/score/:threshold",
    ],
    inputSchema: {
      action: z
        .enum(["delete_by_status", "delete_below_score"])
        .describe("Which maintenance operation to perform"),
      status: z
        .enum(JOB_STATUSES)
        .optional()
        .describe('Job status to clear (required for "delete_by_status")'),
      threshold: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe(
          'Suitability score threshold, exclusive upper bound (required for "delete_below_score")',
        ),
    },
    handler: (args, ctx) => {
      const action = requireField<string>(args, "action", "jobs_maintenance");

      if (action === "delete_by_status") {
        const status = requireField<string>(args, "status", "delete_by_status");
        return selfCall(ctx, "DELETE", `/api/jobs/status/${status}`);
      }
      if (action === "delete_below_score") {
        const threshold = args.threshold;
        if (threshold === undefined) {
          throw new Error(
            '"threshold" is required for action "delete_below_score"',
          );
        }
        return selfCall(ctx, "DELETE", `/api/jobs/score/${threshold}`);
      }
      throw new Error(`Unknown jobs_maintenance action: ${action}`);
    },
  },
];
