import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENE_FORMAT_VERSION } from "@kynimo/scene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KynimoService } from "./service.js";
import { FileStore, newProjectId, PROJECT_ID_PATTERN } from "./store.js";

const settings = {
  width: 640,
  height: 360,
  fps: { num: 30, den: 1 },
  duration_frames: 60,
  background: null,
};

describe("FileStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kynimo-mcp-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("generates ids that match the pattern it accepts", () => {
    expect(newProjectId()).toMatch(PROJECT_ID_PATTERN);
  });

  it("keeps projects, history and write keys across a restart", async () => {
    const first = new KynimoService(await FileStore.open(dir), "agent");
    const { id } = await first.createProject({ name: "Kept", idempotency_key: "c", ...settings });
    await first.write(
      { project_id: id, base_version: 1, idempotency_key: "w" },
      {
        kind: "ops",
        ops: [
          {
            op: "addMarker",
            target: { composition: "main" },
            marker: { frame: 10, durationFrames: 0, name: "beat" },
          },
        ],
      },
    );

    const second = new KynimoService(await FileStore.open(dir), "agent");
    expect(await second.listProjects()).toEqual([{ id, name: "Kept", version: 2 }]);
    expect(await second.getWriteOutcome("w", id)).toMatchObject({ status: "applied", version: 2 });
    expect(await second.getWriteOutcome("c")).toMatchObject({ status: "applied" });
    const undone = await second.write(
      { project_id: id, base_version: 2, idempotency_key: "u" },
      { kind: "undo" },
    );
    expect(undone).toMatchObject({ version: 3, markers_removed: ["marker-1"] });
    expect((await readdir(dir)).sort()).toEqual([".lock", "create-keys.json", "projects"]);
    expect((await readdir(join(dir, "projects"))).every((f) => f.endsWith(".json"))).toBe(true);
  });

  it("never turns an id into a path outside its folder", async () => {
    const store = await FileStore.open(dir);
    expect(await store.get("../../etc/passwd")).toBeUndefined();
    expect(await store.get("p-..")).toBeUndefined();
  });

  it("migrates an older document on load and drops its undo history", async () => {
    const store = await FileStore.open(dir);
    const svc = new KynimoService(store, "agent");
    const { id } = await svc.createProject({ name: "Old", idempotency_key: "c", ...settings });
    const path = join(dir, "projects", `${id}.json`);
    const stored = JSON.parse(await readFile(path, "utf8"));
    // Version 2 had no compositing fields on layers; an empty composition looks the same.
    stored.doc.formatVersion = SCENE_FORMAT_VERSION - 1;
    stored.history = { agent: { undo: [[]], redo: [] } };
    await writeFile(path, JSON.stringify(stored));

    const loaded = await store.get(id);
    expect(loaded?.doc.formatVersion).toBe(SCENE_FORMAT_VERSION);
    expect(loaded?.history).toEqual({});
  });

  it("fails loudly on a corrupt document instead of serving it", async () => {
    const store = await FileStore.open(dir);
    const id = newProjectId();
    await store.put({
      id,
      version: 1,
      doc: { formatVersion: SCENE_FORMAT_VERSION } as never,
      idCounter: 0,
      history: {},
      writes: [],
    });
    await expect(store.get(id)).rejects.toThrow(/not a valid document/);
  });

  it("refuses a folder another live process holds, and takes over a stale lock", async () => {
    const live = process.ppid;
    await writeFile(join(dir, ".lock"), String(live));
    await expect(FileStore.open(dir)).rejects.toThrow(/in use by another kynimo-mcp process/);

    await writeFile(join(dir, ".lock"), "4194303"); // above Linux's pid_max default: never alive
    const store = await FileStore.open(dir);
    expect(await readFile(join(dir, ".lock"), "utf8")).toBe(String(process.pid));
    await store.close();
    expect(await readdir(dir)).not.toContain(".lock");
  });

  it("lists the readable projects when one file is corrupt", async () => {
    const store = await FileStore.open(dir);
    const svc = new KynimoService(store, "agent");
    const { id } = await svc.createProject({ name: "Good", idempotency_key: "c", ...settings });
    const bad = newProjectId();
    await writeFile(join(dir, "projects", `${bad}.json`), "{ truncated");
    expect(await store.list()).toEqual([{ id, name: "Good", version: 1 }]);
    await expect(store.get(bad)).rejects.toThrow(
      new RegExp(`project ${bad} on disk is not valid JSON`),
    );
  });
});
