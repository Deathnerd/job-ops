/**
 * Ghostwriter (job chat) domain MCP tools -- wraps every route mounted at
 * `/api/jobs/:id/chat` (see `orchestrator/src/server/api/routes/ghostwriter.ts`,
 * mounted via `apiRouter.use("/jobs/:id/chat", ghostwriterRouter)` in
 * `api/routes.ts`) via `selfCall`.
 *
 * The route file exposes two parallel surfaces over the same underlying
 * conversation state:
 *  - "Job-level" routes (`/messages`, `/context`, `/reset`, ...) operate on
 *    the job's implicit default thread, creating it on first use
 *    (`ensureJobThread`). No `threadId` is needed.
 *  - "Thread-level" routes (`/threads`, `/threads/:threadId/messages`, ...)
 *    take an explicit `threadId`.
 * Today the server only ever creates one thread per job (`listThreads`
 * literally returns `[thread]`, and `createThread` ignores the `title` it
 * accepts and just re-fetches that same thread), so the two surfaces are
 * currently equivalent for send/regenerate -- but only the job-level routes
 * expose edit, switch-branch, and reset. These tools mirror that asymmetry
 * exactly rather than inventing thread-level equivalents that don't exist.
 *
 * Route -> tool grouping:
 *  - `jobops_chat_threads` -- list/create threads, list messages (job-level
 *    or thread-level), and update the job-level chat context selection.
 *  - `jobops_chat_send` -- every message-mutating operation: send,
 *    regenerate, edit, switch active branch, and reset the conversation.
 *    `destructive: true` because "reset" deletes all messages and runs for
 *    the thread.
 *  - `jobops_chat_runs` -- cancel an in-progress chat generation run
 *    (job-level or thread-level).
 *
 * Streaming: `sendMessage`/`regenerateMessage`/`editMessage` all accept a
 * `stream: boolean` body field that switches the route to an SSE response.
 * These tools never send `stream: true` -- there is no MCP transport for a
 * server-push stream, and the non-streaming code path is a fully-supported,
 * first-class route behavior (it blocks until the LLM reply completes, then
 * returns the final message), not a fallback. Note this is a synchronous,
 * LLM-bound call against `selfCall`'s 60s timeout, the same tradeoff already
 * accepted by `jobops_job_actions`' "process"/"rescore" actions in jobs.ts.
 *
 * No run-status route exists (only cancel) -- `jobops_chat_runs` is
 * cancel-only, not the "(status)" shape sketched in the task brief. Poll
 * `jobops_chat_threads(action: "messages")` and read the assistant message's
 * `status` field to track an in-flight run instead.
 */

import { z } from "zod";
import { selfCall, type ToolDef } from "../framework";

const attachmentInputShape = {
  id: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe("Client-generated attachment id"),
  name: z.string().trim().min(1).max(180).describe("Attachment file name"),
  mediaType: z
    .enum(["image/png", "image/jpeg", "image/webp"])
    .describe("Attachment media type"),
  dataUrl: z
    .string()
    .max(2_800_000)
    .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
    .describe(
      'Base64 data URL, e.g. "data:image/png;base64,..." -- must match mediaType',
    ),
};

const attachmentSchema = z
  .object(attachmentInputShape)
  .superRefine((attachment, ctx) => {
    if (
      !attachment.dataUrl.startsWith(`data:${attachment.mediaType};base64,`)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dataUrl"],
        message:
          "Image data URL media type must match the attachment media type.",
      });
    }
  });

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

export const ghostwriterTools: ToolDef[] = [
  {
    name: "jobops_chat_threads",
    description:
      'List or create job chat threads, list messages, or update the job-level chat context selection. Wraps GET/POST /api/jobs/:id/chat/threads, GET /api/jobs/:id/chat/threads/:threadId/messages, GET /api/jobs/:id/chat/messages, and PATCH /api/jobs/:id/chat/context. Note: the server currently maintains exactly one thread per job -- "list" always returns a single-element array, and "create" ignores its "title" argument and returns that same thread.',
    coverage: [
      "GET /api/jobs/:id/chat/threads",
      "POST /api/jobs/:id/chat/threads",
      "GET /api/jobs/:id/chat/threads/:threadId/messages",
      "GET /api/jobs/:id/chat/messages",
      "PATCH /api/jobs/:id/chat/context",
    ],
    inputSchema: {
      id: z.string().min(1).describe("Job id"),
      action: z
        .enum(["list", "create", "messages", "update_context"])
        .describe("Which thread operation to perform"),
      threadId: z
        .string()
        .optional()
        .describe(
          'Thread id (only used by "messages"; omit to read the job-level default thread). Not accepted by "list", "create", or "update_context".',
        ),
      title: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe(
          'Thread title ("create" only; accepted by the route but currently a no-op server-side)',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Max messages to return ("messages" only)'),
      offset: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .optional()
        .describe('Message offset for pagination ("messages" only)'),
      selectedNoteIds: z
        .array(z.string().trim().min(1))
        .optional()
        .describe('Note ids to select as chat context ("update_context" only)'),
      selectedEmailIds: z
        .array(z.string().trim().min(1))
        .optional()
        .describe(
          'Email ids to select as chat context ("update_context" only)',
        ),
      selectedDocumentIds: z
        .array(z.string().trim().min(1))
        .optional()
        .describe(
          'Document ids to select as chat context ("update_context" only)',
        ),
    },
    handler: (args, ctx) => {
      const id = requireField<string>(args, "id", "chat_threads");
      const action = requireField<string>(args, "action", "chat_threads");
      const threadId = args.threadId as string | undefined;

      if (action === "list") {
        return selfCall(ctx, "GET", `/api/jobs/${id}/chat/threads`);
      }
      if (action === "create") {
        const body = omitUndefined({ title: args.title });
        return selfCall(ctx, "POST", `/api/jobs/${id}/chat/threads`, body);
      }
      if (action === "messages") {
        const qs = toQueryString({ limit: args.limit, offset: args.offset });
        const path = threadId
          ? `/api/jobs/${id}/chat/threads/${threadId}/messages${qs}`
          : `/api/jobs/${id}/chat/messages${qs}`;
        return selfCall(ctx, "GET", path);
      }
      if (action === "update_context") {
        if (threadId !== undefined) {
          throw new Error(
            'invalid_argument: "threadId" is not supported for action "update_context" -- it only operates on the job-level default thread',
          );
        }
        if (
          args.selectedNoteIds === undefined &&
          args.selectedEmailIds === undefined &&
          args.selectedDocumentIds === undefined
        ) {
          throw new Error(
            'invalid_argument: at least one of "selectedNoteIds", "selectedEmailIds", or "selectedDocumentIds" must be provided for action "update_context"',
          );
        }
        const body = omitUndefined({
          selectedNoteIds: args.selectedNoteIds,
          selectedEmailIds: args.selectedEmailIds,
          selectedDocumentIds: args.selectedDocumentIds,
        });
        return selfCall(ctx, "PATCH", `/api/jobs/${id}/chat/context`, body);
      }
      throw new Error(`Unknown chat_threads action: ${action}`);
    },
  },
  {
    name: "jobops_chat_send",
    description:
      "Send a chat message, regenerate an assistant reply, edit a prior message, switch the active conversation branch, or reset the conversation. Wraps POST /api/jobs/:id/chat/messages, POST /api/jobs/:id/chat/threads/:threadId/messages, POST /api/jobs/:id/chat/messages/:assistantMessageId/regenerate, POST /api/jobs/:id/chat/threads/:threadId/messages/:assistantMessageId/regenerate, POST /api/jobs/:id/chat/messages/:messageId/edit, POST /api/jobs/:id/chat/messages/:messageId/switch-branch, and POST /api/jobs/:id/chat/reset. Always calls the non-streaming variant of send/regenerate/edit -- the SSE streaming mode has no MCP equivalent, but the call still blocks until the LLM reply finishes generating.",
    destructive: true,
    coverage: [
      "POST /api/jobs/:id/chat/messages",
      "POST /api/jobs/:id/chat/threads/:threadId/messages",
      "POST /api/jobs/:id/chat/messages/:assistantMessageId/regenerate",
      "POST /api/jobs/:id/chat/threads/:threadId/messages/:assistantMessageId/regenerate",
      "POST /api/jobs/:id/chat/messages/:messageId/edit",
      "POST /api/jobs/:id/chat/messages/:messageId/switch-branch",
      "POST /api/jobs/:id/chat/reset",
    ],
    inputSchema: {
      id: z.string().min(1).describe("Job id"),
      action: z
        .enum(["send", "regenerate", "edit", "switch_branch", "reset"])
        .describe("Which message operation to perform"),
      threadId: z
        .string()
        .optional()
        .describe(
          'Thread id ("send" and "regenerate" only; omit to use the job-level default thread). Not accepted by "edit", "switch_branch", or "reset".',
        ),
      content: z
        .string()
        .trim()
        .min(1)
        .max(20000)
        .optional()
        .describe('Message content (required for "send" and "edit")'),
      messageId: z
        .string()
        .optional()
        .describe(
          'Message id (required for "edit" and "switch_branch": the message to edit, or the message to make the active branch)',
        ),
      assistantMessageId: z
        .string()
        .optional()
        .describe(
          'Assistant message id to regenerate (required for "regenerate")',
        ),
      attachments: z
        .array(attachmentSchema)
        .max(3)
        .optional()
        .describe('Up to 3 image attachments ("send" and "edit" only)'),
      selectedNoteIds: z
        .array(z.string().trim().min(1))
        .optional()
        .describe(
          'Note ids to select as chat context, replacing the current selection ("send", "regenerate", and "edit" only)',
        ),
      selectedEmailIds: z
        .array(z.string().trim().min(1))
        .optional()
        .describe(
          'Email ids to select as chat context, replacing the current selection ("send", "regenerate", and "edit" only)',
        ),
      selectedDocumentIds: z
        .array(z.string().trim().min(1))
        .optional()
        .describe(
          'Document ids to select as chat context, replacing the current selection ("send", "regenerate", and "edit" only)',
        ),
    },
    handler: (args, ctx) => {
      const id = requireField<string>(args, "id", "chat_send");
      const action = requireField<string>(args, "action", "chat_send");
      const threadId = args.threadId as string | undefined;

      const rejectThreadId = (forAction: string) => {
        if (threadId !== undefined) {
          throw new Error(
            `invalid_argument: "threadId" is not supported for action "${forAction}" -- it only operates on the job-level default thread`,
          );
        }
      };

      const selectedContext = omitUndefined({
        selectedNoteIds: args.selectedNoteIds,
        selectedEmailIds: args.selectedEmailIds,
        selectedDocumentIds: args.selectedDocumentIds,
      });

      if (action === "send") {
        const content = requireField<string>(args, "content", "send");
        const body = omitUndefined({
          content,
          attachments: args.attachments,
          ...selectedContext,
        });
        const path = threadId
          ? `/api/jobs/${id}/chat/threads/${threadId}/messages`
          : `/api/jobs/${id}/chat/messages`;
        return selfCall(ctx, "POST", path, body);
      }
      if (action === "regenerate") {
        const assistantMessageId = requireField<string>(
          args,
          "assistantMessageId",
          "regenerate",
        );
        const body = omitUndefined(selectedContext);
        const path = threadId
          ? `/api/jobs/${id}/chat/threads/${threadId}/messages/${assistantMessageId}/regenerate`
          : `/api/jobs/${id}/chat/messages/${assistantMessageId}/regenerate`;
        return selfCall(ctx, "POST", path, body);
      }
      if (action === "edit") {
        rejectThreadId("edit");
        const messageId = requireField<string>(args, "messageId", "edit");
        const content = requireField<string>(args, "content", "edit");
        const body = omitUndefined({
          content,
          attachments: args.attachments,
          ...selectedContext,
        });
        return selfCall(
          ctx,
          "POST",
          `/api/jobs/${id}/chat/messages/${messageId}/edit`,
          body,
        );
      }
      if (action === "switch_branch") {
        rejectThreadId("switch_branch");
        const messageId = requireField<string>(
          args,
          "messageId",
          "switch_branch",
        );
        return selfCall(
          ctx,
          "POST",
          `/api/jobs/${id}/chat/messages/${messageId}/switch-branch`,
        );
      }
      if (action === "reset") {
        rejectThreadId("reset");
        return selfCall(ctx, "POST", `/api/jobs/${id}/chat/reset`);
      }
      throw new Error(`Unknown chat_send action: ${action}`);
    },
  },
  {
    name: "jobops_chat_runs",
    description:
      'Cancel an in-progress chat generation run. Wraps POST /api/jobs/:id/chat/runs/:runId/cancel and POST /api/jobs/:id/chat/threads/:threadId/runs/:runId/cancel. Note: there is no run-status polling route -- poll jobops_chat_threads(action: "messages") and inspect the assistant message\'s "status" field to track an in-flight run instead.',
    coverage: [
      "POST /api/jobs/:id/chat/runs/:runId/cancel",
      "POST /api/jobs/:id/chat/threads/:threadId/runs/:runId/cancel",
    ],
    inputSchema: {
      id: z.string().min(1).describe("Job id"),
      runId: z.string().min(1).describe("Chat run id to cancel"),
      threadId: z
        .string()
        .optional()
        .describe("Thread id; omit to use the job-level default thread"),
    },
    handler: (args, ctx) => {
      const id = requireField<string>(args, "id", "chat_runs");
      const runId = requireField<string>(args, "runId", "chat_runs");
      const threadId = args.threadId as string | undefined;
      const path = threadId
        ? `/api/jobs/${id}/chat/threads/${threadId}/runs/${runId}/cancel`
        : `/api/jobs/${id}/chat/runs/${runId}/cancel`;
      return selfCall(ctx, "POST", path);
    },
  },
];
