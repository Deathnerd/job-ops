import type { Server } from "node:http";
import { startServer, stopServer } from "@server/api/routes/test-utils";
import { buildDefaultReactiveResumeDocument } from "@server/services/rxresume/document";
import { afterEach, describe, expect, it } from "vitest";

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

const DESIGN_RESUME_TOOL_NAMES = [
  "jobops_resume_get",
  "jobops_resume_update",
  "jobops_resume_render",
  "jobops_resume_assets",
];

async function readMcpJsonRpc(res: Response): Promise<any> {
  // Stateless mode defaults to SSE streaming for the response; pull the
  // JSON-RPC payload out of the "data: " line(s) of the event stream, same
  // pattern as jobs.test.ts / mount.test.ts.
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

describe.sequential("design-resume domain MCP tools", () => {
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

    // mount.ts builds the selfCall baseUrl from process.env.PORT at request
    // time; test-utils always binds to an OS-assigned port, so point PORT at
    // the actual bound port after the fact (same pattern as jobs.test.ts).
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
    const key = await createApiKey({ userId, name: "design-resume-mcp-test" });
    apiKey = key.plaintextKey;
  }

  async function seedResumeDocument() {
    const resumeJson = buildDefaultReactiveResumeDocument();
    const dataBase64 = Buffer.from(JSON.stringify(resumeJson), "utf8").toString(
      "base64",
    );

    const response = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: {
        name: "jobops_resume_update",
        arguments: {
          action: "import_file",
          fileName: "resume.json",
          mediaType: "application/json",
          dataBase64,
        },
      },
    });
    expect(response.result.isError).toBeFalsy();
    return toolCallResultData(response) as {
      id: string;
      revision: number;
      resumeJson: Record<string, unknown>;
    };
  }

  it("lists every design-resume tool via tools/list", async () => {
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
    for (const expectedName of DESIGN_RESUME_TOOL_NAMES) {
      expect(names).toContain(expectedName);
    }
  });

  it("marks jobops_resume_assets destructive in tools/list annotations", async () => {
    await boot();

    const rpcResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    const tools = rpcResponse.result.tools as Array<{
      name: string;
      annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
    }>;
    const assetsTool = tools.find((t) => t.name === "jobops_resume_assets");
    expect(assetsTool?.annotations?.destructiveHint).toBe(true);

    const getTool = tools.find((t) => t.name === "jobops_resume_get");
    expect(getTool?.annotations?.readOnlyHint).toBe(true);
  });

  it("reports status exists:false before any document is imported", async () => {
    await boot();

    const response = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "jobops_resume_get",
        arguments: { action: "status" },
      },
    });

    expect(response.result.isError).toBeFalsy();
    const data = toolCallResultData(response) as { exists: boolean };
    expect(data.exists).toBe(false);
  });

  it("round-trips: imports a resume via import_file, then reads it back", async () => {
    await boot();
    const imported = await seedResumeDocument();
    expect(imported.revision).toBe(1);

    const getResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "jobops_resume_get",
        arguments: { action: "get" },
      },
    });

    expect(getResponse.result.isError).toBeFalsy();
    const document = toolCallResultData(getResponse) as {
      id: string;
      revision: number;
    };
    expect(document.id).toBe(imported.id);
    expect(document.revision).toBe(1);
  });

  it("updates the full document with a matching baseRevision, then rejects a stale one", async () => {
    await boot();
    const imported = await seedResumeDocument();

    const nextDocument = structuredClone(imported.resumeJson) as Record<
      string,
      unknown
    >;
    (nextDocument.basics as Record<string, unknown>).name = "Updated Name";

    const updateResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "jobops_resume_update",
        arguments: {
          action: "document",
          baseRevision: imported.revision,
          document: nextDocument,
        },
      },
    });

    expect(updateResponse.result.isError).toBeFalsy();
    const updated = toolCallResultData(updateResponse) as {
      revision: number;
      resumeJson: { basics: { name: string } };
    };
    expect(updated.revision).toBe(imported.revision + 1);
    expect(updated.resumeJson.basics.name).toBe("Updated Name");

    // Re-using the now-stale original baseRevision must be rejected with a
    // descriptive conflict, not silently applied.
    const staleResponse = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "jobops_resume_update",
        arguments: {
          action: "document",
          baseRevision: imported.revision,
          document: nextDocument,
        },
      },
    });

    expect(staleResponse.result.isError).toBe(true);
    expect(staleResponse.result.content[0].text).toContain(
      "Resume Studio has changed",
    );
  });

  it("lists assets as an empty array when the document has none", async () => {
    await boot();
    await seedResumeDocument();

    const response = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "jobops_resume_assets",
        arguments: { action: "list" },
      },
    });

    expect(response.result.isError).toBeFalsy();
    const assets = toolCallResultData(response);
    expect(assets).toEqual([]);
  });

  it("upload surfaces the public-availability 409 conflict deterministically in test env", async () => {
    await boot();
    await seedResumeDocument();

    // getJobOpsPublicAvailability rejects 127.0.0.1 (the test server's own
    // origin) as a local/private hostname regardless of JOBOPS_PUBLIC_BASE_URL
    // -- see tracer-links.ts's isLocalOrPrivateHostname / the identical
    // assertion in tracer-links.test.ts ("reports unavailable readiness for
    // localhost/private origins"). Picture upload always 409s under this
    // bootstrap, so assert that specific, deterministic outcome rather than
    // a generic isError check.
    const tinyPngDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    const response = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "jobops_resume_assets",
        arguments: {
          action: "upload",
          fileName: "avatar.png",
          dataUrl: tinyPngDataUrl,
        },
      },
    });

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("internet-reachable");
  });

  it("returns a content_url without bytes for an asset id", async () => {
    await boot();

    const response = await callMcp(baseUrl, apiKey, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "jobops_resume_assets",
        arguments: { action: "content_url", assetId: "some-asset-id" },
      },
    });

    expect(response.result.isError).toBeFalsy();
    const data = toolCallResultData(response) as { url: string };
    expect(data.url).toBe("/api/design-resume/assets/some-asset-id/content");
  });
});
