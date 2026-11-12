import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base64, hasFfmpeg, makeTone } from "./assets.test-util.js";
import { MemoryBlobStore } from "./blobs.js";
import { ExportFiles } from "./export-files.js";
import { createHttpHandler } from "./http.js";
import { Ffmpeg } from "./media.js";
import { CaptureRenderer } from "./render.js";
import { createServer } from "./server.js";
import { KynimoService, ServiceRuntime } from "./service.js";
import { MemoryStore } from "./store.js";

/**
 * Export end to end: the real MCP tools, the real capture renderer (Chromium on SwiftShader),
 * real FFmpeg, and the download route. Needs FFmpeg (always in CI).
 */
const runMedia = hasFfmpeg || process.env.CI !== undefined;

type Structured = Record<string, unknown>;

interface Probe {
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    nb_read_frames?: string;
  }[];
}

const probe = (file: string): Probe =>
  JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-count_frames", "-show_streams", "-of", "json", file],
      { encoding: "utf8" },
    ),
  ) as Probe;

describe.runIf(runMedia)("export end to end", () => {
  let dir: string;
  let renderer: CaptureRenderer;
  let runtime: ServiceRuntime;
  let client: Client;
  let http: Server;
  let origin = "";
  let project: string;

  const call = async (name: string, args: Structured): Promise<Structured> => {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
    return r.structuredContent as Structured;
  };

  const exportAndWait = async (args: Structured): Promise<Structured> => {
    const job = await call("export", { project_id: project, ...args });
    let status = job;
    for (
      let i = 0;
      i < 20 && !["succeeded", "failed", "cancelled"].includes(status.state as string);
      i++
    )
      status = await call("get_export_status", { job_id: job.job_id, wait_seconds: 10 });
    if (status.state !== "succeeded") throw new Error(`export ended ${JSON.stringify(status)}`);
    return status.result as Structured;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "kynimo-test-e2e-"));
    renderer = new CaptureRenderer();
    runtime = new ServiceRuntime({
      renderer,
      media: new Ffmpeg(),
      blobs: new MemoryBlobStore(),
      exportFiles: await ExportFiles.open(join(dir, "exports")),
      localExportPaths: true,
      downloadUrl: (token) => `${origin}/exports/${token}`,
    });
    const store = new MemoryStore();
    const server = createServer(new KynimoService(store, "agent", runtime));
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    await client.listTools();
    http = createHttpServer(
      createHttpHandler({
        path: "/mcp",
        auth: undefined,
        allowedOrigins: [],
        serve: () => server,
        exports: runtime.exportFiles as ExportFiles,
      }),
    );
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

    project = (
      await call("create_project", {
        name: "Export",
        idempotency_key: "c",
        width: 64,
        height: 48,
        duration_frames: 30,
        background: "#102030",
      })
    ).id as string;
    await call("add_layer", {
      project_id: project,
      base_version: 1,
      idempotency_key: "a",
      composition: "main",
      layer: { type: "solid", name: "Box", width: 16, height: 16, color: "#ff8800" },
    });
    await call("set_keyframes", {
      project_id: project,
      base_version: 2,
      idempotency_key: "k",
      layer: { name: "Box" },
      property: "position",
      track: {
        keyframes: [
          { frame: 0, value: [10, 24], interpolation: { type: "linear" } },
          { frame: 29, value: [54, 24], interpolation: { type: "linear" } },
        ],
      },
    });
    const tone = await call("upload_asset", {
      project_id: project,
      base_version: 3,
      idempotency_key: "u",
      name: "tone.wav",
      data: base64(makeTone(1)),
    });
    await call("add_layer", {
      project_id: project,
      base_version: 4,
      idempotency_key: "s",
      composition: "main",
      layer: { type: "audio", name: "Tone", assetId: (tone.asset as { id: string }).id },
    });
  }, 120_000);

  afterAll(async () => {
    await new Promise((r) => http?.close(r));
    await runtime?.close();
    await renderer?.close();
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it("exports mp4, webm and gif that FFmpeg reads back, and serves them over HTTP", async () => {
    const mp4 = await exportAndWait({ idempotency_key: "e-mp4", format: "mp4" });
    const webm = await exportAndWait({ idempotency_key: "e-webm", format: "webm" });
    const gif = await exportAndWait({ idempotency_key: "e-gif", format: "gif" });
    console.info(
      `export sizes: mp4 ${mp4.bytes} B, webm ${webm.bytes} B, gif ${gif.bytes} B; render_seconds ${mp4.render_seconds}/${webm.render_seconds}/${gif.render_seconds}`,
    );

    const files = { mp4, webm, gif } as const;
    const expected = {
      mp4: { video: "h264", audio: "aac" },
      webm: { video: "vp9", audio: "opus" },
      gif: { video: "gif", audio: undefined },
    } as const;
    for (const [format, result] of Object.entries(files) as [keyof typeof files, Structured][]) {
      const streams = probe(result.path as string).streams;
      const video = streams.find((s) => s.codec_type === "video");
      const audio = streams.find((s) => s.codec_type === "audio");
      expect(video, format).toMatchObject({
        codec_name: expected[format].video,
        width: 64,
        height: 48,
        nb_read_frames: "30",
      });
      expect(audio?.codec_name, format).toBe(expected[format].audio);
      expect(result).toMatchObject({ format, frames: 30, width: 64, height: 48, cached: false });
      // The download is the file on disk, byte for byte.
      const res = await fetch(result.url as string);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String(result.bytes));
      expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(result.path as string))).toBe(
        true,
      );
    }
    expect(mp4.audio_layers as string[]).toHaveLength(1);
    expect(webm.audio_layers as string[]).toHaveLength(1);
    expect(gif.audio_layers).toEqual([]);
    expect((gif.fidelity as { feature: string }[]).map((f) => f.feature)).toEqual(
      expect.arrayContaining(["audio", "gif-palette"]),
    );
  }, 90_000);

  it("renders a preview clip with a contact sheet", async () => {
    const job = await call("render_preview_clip", { project_id: project, to_frame: 14 });
    const r = (await client.callTool({
      name: "get_export_status",
      arguments: { job_id: job.job_id, wait_seconds: 25 },
    })) as CallToolResult;
    expect(r.structuredContent).toMatchObject({ state: "succeeded", kind: "preview" });
    expect(r.content.some((c) => c.type === "image")).toBe(true);
  }, 60_000);

  it("exports the components reference scene at 1080p and reports ms per frame", async () => {
    const doc = JSON.parse(
      readFileSync(
        new URL("../../../packages/capture/reference/components/scene.json", import.meta.url),
        "utf8",
      ),
    );
    const store = new MemoryStore();
    await store.create(async () => ({
      value: undefined,
      commit: {
        record: {
          actor: "agent",
          key: "seed",
          fingerprint: "seed",
          outcome: {
            status: "applied",
            version: 1,
            result: {
              project_id: "components",
              version: 1,
              changed: true,
              layers_added: [],
              layers_removed: [],
              layers_changed: [],
              markers_added: [],
              markers_removed: [],
            },
          },
        },
        project: { id: "components", version: 1, doc, idCounter: 0, history: {} },
      },
    }));
    const service = new KynimoService(store, "agent", runtime);
    const wall = Date.now();
    const job = await service.exportComposition("components", {
      format: "mp4",
      idempotency_key: "e",
      from_frame: 0,
      to_frame: 29,
    });
    // Under a loaded machine (the whole workspace's tests at once) this takes minutes.
    let done = (await service.getExportStatus(job.job_id, 25)).result;
    for (let i = 0; i < 12 && (done.state === "queued" || done.state === "running"); i++)
      done = (await service.getExportStatus(job.job_id, 25)).result;
    expect(done.error).toBeUndefined();
    expect(done.state).toBe("succeeded");
    const seconds = (Date.now() - wall) / 1000;
    console.info(
      `components 1080p mp4, 30 frames: ${((done.result?.render_seconds ?? 0) * 1000) / 30} ms/frame (render_seconds ${done.result?.render_seconds}, wall ${seconds}), ${done.result?.bytes} B, repeated ${done.result?.repeated_frames}`,
    );
    expect(done.result).toMatchObject({ width: 1920, height: 1080, frames: 30 });
  }, 400_000);
});
