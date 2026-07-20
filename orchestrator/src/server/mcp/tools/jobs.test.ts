import type { Server } from "node:http";
import { startServer, stopServer } from "@server/api/routes/test-utils";
import { afterEach, describe, expect, it } from "vitest";

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

const JOBS_TOOL_NAMES = [
  "jobops_jobs_list",
  "jobops_job_get",
  "jobops_job_update",
  "jobops_job_notes",
  "jobops_job_stages",
  "jobops_job_documents",
  "jobops_job_application",
  "jobops_job_actions",
  "jobops_jobs_maintenance",
];

async function readMcpJsonRpc(res: Response): Promise<any> {
  // Stateless mode defaults to SSE streaming for the response; pull the
  // JSON-RPC payload out of the "data: " line(s) of the event stream, same
  // pattern as mount.test.ts.
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

describe.sequential("jobs domain MCP tools", () => {
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

    // `mount.ts` builds the selfCall baseUrl from `process.env.PORT` at
    // request time (see server/mcp/index.ts); test-utils.ts always binds to
    // an OS-assigned port (`app.listen(0, ...)`), so we point PORT at the
    // actual bound port after the fact so tool handlers' selfCall reaches
    // this same test server instead of the default :3001.
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
    const key = await createApiKey({ userId, name: "jobs-mcp-test" });
    apiKey = key.plaintextKey;

    return { jwt };
  }

  async function seedManualJob(jwt: string) {
    const res = await fetch(`${baseUrl}/api/manual-jobs/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        skipTailoring: true,
        job: {
          title: "Backend Engineer",
          employer: "Acme Corp",
          jobUrl: "https://example.com/jobs/backend-engineer",
          jobDescription: "Build things.",
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    return body.data as { id: string };
  }

  it("lists every jobs tool via tools/list", async () => {
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
    for (const expectedName of JOBS_TOOL_NAMES) {
      expect(names).toContain(expectedName);
    }
  });

  it("calls jobops_jobs_list end-to-end and gets JSON back", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "jobops_jobs_list", arguments: {} },
    });

    expect(rpcResponse.result.isError).toBeFalsy();
    const data = toolCallResultData(rpcResponse) as { jobs: unknown[] };
    expect(Array.isArray(data.jobs)).toBe(true);
  });

  it("round-trips a mutating tool call: adds a note to a seeded job", async () => {
    const { jwt } = await boot();
    const job = await seedManualJob(jwt);

    const addResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "jobops_job_notes",
        arguments: {
          id: job.id,
          action: "add",
          title: "Follow up",
          content: "Reach out to the recruiter next week.",
        },
      },
    });

    expect(addResponse.result.isError).toBeFalsy();
    const created = toolCallResultData(addResponse) as {
      id: string;
      title: string;
      content: string;
    };
    expect(created.title).toBe("Follow up");
    expect(created.content).toBe("Reach out to the recruiter next week.");

    const listResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "jobops_job_notes",
        arguments: { id: job.id, action: "list" },
      },
    });

    expect(listResponse.result.isError).toBeFalsy();
    const notes = toolCallResultData(listResponse) as Array<{ id: string }>;
    expect(notes.some((note) => note.id === created.id)).toBe(true);
  });
});
