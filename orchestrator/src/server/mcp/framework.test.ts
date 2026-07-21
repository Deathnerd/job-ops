import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  getAllToolDefs,
  registerAllTools,
  selfCall,
  type ToolContext,
  type ToolDef,
} from "./framework";

function listen(
  app: express.Express,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("selfCall", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await close(server);
      server = undefined;
    }
  });

  it("unwraps data on ok:true", async () => {
    const app = express();
    app.get("/api/jobs", (_req, res) => {
      res.json({
        ok: true,
        data: { id: "job-1" },
        meta: { requestId: "req-1" },
      });
    });
    const listening = await listen(app);
    server = listening.server;

    const ctx: ToolContext = {
      bearerKey: "test-key",
      baseUrl: listening.baseUrl,
    };
    await expect(selfCall(ctx, "GET", "/api/jobs")).resolves.toEqual({
      id: "job-1",
    });
  });

  it("throws with code, message, and requestId on ok:false", async () => {
    const app = express();
    app.use(express.json());
    app.post("/api/jobs", (_req, res) => {
      res.status(422).json({
        ok: false,
        error: { code: "validation_error", message: "bad input" },
        meta: { requestId: "req-2" },
      });
    });
    const listening = await listen(app);
    server = listening.server;

    const ctx: ToolContext = {
      bearerKey: "test-key",
      baseUrl: listening.baseUrl,
    };
    await expect(
      selfCall(ctx, "POST", "/api/jobs", { foo: "bar" }),
    ).rejects.toThrow("validation_error: bad input (requestId=req-2)");
  });

  it("throws with an http_<status> code on a non-2xx response with no error envelope", async () => {
    const app = express();
    app.get("/api/jobs/missing", (_req, res) => {
      res.status(404).json({});
    });
    const listening = await listen(app);
    server = listening.server;

    const ctx: ToolContext = {
      bearerKey: "test-key",
      baseUrl: listening.baseUrl,
    };
    await expect(selfCall(ctx, "GET", "/api/jobs/missing")).rejects.toThrow(
      /^http_404: .*\(requestId=unknown\)$/,
    );
  });

  it("forwards the bearer key verbatim", async () => {
    const app = express();
    let receivedAuth: string | undefined;
    app.get("/api/whoami", (req, res) => {
      receivedAuth = req.headers.authorization;
      res.json({ ok: true, data: null, meta: { requestId: "req-3" } });
    });
    const listening = await listen(app);
    server = listening.server;

    const ctx: ToolContext = {
      bearerKey: "s3cr3t-key",
      baseUrl: listening.baseUrl,
    };
    await selfCall(ctx, "GET", "/api/whoami");
    expect(receivedAuth).toBe("Bearer s3cr3t-key");
  });

  it("sends a content-type header only when a body is present", async () => {
    const app = express();
    app.use(express.json());
    const seenContentTypes: Record<string, string | undefined> = {};
    app.get("/api/no-body", (req, res) => {
      seenContentTypes.noBody = req.headers["content-type"];
      res.json({ ok: true, data: null, meta: { requestId: "req-4" } });
    });
    app.post("/api/with-body", (req, res) => {
      seenContentTypes.withBody = req.headers["content-type"];
      res.json({ ok: true, data: null, meta: { requestId: "req-5" } });
    });
    const listening = await listen(app);
    server = listening.server;

    const ctx: ToolContext = { bearerKey: "k", baseUrl: listening.baseUrl };
    await selfCall(ctx, "GET", "/api/no-body");
    await selfCall(ctx, "POST", "/api/with-body", { a: 1 });

    expect(seenContentTypes.noBody).toBeUndefined();
    expect(seenContentTypes.withBody).toMatch(/^application\/json/);
  });

  it("maps a non-JSON response body to an http_<status> error", async () => {
    const app = express();
    app.get("/api/broken", (_req, res) => {
      res.status(500).type("text/plain").send("upstream exploded");
    });
    const listening = await listen(app);
    server = listening.server;

    const ctx: ToolContext = { bearerKey: "k", baseUrl: listening.baseUrl };
    await expect(selfCall(ctx, "GET", "/api/broken")).rejects.toThrow(
      /^http_500: .*\(requestId=unknown\)$/,
    );
  });
});

describe("getAllToolDefs", () => {
  it("includes every jobs domain tool", () => {
    const names = getAllToolDefs().map((def) => def.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "jobops_jobs_list",
        "jobops_job_get",
        "jobops_job_update",
        "jobops_job_notes",
        "jobops_job_stages",
        "jobops_job_documents",
        "jobops_job_application",
        "jobops_job_actions",
        "jobops_jobs_maintenance",
      ]),
    );
  });

  it("includes every pipeline domain tool", () => {
    const names = getAllToolDefs().map((def) => def.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "jobops_pipeline_run",
        "jobops_pipeline_status",
        "jobops_pipeline_cancel",
        "jobops_pipeline_presets",
        "jobops_pipeline_search_plan",
        "jobops_pipeline_history",
      ]),
    );
  });

  it("includes every ghostwriter domain tool", () => {
    const names = getAllToolDefs().map((def) => def.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "jobops_chat_threads",
        "jobops_chat_send",
        "jobops_chat_runs",
      ]),
    );
  });

  it("includes every design-resume domain tool", () => {
    const names = getAllToolDefs().map((def) => def.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "jobops_resume_get",
        "jobops_resume_update",
        "jobops_resume_render",
        "jobops_resume_assets",
      ]),
    );
  });

  it("includes every profile-settings domain tool", () => {
    const names = getAllToolDefs().map((def) => def.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "jobops_profile_get",
        "jobops_profile_projects",
        "jobops_settings_get",
        "jobops_settings_set",
        "jobops_codex_auth",
      ]),
    );
  });
});

describe("registerAllTools", () => {
  async function connectedClient(defs: ToolDef[]) {
    const ctx: ToolContext = {
      bearerKey: "test-key",
      baseUrl: "http://example.invalid",
    };
    const server = new McpServer({ name: "jobops-test", version: "0.0.0" });
    registerAllTools(server, ctx, defs);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    return {
      client,
      cleanup: async () => {
        await Promise.all([client.close(), server.close()]);
      },
    };
  }

  it("defaults to getAllToolDefs() when no defs param is given", () => {
    const ctx: ToolContext = {
      bearerKey: "test-key",
      baseUrl: "http://example.invalid",
    };
    const server = new McpServer({ name: "jobops-test", version: "0.0.0" });
    expect(() => registerAllTools(server, ctx)).not.toThrow();
  });

  it("maps readOnly/destructive to annotations, defaulting both to false", async () => {
    const defs: ToolDef[] = [
      {
        name: "jobops_test_readonly",
        description: "a read-only tool",
        inputSchema: { id: z.string() },
        coverage: ["GET /api/test"],
        readOnly: true,
        handler: async (args) => ({ echoed: args.id }),
      },
      {
        name: "jobops_test_destructive",
        description: "a destructive tool",
        inputSchema: {},
        coverage: ["DELETE /api/test"],
        destructive: true,
        handler: async () => ({ deleted: true }),
      },
      {
        name: "jobops_test_default",
        description: "no hints set",
        inputSchema: {},
        coverage: [],
        handler: async () => ({}),
      },
    ];

    const { client, cleanup } = await connectedClient(defs);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(3);

      const readOnlyTool = tools.find((t) => t.name === "jobops_test_readonly");
      expect(readOnlyTool?.annotations?.readOnlyHint).toBe(true);
      expect(readOnlyTool?.annotations?.destructiveHint).toBe(false);

      const destructiveTool = tools.find(
        (t) => t.name === "jobops_test_destructive",
      );
      expect(destructiveTool?.annotations?.readOnlyHint).toBe(false);
      expect(destructiveTool?.annotations?.destructiveHint).toBe(true);

      const defaultTool = tools.find((t) => t.name === "jobops_test_default");
      expect(defaultTool?.annotations?.readOnlyHint).toBe(false);
      expect(defaultTool?.annotations?.destructiveHint).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("returns handler success as JSON text content", async () => {
    const defs: ToolDef[] = [
      {
        name: "jobops_test_ok",
        description: "returns data",
        inputSchema: { id: z.string() },
        coverage: ["GET /api/test"],
        handler: async (args) => ({ echoed: args.id }),
      },
    ];

    const { client, cleanup } = await connectedClient(defs);
    try {
      const result = await client.callTool({
        name: "jobops_test_ok",
        arguments: { id: "abc" },
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify({ echoed: "abc" }, null, 2) },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("returns handler throws as isError:true with the error message", async () => {
    const defs: ToolDef[] = [
      {
        name: "jobops_test_throws",
        description: "always throws",
        inputSchema: {},
        coverage: [],
        handler: async () => {
          throw new Error("boom: handler failure");
        },
      },
    ];

    const { client, cleanup } = await connectedClient(defs);
    try {
      const result = await client.callTool({
        name: "jobops_test_throws",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "boom: handler failure" },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("serializes a resolved undefined handler result as JSON null", async () => {
    const defs: ToolDef[] = [
      {
        name: "jobops_test_undefined",
        description: "resolves undefined",
        inputSchema: {},
        coverage: [],
        handler: async () => undefined,
      },
    ];

    const { client, cleanup } = await connectedClient(defs);
    try {
      const result = await client.callTool({
        name: "jobops_test_undefined",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: "text", text: "null" }]);
    } finally {
      await cleanup();
    }
  });

  it("stringifies a thrown non-Error value on the error path", async () => {
    const defs: ToolDef[] = [
      {
        name: "jobops_test_throws_string",
        description: "throws a plain string",
        inputSchema: {},
        coverage: [],
        handler: async () => {
          throw "plain string failure";
        },
      },
    ];

    const { client, cleanup } = await connectedClient(defs);
    try {
      const result = await client.callTool({
        name: "jobops_test_throws_string",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("plain string failure");
    } finally {
      await cleanup();
    }
  });
});
