import type { Server } from "node:http";
import { startServer, stopServer } from "@server/api/routes/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

const GHOSTWRITER_TOOL_NAMES = [
  "jobops_chat_threads",
  "jobops_chat_send",
  "jobops_chat_runs",
];

const baseMsgFields = {
  threadId: "thread-1",
  jobId: "job-1",
  tokensIn: 1,
  tokensOut: null,
  version: 1,
  replacesMessageId: null,
  parentMessageId: null,
  activeChildId: null,
  attachments: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const thread = {
  id: "thread-1",
  jobId: "job-1",
  title: "Thread",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastMessageAt: new Date().toISOString(),
  activeRootMessageId: null,
  selectedNoteIds: [],
  selectedEmailIds: [],
  selectedDocumentIds: [],
};

// Never mocked in test-utils.ts (unlike pipeline/scorer/etc) because
// ghostwriter routes reach a real LlmService by default -- mock the service
// module directly here, the same pattern api/routes/ghostwriter.test.ts uses,
// so these tests never make a real LLM call.
vi.mock("@server/services/ghostwriter", () => ({
  listThreads: vi.fn(async () => [thread]),
  createThread: vi.fn(async () => thread),
  updateContextForJob: vi.fn(
    async (input: {
      selectedNoteIds?: string[];
      selectedEmailIds?: string[];
      selectedDocumentIds?: string[];
    }) => ({
      selectedNoteIds: input.selectedNoteIds ?? [],
      selectedEmailIds: input.selectedEmailIds ?? [],
      selectedDocumentIds: input.selectedDocumentIds ?? [],
    }),
  ),
  listMessages: vi.fn(async () => ({
    messages: [
      {
        id: "message-1",
        ...baseMsgFields,
        role: "user",
        content: "hello",
        status: "complete",
      },
    ],
    branches: [],
  })),
  listMessagesForJob: vi.fn(async () => ({
    messages: [
      {
        id: "message-1",
        ...baseMsgFields,
        role: "user",
        content: "hello",
        status: "complete",
      },
    ],
    branches: [],
    selectedNoteIds: [],
    selectedEmailIds: [],
    selectedDocumentIds: [],
  })),
  sendMessage: vi.fn(async () => ({
    userMessage: {
      id: "user-1",
      ...baseMsgFields,
      role: "user",
      content: "hello",
      status: "complete",
    },
    assistantMessage: {
      id: "assistant-1",
      ...baseMsgFields,
      role: "assistant",
      content: "hi",
      status: "complete",
      tokensOut: 1,
    },
    runId: "run-1",
  })),
  sendMessageForJob: vi.fn(async () => ({
    userMessage: {
      id: "user-1",
      ...baseMsgFields,
      role: "user",
      content: "hello",
      status: "complete",
    },
    assistantMessage: {
      id: "assistant-1",
      ...baseMsgFields,
      role: "assistant",
      content: "hi",
      status: "complete",
      tokensOut: 1,
    },
    runId: "run-1",
  })),
  cancelRun: vi.fn(async () => ({ cancelled: true, alreadyFinished: false })),
  cancelRunForJob: vi.fn(async () => ({
    cancelled: true,
    alreadyFinished: false,
  })),
  regenerateMessage: vi.fn(async () => ({
    runId: "run-2",
    assistantMessage: {
      id: "assistant-2",
      ...baseMsgFields,
      role: "assistant",
      content: "updated",
      status: "complete",
      tokensOut: 1,
      version: 2,
    },
  })),
  regenerateMessageForJob: vi.fn(async () => ({
    runId: "run-2",
    assistantMessage: {
      id: "assistant-2",
      ...baseMsgFields,
      role: "assistant",
      content: "updated",
      status: "complete",
      tokensOut: 1,
      version: 2,
    },
  })),
  editMessageForJob: vi.fn(async () => ({
    userMessage: {
      id: "user-2",
      ...baseMsgFields,
      role: "user",
      content: "edited",
      status: "complete",
    },
    assistantMessage: {
      id: "assistant-3",
      ...baseMsgFields,
      role: "assistant",
      content: "updated reply",
      status: "complete",
      tokensOut: 1,
    },
    runId: "run-3",
  })),
  switchBranchForJob: vi.fn(async () => ({
    messages: [
      {
        id: "message-1",
        ...baseMsgFields,
        role: "user",
        content: "hello",
        status: "complete",
      },
    ],
    branches: [],
  })),
  resetConversationForJob: vi.fn(async () => ({
    deletedMessages: 2,
    deletedRuns: 1,
  })),
}));

async function readMcpJsonRpc(res: Response): Promise<any> {
  // Stateless mode defaults to SSE streaming for the response; pull the
  // JSON-RPC payload out of the "data: " line(s) of the event stream, same
  // pattern as jobs.test.ts.
  const raw = await res.text();
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  expect(dataLine).toBeTruthy();
  return JSON.parse(dataLine?.slice("data: ".length) ?? "");
}

async function callMcp(
  baseUrl: string,
  bearerKey: string,
  body: unknown,
): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: MCP_ACCEPT_HEADER,
      Authorization: `Bearer ${bearerKey}`,
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return readMcpJsonRpc(res);
}

function toolCallResultData(rpcResponse: any): unknown {
  const content = rpcResponse.result?.content;
  expect(Array.isArray(content)).toBe(true);
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0].text);
}

describe.sequential("ghostwriter domain MCP tools", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;
  let apiKey: string;

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function boot() {
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: {
        JOBOPS_MCP_ENABLED: "true",
        BASIC_AUTH_USER: "admin",
        BASIC_AUTH_PASSWORD: "secret",
        JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
        JOBOPS_TEST_AUTH_BYPASS: "0",
      },
    }));

    process.env.PORT = new URL(baseUrl).port;

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });
    const loginBody = await loginRes.json();
    const jwt = loginBody.data.token as string;

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const meBody = await meRes.json();
    const userId = meBody.data.user.id as string;

    const { createApiKey } = await import("@server/repositories/api-keys");
    const key = await createApiKey({ userId, name: "ghostwriter-mcp-test" });
    apiKey = key.plaintextKey;

    return { jwt };
  }

  it("lists every ghostwriter tool via tools/list", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    const names = (rpcResponse.result.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    for (const expectedName of GHOSTWRITER_TOOL_NAMES) {
      expect(names).toContain(expectedName);
    }
  });

  it("marks only jobops_chat_send destructive in tools/list annotations", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    const tools = rpcResponse.result.tools as Array<{
      name: string;
      annotations?: { destructiveHint?: boolean };
    }>;
    const send = tools.find((t) => t.name === "jobops_chat_send");
    expect(send?.annotations?.destructiveHint).toBe(true);

    for (const name of ["jobops_chat_threads", "jobops_chat_runs"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.destructiveHint).toBe(false);
    }
  });

  it("round-trips a read: lists threads, then lists messages for the job's default thread", async () => {
    await boot();

    const threadsResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "jobops_chat_threads",
        arguments: { id: "job-1", action: "list" },
      },
    });
    expect(threadsResponse.result.isError).toBeFalsy();
    const threadsData = toolCallResultData(threadsResponse) as {
      threads: Array<{ id: string }>;
    };
    expect(threadsData.threads).toHaveLength(1);
    expect(threadsData.threads[0].id).toBe("thread-1");

    const messagesResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "jobops_chat_threads",
        arguments: { id: "job-1", action: "messages" },
      },
    });
    expect(messagesResponse.result.isError).toBeFalsy();
    const messagesData = toolCallResultData(messagesResponse) as {
      messages: Array<{ id: string }>;
    };
    expect(messagesData.messages[0].id).toBe("message-1");
  });

  it("sends a chat message end-to-end and gets the assistant reply back", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "jobops_chat_send",
        arguments: {
          id: "job-1",
          action: "send",
          content: "What's the salary range on this one?",
        },
      },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as {
      runId: string;
      userMessage: { content: string };
      assistantMessage: { content: string };
    };
    expect(data.runId).toBe("run-1");
    expect(data.userMessage.content).toBe("hello");
    expect(data.assistantMessage.content).toBe("hi");
  });

  it("cancels a chat run", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "jobops_chat_runs",
        arguments: { id: "job-1", runId: "run-1" },
      },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as {
      cancelled: boolean;
      alreadyFinished: boolean;
    };
    expect(data.cancelled).toBe(true);
    expect(data.alreadyFinished).toBe(false);
  });

  it("update_context with no ids returns isError with a descriptive message", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "jobops_chat_threads",
        arguments: { id: "job-1", action: "update_context" },
      },
    });

    expect(rpcResponse.result.isError).toBe(true);
    expect(rpcResponse.result.content[0].text).toContain(
      'at least one of "selectedNoteIds", "selectedEmailIds", or "selectedDocumentIds" must be provided',
    );
  });

  it("edit with a threadId returns isError with a descriptive message (edit is job-level only)", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "jobops_chat_send",
        arguments: {
          id: "job-1",
          action: "edit",
          threadId: "thread-1",
          messageId: "message-1",
          content: "edited content",
        },
      },
    });

    expect(rpcResponse.result.isError).toBe(true);
    expect(rpcResponse.result.content[0].text).toContain(
      'threadId" is not supported for action "edit"',
    );
  });
});
