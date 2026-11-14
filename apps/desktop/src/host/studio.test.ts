import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningServer, startServer } from "@kynimo/mcp/local";
import { withLayerDefaults } from "@kynimo/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLog } from "./activity.js";
import { Studio, type StudioServer } from "./studio.js";

let dir: string;
let clock: number;
let server: RunningServer;
let activity: ActivityLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kynimo-studio-"));
  clock = 1_000_000;
  activity = await ActivityLog.open({ file: join(dir, "activity.json"), now: () => clock });
  server = await startServer({
    dir: join(dir, "data"),
    http: { host: "127.0.0.1", port: 0, noAuth: true },
    env: {},
    log: () => undefined,
    onRequest: (event) => activity.recordRequest(event),
  });
});
afterEach(async () => {
  await server.close();
  await activity.flush();
  await rm(dir, { recursive: true, force: true });
});

const studioFor = (s: StudioServer = server, extra: { debounceMs?: number } = {}) =>
  new Studio({
    server: s,
    activity,
    now: () => clock,
    cacheDir: join(dir, "cache"),
    dataDir: join(dir, "data"),
    projectsDir: "%LOCALAPPDATA%\\Kynimo",
    settingsFile: join(dir, "settings.json"),
    ...extra,
  });

const agent = () => server.service("agent");
let keys = 0;
const key = () => `k-${keys++}`;

async function createProject(
  name: string,
  options: { width?: number; height?: number; frames?: number } = {},
) {
  const { id } = await agent().createProject({
    name,
    idempotency_key: key(),
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    fps: { num: 30, den: 1 },
    duration_frames: options.frames ?? 90,
    background: "#000000",
  });
  return id;
}

/** Adds solid layers (top-first, so each lands above the last) and returns the new version. */
async function addLayers(id: string, names: string[], durationFrames = 90): Promise<number> {
  const ops = names.map((name) => ({
    op: "addLayer",
    composition: "main",
    layer: withLayerDefaults({ type: "solid", name, width: 100, height: 100, color: "#ff0000" }, {
      width: 1920,
      height: 1080,
      durationFrames,
    } as never),
  }));
  return write(id, ops);
}

async function write(id: string, ops: unknown[]): Promise<number> {
  const project = await agent().getProject(id);
  const reply = await agent().write(
    { project_id: id, base_version: project.version, idempotency_key: key() },
    { kind: "ops", ops },
  );
  return reply.version;
}

const opacityTrack = (name: string, frames: number[]) => ({
  op: "setTransformTrack",
  layer: { name },
  property: "opacity",
  track: {
    keyframes: frames.map((frame, i) => ({
      frame,
      value: i % 2 === 0 ? 0 : 1,
      interpolation: { type: "linear" },
    })),
  },
});

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "claude-code", version: "1" },
  },
};

describe("Studio.status", () => {
  it("reports the server, and the client once a request arrives", async () => {
    const studio = studioFor();
    const before = studio.status();
    expect(before).toMatchObject({
      server: "running",
      endpoint: server.endpoint,
      port: server.port,
      projectsDir: "%LOCALAPPDATA%\\Kynimo",
      startedAt: 1_000_000,
    });
    expect(before.client).toBeUndefined();
    expect(before.firstRequestAt).toBeUndefined();

    const res = await fetch(server.endpoint as string, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": "claude-code/1",
      },
      body: JSON.stringify(initialize),
    });
    expect(res.status).toBe(200);
    const after = studio.status();
    expect(after.client?.name).toBe("Claude Code");
    expect(after.client?.lastSeenAt).toBeGreaterThan(0);
    expect(after.firstRequestAt).toBe(after.client?.lastSeenAt);
  });
});

describe("Studio.listAnimations", () => {
  it("lists the metadata of each project, newest update first", async () => {
    const studio = studioFor();
    await studio.poll();
    const a = await createProject("First", { frames: 90 });
    await addLayers(a, ["bg", "title"]);
    clock += 1000;
    await studio.poll();
    clock += 1000;
    const b = await createProject("Second", { width: 1080, height: 1920, frames: 45 });
    await studio.poll();

    const list = await studio.listAnimations();
    expect(list.map((x) => x.name)).toEqual(["Second", "First"]);
    expect(list[1]).toMatchObject({
      id: a,
      name: "First",
      version: 2,
      durationSec: 3,
      width: 1920,
      height: 1080,
      fps: 30,
      layerCount: 2,
      createdAt: 1_001_000,
      updatedAt: 1_001_000,
    });
    expect(list[1]?.style).toBeUndefined();
    expect(list[0]).toMatchObject({ id: b, durationSec: 1.5, width: 1080, height: 1920 });

    // An edit moves it to the top.
    clock += 1000;
    await addLayers(a, ["extra"]);
    await studio.poll();
    expect((await studio.listAnimations()).map((x) => x.name)).toEqual(["First", "Second"]);
  });

  it("puts animations with no known update time last", async () => {
    const old = await createProject("Older");
    const studio = studioFor();
    await studio.poll(); // first poll: Older exists already, so it has no time
    clock += 1000;
    await createProject("Newer");
    await studio.poll();
    const list = await studio.listAnimations();
    expect(list.map((x) => x.name)).toEqual(["Newer", "Older"]);
    expect(list[1]?.id).toBe(old);
    expect(list[1]?.updatedAt).toBeUndefined();
    expect(list[1]?.createdBy).toBeUndefined();
  });

  it("attributes who made a project from the requests seen", async () => {
    const studio = studioFor();
    await studio.poll();
    await fetch(server.endpoint as string, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": "claude-code/1",
      },
      body: JSON.stringify(initialize),
    });
    clock = Date.now();
    await createProject("Made by an agent");
    await studio.poll();
    expect((await studio.listAnimations())[0]?.createdBy).toBe("Claude Code");
  });

  it("shows checking after a frame render, until 20 s have passed", async () => {
    const studio = studioFor();
    const id = await createProject("Checked");
    await studio.poll();
    activity.recordRequest({
      at: clock,
      userAgent: "ua",
      messages: [{ method: "initialize", clientName: "codex-mcp-client" }],
    });
    activity.recordRequest({
      at: clock,
      userAgent: "ua",
      messages: [{ method: "tools/call", tool: "render_frames", projectId: id }],
    });
    expect((await studio.listAnimations())[0]?.activity).toEqual({
      kind: "checking",
      client: "Codex",
    });
    clock += 19_000;
    expect((await studio.listAnimations())[0]?.activity).toMatchObject({ kind: "checking" });
    clock += 2000;
    expect((await studio.listAnimations())[0]?.activity).toBeUndefined();
  });

  it("shows rendering with the job's progress, ahead of checking", async () => {
    const id = await createProject("Rendering");
    const studio = studioFor({
      ...server,
      activeJobs: () => [
        {
          jobId: "j-1",
          projectId: id,
          kind: "export",
          state: "running",
          phase: "rendering",
          framesDone: 30,
          framesTotal: 120,
        },
      ],
    });
    await studio.poll();
    activity.recordRequest({
      at: clock,
      userAgent: "ua",
      messages: [{ method: "tools/call", tool: "render_frames", projectId: id }],
    });
    expect((await studio.listAnimations())[0]?.activity).toEqual({
      kind: "rendering",
      progress: 0.25,
    });
  });
});

describe("Studio.animation", () => {
  it("returns null for an unknown animation", async () => {
    expect(await studioFor().animation(`p-${"0".repeat(32)}`)).toBeNull();
  });

  it("lists layers with times in seconds and deduplicated key times", async () => {
    const id = await createProject("Layers");
    await addLayers(id, ["bg"]);
    await write(id, [
      opacityTrack("bg", [0, 15, 30]),
      {
        op: "setTransformTrack",
        layer: { name: "bg" },
        property: "position",
        track: {
          keyframes: [
            { frame: 15, value: [0, 0], interpolation: { type: "linear" } },
            { frame: 45, value: [10, 10], interpolation: { type: "linear" } },
          ],
        },
      },
    ]);
    const detail = await studioFor().animation(id);
    expect(detail?.compositionId).toBe("main");
    expect(detail?.layers).toEqual([
      { id: expect.any(String), name: "bg", start: 0, end: 3, keyTimes: [0, 0.5, 1, 1.5] },
    ]);
  });

  it("shifts key times by the layer's start frame", async () => {
    const id = await createProject("Shifted");
    await addLayers(id, ["late"]);
    await write(id, [
      { op: "updateLayer", layer: { name: "late" }, set: { startFrame: 30 } },
      opacityTrack("late", [0, 30]),
    ]);
    const detail = await studioFor().animation(id);
    expect(detail?.layers[0]?.keyTimes).toEqual([1, 2]);
  });

  it("caps rows at 12 and key times at 24 per layer", async () => {
    const id = await createProject("Many", { frames: 300 });
    await addLayers(
      id,
      Array.from({ length: 14 }, (_, i) => `layer ${i}`),
      300,
    );
    const detail = await studioFor().animation(id);
    expect(detail?.layerCount).toBe(14);
    expect(detail?.layers).toHaveLength(12);
    // The document's order, top-first: each new layer lands above the last.
    expect(detail?.layers[0]?.name).toBe("layer 13");
    expect(detail?.layers[0]?.keyTimes).toEqual([]);
  });

  it("caps key times at 24", async () => {
    const id = await createProject("Keys", { frames: 300 });
    await addLayers(id, ["a"], 300);
    await write(id, [
      opacityTrack(
        "a",
        Array.from({ length: 40 }, (_, i) => i * 3),
      ),
    ]);
    const detail = await studioFor().animation(id);
    expect(detail?.layers[0]?.keyTimes).toHaveLength(24);
    expect(detail?.layers[0]?.keyTimes[0]).toBe(0);
  });
});

/** A service whose renders are scripted, over the real store. */
function fakeServer(overrides: Partial<ReturnType<StudioServer["service"]>>): {
  server: StudioServer;
  calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {};
  const note =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      const list = calls[name] ?? [];
      calls[name] = list;
      list.push(args);
      return fn(...args);
    };
  const service = {
    renderFrames: note("renderFrames", overrides.renderFrames ?? (async () => fail())),
    exportComposition: note(
      "exportComposition",
      overrides.exportComposition ?? (async () => fail()),
    ),
    getExportStatus: note("getExportStatus", overrides.getExportStatus ?? (async () => fail())),
  };
  return { server: { ...server, service: () => service as never }, calls };
}
const fail = (): never => {
  throw new Error("unexpected call");
};

describe("Studio.thumbnail", () => {
  const png = new Uint8Array([137, 80, 78, 71]);

  const rendered = (version: number) => async () => ({
    result: { version } as never,
    images: [png],
  });

  it("renders the frame at 40 %, 832 px wide, and caches by version", async () => {
    const id = await createProject("Thumb", { frames: 90 });
    const { server: fake, calls } = fakeServer({ renderFrames: rendered(1) as never });
    const studio = studioFor(fake);

    const first = await studio.thumbnail(id);
    expect(first).toEqual({ path: join(dir, "cache", "thumbs", `${id}-v1.png`) });
    expect(calls.renderFrames?.[0]).toEqual([id, { frames: [36], max_size: 832 }]);
    expect((await stat((first as { path: string }).path)).size).toBe(4);

    expect(await studio.thumbnail(id)).toEqual(first);
    expect(calls.renderFrames).toHaveLength(1);
  });

  it("keeps the aspect ratio for tall compositions and clamps the frame", async () => {
    const id = await createProject("Tall", { width: 1080, height: 1920, frames: 1 });
    const { server: fake, calls } = fakeServer({ renderFrames: rendered(1) as never });
    await studioFor(fake).thumbnail(id);
    expect(calls.renderFrames?.[0]).toEqual([id, { frames: [0], max_size: 1479 }]);
  });

  it("renders a new version and deletes the old files of that animation", async () => {
    const id = await createProject("Versions");
    const other = await createProject("Other");
    let version = 1;
    const { server: fake } = fakeServer({
      renderFrames: (async () => ({ result: { version }, images: [png] })) as never,
    });
    const studio = studioFor(fake);
    await studio.thumbnail(id);
    await studio.thumbnail(other);
    version = 2;
    await addLayers(id, ["x"]);
    const next = await studio.thumbnail(id);
    expect(next).toEqual({ path: join(dir, "cache", "thumbs", `${id}-v2.png`) });
    const files = await readdir(join(dir, "cache", "thumbs"));
    expect(files.sort()).toEqual([`${id}-v2.png`, `${other}-v1.png`].sort());
  });

  it("renders one at a time and shares a render between identical requests", async () => {
    const a = await createProject("A");
    const b = await createProject("B");
    let running = 0;
    let peak = 0;
    const { server: fake, calls } = fakeServer({
      renderFrames: (async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return { result: { version: 1 }, images: [png] };
      }) as never,
    });
    const studio = studioFor(fake);
    const results = await Promise.all([
      studio.thumbnail(a),
      studio.thumbnail(a),
      studio.thumbnail(b),
    ]);
    expect(results.every((r) => "path" in r)).toBe(true);
    expect(peak).toBe(1);
    expect(calls.renderFrames).toHaveLength(2);
  });

  it("answers a render failure as an error result and recovers", async () => {
    const id = await createProject("Broken");
    let broken = true;
    const { server: fake } = fakeServer({
      renderFrames: (async () => {
        if (broken) throw new Error("rendering is unavailable: no Chromium");
        return { result: { version: 1 }, images: [png] };
      }) as never,
    });
    const studio = studioFor(fake);
    expect(await studio.thumbnail(id)).toEqual({ error: "rendering is unavailable: no Chromium" });
    broken = false;
    expect(await studio.thumbnail(id)).toHaveProperty("path");
  });

  it("answers an unknown animation as an error result", async () => {
    expect(await studioFor().thumbnail(`p-${"0".repeat(32)}`)).toMatchObject({
      error: expect.stringContaining("no animation"),
    });
  });
});

describe("Studio.preview", () => {
  async function exportedFile(content: string): Promise<string> {
    const file = join(dir, `source-${keys++}.mp4`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, content);
    return file;
  }

  it("exports the whole animation as mp4, copies it into the cache and reuses it", async () => {
    const id = await createProject("Clip", { frames: 90 });
    const source = await exportedFile("mp4 bytes");
    const polls: string[] = [];
    const { server: fake, calls } = fakeServer({
      exportComposition: (async () => ({ job_id: "job-1" })) as never,
      getExportStatus: (async (jobId: string) => {
        polls.push(jobId);
        const state = polls.length < 3 ? "running" : "succeeded";
        return {
          result: { state, result: { path: source, version: 1, format: "mp4" } },
          images: [],
        };
      }) as never,
    });
    const studio = studioFor(fake);
    const result = await studio.preview(id);
    expect(result).toEqual({ path: join(dir, "cache", "previews", `${id}-v1.mp4`) });
    expect(polls).toEqual(["job-1", "job-1", "job-1"]);
    // The full length, not a clip: no frame range is passed.
    const [, options] = calls.exportComposition?.[0] ?? [];
    expect(options).toMatchObject({ format: "mp4", max_size: 960 });
    expect(options).not.toHaveProperty("to_frame");
    // Exports expire: the cache holds its own copy.
    await rm(source);
    expect(await stat((result as { path: string }).path).then((s) => s.size)).toBe(9);
    expect(await studio.preview(id)).toEqual(result);
    expect(calls.exportComposition).toHaveLength(1);
  });

  it("sizes the preview to at most 960 px on the longest edge", async () => {
    const big = await createProject("Big", { width: 3840, height: 2160 });
    const tall = await createProject("Tall", { width: 540, height: 1080 });
    const small = await createProject("Small", { width: 320, height: 180 });
    const source = await exportedFile("x");
    const { server: fake, calls } = fakeServer({
      exportComposition: (async () => ({ job_id: "j" })) as never,
      getExportStatus: (async () => ({
        result: { state: "succeeded", result: { path: source, version: 1 } },
        images: [],
      })) as never,
    });
    const studio = studioFor(fake);
    await studio.preview(big);
    await studio.preview(tall);
    await studio.preview(small);
    const sizes = (calls.exportComposition ?? []).map(
      ([, o]) => (o as { max_size: number }).max_size,
    );
    expect(sizes).toEqual([960, 960, 320]);
  });

  it("runs one job per animation for concurrent calls", async () => {
    const id = await createProject("Once");
    const source = await exportedFile("x");
    const { server: fake, calls } = fakeServer({
      exportComposition: (async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { job_id: "j" };
      }) as never,
      getExportStatus: (async () => ({
        result: { state: "succeeded", result: { path: source, version: 1 } },
        images: [],
      })) as never,
    });
    const studio = studioFor(fake);
    const [x, y] = await Promise.all([studio.preview(id), studio.preview(id)]);
    expect(x).toEqual(y);
    expect(calls.exportComposition).toHaveLength(1);
  });

  it("answers a failed job and a refused request as error results", async () => {
    const id = await createProject("Fails");
    const failing = fakeServer({
      exportComposition: (async () => ({ job_id: "j" })) as never,
      getExportStatus: (async () => ({
        result: { state: "failed", error: { code: "render_failed", message: "frame 3 broke" } },
        images: [],
      })) as never,
    });
    expect(await studioFor(failing.server).preview(id)).toEqual({ error: "frame 3 broke" });

    const refused = fakeServer({
      exportComposition: (async () => {
        throw new Error("export is unavailable: no FFmpeg");
      }) as never,
    });
    expect(await studioFor(refused.server).preview(id)).toEqual({
      error: "export is unavailable: no FFmpeg",
    });
  });

  it("does not show its own job as an agent's rendering activity", async () => {
    const id = await createProject("Quiet");
    const source = await exportedFile("x");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { server: fake } = fakeServer({
      exportComposition: (async () => ({ job_id: "own-preview" })) as never,
      getExportStatus: (async () => {
        await gate;
        return { result: { state: "succeeded", result: { path: source, version: 1 } }, images: [] };
      }) as never,
    });
    const studio = studioFor({
      ...fake,
      activeJobs: () => [
        {
          jobId: "own-preview",
          projectId: id,
          kind: "export",
          state: "running",
          phase: "rendering",
          framesDone: 10,
          framesTotal: 90,
        },
      ],
    });
    const preview = studio.preview(id);
    await new Promise((r) => setTimeout(r, 10));
    expect((await studio.listAnimations())[0]?.activity).toBeUndefined();
    release();
    await preview;
  });
});
describe("Studio.exportVideo", () => {
  it("starts a full-quality export of the chosen format", async () => {
    const id = await createProject("Export", { width: 3840, height: 2160 });
    const { server: fake, calls } = fakeServer({
      exportComposition: (async () => ({ job_id: "job-9" })) as never,
    });
    const studio = studioFor(fake);
    expect(await studio.exportVideo(id, "mp4")).toEqual({ jobId: "job-9" });
    expect(await studio.exportVideo(id, "gif")).toEqual({ jobId: "job-9" });
    const [, mp4] = calls.exportComposition?.[0] ?? [];
    const [, gif] = calls.exportComposition?.[1] ?? [];
    expect(mp4).toMatchObject({ format: "mp4", max_size: 1920 });
    expect(gif).toMatchObject({ format: "gif", max_size: 960 });
    expect((mp4 as { idempotency_key: string }).idempotency_key).not.toBe(
      (gif as { idempotency_key: string }).idempotency_key,
    );
  });

  it("answers a refused export as an error result", async () => {
    const id = await createProject("Too long");
    const { server: fake } = fakeServer({
      exportComposition: (async () => {
        throw new Error("an mp4 export may be at most 60 s");
      }) as never,
    });
    expect(await studioFor(fake).exportVideo(id, "mp4")).toEqual({
      error: "an mp4 export may be at most 60 s",
    });
  });

  it("maps job states to results", async () => {
    const file = join(dir, "out.mp4");
    const states: Record<string, unknown> = {
      running: { state: "running" },
      succeeded: { state: "succeeded", result: { path: file } },
      failed: { state: "failed", error: { code: "x", message: "encoder crashed" } },
    };
    const { server: fake } = fakeServer({
      getExportStatus: (async (jobId: string) => {
        if (jobId === "gone") throw new Error("job 'gone' does not exist");
        return { result: states[jobId], images: [] };
      }) as never,
    });
    const studio = studioFor(fake);
    expect(await studio.exportResult("running")).toEqual({ state: "running" });
    expect(await studio.exportResult("succeeded")).toEqual({ state: "succeeded", file });
    expect(await studio.exportResult("failed")).toEqual({
      state: "failed",
      error: "encoder crashed",
    });
    expect(await studio.exportResult("gone")).toEqual({
      state: "failed",
      error: "job 'gone' does not exist",
    });
  });
});

describe("Studio export jobs of the desktop", () => {
  const job = (jobId: string, projectId: string, done: number) => ({
    jobId,
    projectId,
    kind: "export" as const,
    state: "running" as const,
    phase: "rendering" as const,
    framesDone: done,
    framesTotal: 100,
  });

  it("keeps its export out of the activity and reports its progress", async () => {
    const id = await createProject("Exporting");
    const other = await createProject("Agent's");
    const { server: fake } = fakeServer({
      exportComposition: (async () => ({ job_id: "mine" })) as never,
      getExportStatus: (async () => ({ result: { state: "running" }, images: [] })) as never,
    });
    let done = 25;
    const studio = studioFor({
      ...fake,
      activeJobs: () => [job("mine", id, done), job("theirs", other, 50)],
    });
    expect(studio.exportProgress(id)).toBeUndefined();
    await studio.exportVideo(id, "mp4");

    const list = await studio.listAnimations();
    expect(list.find((a) => a.id === id)?.activity).toBeUndefined();
    expect(list.find((a) => a.id === other)?.activity).toEqual({
      kind: "rendering",
      progress: 0.5,
    });
    expect(studio.exportProgress(id)).toEqual({ progress: 0.25 });
    expect(studio.exportProgress(other)).toBeUndefined();
    done = 80;
    expect(studio.exportProgress(id)).toEqual({ progress: 0.8 });
  });

  it("forgets the export once its job has finished", async () => {
    const id = await createProject("Done");
    const { server: fake } = fakeServer({
      exportComposition: (async () => ({ job_id: "mine" })) as never,
      getExportStatus: (async () => ({
        result: { state: "failed", error: { code: "x", message: "nope" } },
        images: [],
      })) as never,
    });
    const studio = studioFor({ ...fake, activeJobs: () => [job("mine", id, 10)] });
    await studio.exportVideo(id, "mp4");
    expect(studio.exportProgress(id)).toEqual({ progress: 0.1 });
    await studio.exportResult("mine");
    expect(studio.exportProgress(id)).toBeUndefined();
    expect((await studio.listAnimations())[0]?.activity).toMatchObject({ kind: "rendering" });
  });
});

describe("Studio settings and events", () => {
  it("remembers that the welcome was seen", async () => {
    const studio = studioFor();
    expect(await studio.welcomeSeen()).toBe(false);
    await studio.markWelcomeSeen();
    expect(await studio.welcomeSeen()).toBe(true);
    expect(await studioFor().welcomeSeen()).toBe(true);
  });

  it("notifies once per change, debounced", async () => {
    const studio = studioFor(server, { debounceMs: 10 });
    const changed = vi.fn();
    studio.onChanged(changed);

    await studio.poll();
    await new Promise((r) => setTimeout(r, 40));
    expect(changed).toHaveBeenCalledTimes(1);

    await studio.poll(); // nothing new
    await new Promise((r) => setTimeout(r, 40));
    expect(changed).toHaveBeenCalledTimes(1);

    const id = await createProject("New");
    await addLayers(id, ["a"]);
    await studio.poll();
    await studio.poll();
    await new Promise((r) => setTimeout(r, 40));
    expect(changed).toHaveBeenCalledTimes(2);
    studio.close();
  });
});
