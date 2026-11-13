import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpRequestEvent } from "@kynimo/mcp/local";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLog } from "./activity.js";

const P1 = `p-${"1".repeat(32)}`;
const P2 = `p-${"2".repeat(32)}`;

let dir: string;
let file: string;
let clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kynimo-activity-"));
  file = join(dir, "activity.json");
  clock = 1_000_000;
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const open = () => ActivityLog.open({ file, now: () => clock });

const initialize = (name: string, at: number, userAgent = "ua"): McpRequestEvent => ({
  at,
  userAgent,
  messages: [{ method: "initialize", clientName: name }],
});
const call = (tool: string, at: number, projectId?: string, userAgent = "ua"): McpRequestEvent => ({
  at,
  userAgent,
  messages: [{ method: "tools/call", tool, ...(projectId ? { projectId } : {}) }],
});

describe("ActivityLog requests", () => {
  it("records the client and its last request time", async () => {
    const log = await open();
    log.recordRequest(initialize("claude-code", 5000));
    expect(log.latestClient()).toEqual({ name: "Claude Code", lastSeenAt: 5000 });
    expect(log.firstRequestAt).toBe(5000);
    log.recordRequest(initialize("codex-mcp-client", 6000, "other"));
    expect(log.latestClient()).toEqual({ name: "Codex", lastSeenAt: 6000 });
    expect(log.firstRequestAt).toBe(5000);
  });

  it("gives requests without initialize the label learned for their user agent", async () => {
    const log = await open();
    log.recordRequest(initialize("cursor-vscode", 1, "ua-cursor"));
    log.recordRequest(call("list_projects", 2, undefined, "ua-cursor"));
    expect(log.latestClient()?.name).toBe("Cursor");
    log.recordRequest(call("list_projects", 3, undefined, "never-seen"));
    expect(log.latestClient()?.name).toBe("An agent");
  });

  it("sets lastClient on tool calls with a project, and lastCheckAt for frame tools only", async () => {
    const log = await open();
    log.observeProjects([{ id: P1, version: 1 }]);
    log.recordRequest(initialize("claude-code", 10));
    log.recordRequest(call("get_scene", 20, P1));
    expect(log.project(P1)).toMatchObject({ lastClient: "Claude Code" });
    expect(log.project(P1)?.lastCheckAt).toBeUndefined();
    log.recordRequest(call("render_frames", 30, P1));
    expect(log.project(P1)?.lastCheckAt).toBe(30);
    log.recordRequest(call("render_contact_sheet", 40, P1));
    expect(log.project(P1)?.lastCheckAt).toBe(40);
  });

  it("ignores project ids it has not seen in the store", async () => {
    const log = await open();
    log.recordRequest(call("get_scene", 1, "p-unknown"));
    expect(log.project("p-unknown")).toBeUndefined();
  });
});

describe("ActivityLog project polling", () => {
  it("learns existing projects on the first poll without inventing times or authors", async () => {
    const log = await open();
    log.recordRequest(initialize("claude-code", 1));
    log.observeProjects([{ id: P1, version: 3 }]);
    expect(log.project(P1)).toEqual({});
  });

  it("attributes a new project to the client that called create_project within 60 s", async () => {
    const log = await open();
    log.observeProjects([]);
    log.recordRequest(initialize("claude-code", clock - 1000, "a"));
    log.recordRequest(initialize("codex-mcp-client", clock - 500, "b"));
    log.recordRequest(call("create_project", clock - 30_000, undefined, "a"));
    log.recordRequest(call("get_scene", clock - 400, undefined, "b"));
    clock += 5000;
    log.observeProjects([{ id: P1, version: 1 }]);
    expect(log.project(P1)).toMatchObject({
      createdBy: "Claude Code",
      createdAt: clock,
      updatedAt: clock,
    });
  });

  it("falls back to the most recent client when create_project is older than 60 s", async () => {
    const log = await open();
    log.observeProjects([]);
    log.recordRequest(initialize("claude-code", clock - 90_000, "a"));
    log.recordRequest(call("create_project", clock - 80_000, undefined, "a"));
    log.recordRequest(initialize("cursor-vscode", clock - 10_000, "b"));
    log.observeProjects([{ id: P1, version: 1 }]);
    expect(log.project(P1)?.createdBy).toBe("Cursor");
  });

  it("leaves createdBy out when no client has connected", async () => {
    const log = await open();
    log.observeProjects([]);
    log.observeProjects([{ id: P1, version: 1 }]);
    expect(log.project(P1)?.createdAt).toBe(clock);
    expect(log.project(P1)?.createdBy).toBeUndefined();
  });

  it("sets updatedAt on a version increase and not otherwise", async () => {
    const log = await open();
    log.observeProjects([{ id: P1, version: 1 }]);
    clock += 1000;
    log.observeProjects([{ id: P1, version: 1 }]);
    expect(log.project(P1)?.updatedAt).toBeUndefined();
    clock += 1000;
    log.observeProjects([{ id: P1, version: 2 }]);
    expect(log.project(P1)?.updatedAt).toBe(clock);
  });

  it("drops projects the store no longer lists", async () => {
    const log = await open();
    log.observeProjects([
      { id: P1, version: 1 },
      { id: P2, version: 1 },
    ]);
    log.observeProjects([{ id: P2, version: 1 }]);
    expect(log.project(P1)).toBeUndefined();
    expect(log.project(P2)).toBeDefined();
  });
});

describe("ActivityLog persistence", () => {
  it("round-trips through the file", async () => {
    const log = await open();
    log.observeProjects([]);
    log.recordRequest(initialize("claude-code", 10));
    log.observeProjects([{ id: P1, version: 1 }]);
    log.recordRequest(call("render_frames", 20, P1));
    await log.flush();

    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.version).toBe(1);
    expect(saved.clients["Claude Code"]).toEqual({ lastSeenAt: 20 });

    const again = await open();
    expect(again.project(P1)).toMatchObject({
      createdBy: "Claude Code",
      lastClient: "Claude Code",
      lastCheckAt: 20,
    });
  });

  it("writes after a debounce, not on every change", async () => {
    vi.useFakeTimers();
    const log = await ActivityLog.open({ file, now: () => clock, debounceMs: 1000 });
    log.recordRequest(initialize("claude-code", 1));
    log.recordRequest(initialize("claude-code", 2));
    await vi.advanceTimersByTimeAsync(999);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await vi.advanceTimersByTimeAsync(2);
    await log.flush();
    vi.useRealTimers();
    expect(JSON.parse(await readFile(file, "utf8")).clients["Claude Code"].lastSeenAt).toBe(2);
  });

  it("starts empty when the file is missing", async () => {
    const log = await open();
    expect(log.latestClient()).toBeUndefined();
    expect((await readdir(dir)).length).toBe(0);
  });

  it("starts empty and keeps a .bak when the file is corrupt", async () => {
    await writeFile(file, "{ not json");
    const log = await open();
    expect(log.project(P1)).toBeUndefined();
    expect(await readFile(`${file}.bak`, "utf8")).toBe("{ not json");
    log.recordRequest(initialize("claude-code", 1));
    await log.flush();
    expect(JSON.parse(await readFile(file, "utf8")).clients).toHaveProperty("Claude Code");
  });

  it("treats a file of the wrong shape as corrupt", async () => {
    await writeFile(file, JSON.stringify({ version: 2, projects: {}, clients: {} }));
    await open();
    expect(await readFile(`${file}.bak`, "utf8")).toContain('"version":2');
  });
});
