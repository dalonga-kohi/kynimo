import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeMedia, FakeRenderer } from "./export.test-util.js";
import { ExportFiles } from "./export-files.js";
import { createServer } from "./server.js";
import { KynimoService, ServiceRuntime } from "./service.js";
import { MemoryStore } from "./store.js";

type Structured = Record<string, unknown>;

describe("MCP server: export tools", () => {
  let client: Client;
  let dir: string;
  let runtime: ServiceRuntime;
  let renderer: FakeRenderer;
  let project: string;

  const call = async (name: string, args: Structured): Promise<CallToolResult> =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const ok = async (name: string, args: Structured): Promise<Structured> => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
    return r.structuredContent as Structured;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kynimo-test-server-exports-"));
    renderer = new FakeRenderer();
    runtime = new ServiceRuntime({
      renderer,
      media: new FakeMedia(),
      exportFiles: await ExportFiles.open(dir),
      downloadUrl: (token) => `https://kynimo.test/exports/${token}`,
    });
    const server = createServer(new KynimoService(new MemoryStore(), "agent", runtime));
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    // Listing caches the client's output validators: every call below is checked against them.
    await client.listTools();
    project = (
      await ok("create_project", {
        name: "Export",
        idempotency_key: "c",
        width: 100,
        height: 60,
        duration_frames: 30,
        background: "#000000",
      })
    ).id as string;
  });
  afterEach(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the four tools with the right annotations", async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["export", "render_preview_clip", "get_export_status", "cancel_export"])
      expect(by[name]?.outputSchema, name).toBeDefined();
    expect(by.get_export_status?.annotations).toMatchObject({ readOnlyHint: true });
    expect(by.export?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    expect(by.render_preview_clip?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(by.cancel_export?.annotations).toMatchObject({ idempotentHint: true });
    expect(by.export?.inputSchema.required).toEqual(
      expect.arrayContaining(["project_id", "idempotency_key"]),
    );
  });

  it("exports over MCP: submit, poll with wait_seconds, find the link and the fidelity report", async () => {
    const submitted = await ok("export", {
      project_id: project,
      idempotency_key: "e1",
      format: "gif",
      max_size: 50,
    });
    expect(submitted).toMatchObject({ kind: "export", project_id: project, replayed: false });
    const status = await ok("get_export_status", {
      job_id: submitted.job_id,
      wait_seconds: 20,
    });
    expect(status).toMatchObject({
      state: "succeeded",
      result: { format: "gif", width: 50, height: 30, frames: 30, bytes: 10 },
    });
    const result = status.result as { url: string; fidelity: { feature: string }[] };
    expect(result.url).toMatch(/^https:\/\/kynimo\.test\/exports\//);
    expect(result.fidelity.map((f) => f.feature)).toContain("gif-palette");
    const retry = await ok("export", {
      project_id: project,
      idempotency_key: "e1",
      format: "gif",
      max_size: 50,
    });
    expect(retry).toMatchObject({ job_id: submitted.job_id, replayed: true });
  });

  it("answers bad input as a tool error and an unknown job as not_found", async () => {
    const bad = await call("export", {
      project_id: project,
      idempotency_key: "e2",
      to_frame: 30,
    });
    expect(bad.isError).toBe(true);
    expect(JSON.parse((bad.content[0] as { text: string }).text)).toMatchObject({
      error: "invalid",
      errors: [{ path: ["to_frame"] }],
    });
    const unknown = await call("get_export_status", { job_id: `j-${"a".repeat(32)}` });
    expect(JSON.parse((unknown.content[0] as { text: string }).text).error).toBe("not_found");
    const malformed = await call("cancel_export", { job_id: "nope" });
    expect(malformed.isError).toBe(true);
  });

  it("cancels a job over MCP", async () => {
    renderer.gateAt = 1;
    const job = await ok("export", { project_id: project, idempotency_key: "e3" });
    for (let i = 0; i < 200 && renderer.reached.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    const cancelled = await ok("cancel_export", { job_id: job.job_id });
    expect(cancelled.cancelled).toBe(true);
    renderer.gate.resolve();
    const status = await ok("get_export_status", { job_id: job.job_id, wait_seconds: 20 });
    expect(status.state).toBe("cancelled");
    const again = await ok("cancel_export", { job_id: job.job_id });
    expect(again).toMatchObject({ cancelled: false, state: "cancelled" });
  });

  it("returns a finished preview's contact sheet as image content", async () => {
    const job = await ok("render_preview_clip", { project_id: project, to_frame: 19 });
    expect(job.kind).toBe("preview");
    const r = await call("get_export_status", { job_id: job.job_id, wait_seconds: 20 });
    expect(r.isError).toBeFalsy();
    const image = r.content.find((c) => c.type === "image");
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from((image as { data: string }).data, "base64").toString()).toBe("sheet-png");
    expect(r.content.at(-1)?.type).toBe("text");
    expect(r.structuredContent).toMatchObject({ state: "succeeded", kind: "preview" });
    // Still running or an export: no image.
    const exported = await ok("export", {
      project_id: project,
      idempotency_key: "e4",
      to_frame: 3,
    });
    const done = await call("get_export_status", { job_id: exported.job_id, wait_seconds: 20 });
    expect(done.content.filter((c) => c.type === "image")).toEqual([]);
  });
});
