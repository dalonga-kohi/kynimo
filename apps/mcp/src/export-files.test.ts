import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXPORT_CONTENT_TYPES, ExportFiles } from "./export-files.js";

let root: string;
let clock: number;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kynimo-exports-test-"));
  clock = 1_000_000;
});
afterEach(() => rm(root, { recursive: true, force: true }));

const source = async (name: string, bytes = 10) => {
  const file = join(root, name);
  await writeFile(file, Buffer.alloc(bytes, 1));
  return file;
};
const open = (o: { ttlMs?: number; maxBytes?: number } = {}) =>
  ExportFiles.open(join(root, "out"), { ...o, now: () => clock });
const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

describe("ExportFiles", () => {
  it("has content types for every format", () => {
    expect(EXPORT_CONTENT_TYPES).toEqual({
      mp4: "video/mp4",
      webm: "video/webm",
      gif: "image/gif",
    });
  });

  it("moves the file and finds it by token", async () => {
    const files = await open();
    const src = await source("tmp.mp4", 123);
    const saved = await files.save(src, "my-export", "mp4");
    expect(saved).toMatchObject({
      file: join(root, "out", "my-export.mp4"),
      bytes: 123,
      format: "mp4",
      expiresAt: clock + 24 * 60 * 60 * 1000,
    });
    expect(saved.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await exists(src)).toBe(false);
    expect((await readFile(saved.file)).length).toBe(123);
    expect(files.lookup(saved.token)).toEqual(saved);
  });

  it("issues a different token each time", async () => {
    const files = await open();
    const a = await files.save(await source("a.gif"), "a", "gif");
    const b = await files.save(await source("b.gif"), "b", "gif");
    expect(a.token).not.toBe(b.token);
  });

  it("rejects bad names", async () => {
    const files = await open();
    for (const name of ["", "../x", "A", "a.b", "a/b", "x".repeat(81)])
      await expect(files.save(await source("t.mp4"), name, "mp4")).rejects.toThrow();
  });

  it("returns undefined for bad or unknown tokens", async () => {
    const files = await open();
    await files.save(await source("t.mp4"), "a", "mp4");
    expect(files.lookup("short")).toBeUndefined();
    expect(files.lookup("../".repeat(20))).toBeUndefined();
    expect(files.lookup("A".repeat(43))).toBeUndefined();
  });

  it("expires entries and deletes their files on sweep", async () => {
    const files = await open({ ttlMs: 1000 });
    const saved = await files.save(await source("t.webm"), "a", "webm");
    clock += 999;
    expect(files.lookup(saved.token)).toBeDefined();
    clock += 1;
    expect(files.lookup(saved.token)).toBeUndefined();
    await files.sweep();
    expect(await exists(saved.file)).toBe(false);
    await files.sweep();
  });

  it("evicts the oldest entries past maxBytes", async () => {
    const files = await open({ maxBytes: 25 });
    const a = await files.save(await source("a.mp4", 10), "a", "mp4");
    const b = await files.save(await source("b.mp4", 10), "b", "mp4");
    expect(files.lookup(a.token)).toBeDefined();
    const c = await files.save(await source("c.mp4", 10), "c", "mp4");
    expect(files.lookup(a.token)).toBeUndefined();
    expect(await exists(a.file)).toBe(false);
    expect(files.lookup(b.token)).toBeDefined();
    expect(files.lookup(c.token)).toBeDefined();
  });

  it("deletes stale files when opened, by mtime", async () => {
    const dir = join(root, "out");
    await ExportFiles.open(dir);
    const old = join(dir, "old.mp4");
    const fresh = join(dir, "fresh.mp4");
    await writeFile(old, "x");
    await writeFile(fresh, "x");
    const ago = new Date(clock - 2 * 24 * 60 * 60 * 1000);
    await utimes(old, ago, ago);
    const now = new Date(clock);
    await utimes(fresh, now, now);
    await ExportFiles.open(dir, { now: () => clock });
    expect(await readdir(dir)).toEqual(["fresh.mp4"]);
  });
});
