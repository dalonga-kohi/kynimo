import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWindowState, sanitizeWindowState, saveWindowState } from "./window-state.js";

const screen = { x: 0, y: 0, width: 1920, height: 1040 };

describe("sanitizeWindowState", () => {
  it("uses the default size for nothing or garbage", () => {
    const expected = { width: 1440, height: 900, maximized: false };
    expect(sanitizeWindowState(undefined, [screen])).toEqual(expected);
    expect(sanitizeWindowState("x", [screen])).toEqual(expected);
    expect(sanitizeWindowState({ width: "wide", height: null }, [screen])).toEqual(expected);
  });

  it("keeps a saved size and position that is on a display", () => {
    expect(
      sanitizeWindowState({ x: 100, y: 50, width: 1300, height: 800, maximized: true }, [screen]),
    ).toEqual({ x: 100, y: 50, width: 1300, height: 800, maximized: true });
  });

  it("raises a size under the minimum", () => {
    expect(sanitizeWindowState({ width: 300, height: 200 }, [screen])).toMatchObject({
      width: 1100,
      height: 720,
    });
  });

  it("drops a position that is off every display, keeping the size", () => {
    expect(sanitizeWindowState({ x: 5000, y: 0, width: 1200, height: 800 }, [screen])).toEqual({
      width: 1200,
      height: 800,
      maximized: false,
    });
  });

  it("keeps a position on a second display", () => {
    const second = { x: 1920, y: 0, width: 1920, height: 1040 };
    expect(
      sanitizeWindowState({ x: 2000, y: 10, width: 1200, height: 800 }, [screen, second]),
    ).toMatchObject({ x: 2000, y: 10 });
  });
});

describe("window state file", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("round-trips, and a missing or corrupt file gives the defaults", async () => {
    dir = await mkdtemp(join(tmpdir(), "kynimo-window-"));
    const file = join(dir, "desktop", "window.json");
    expect(await loadWindowState(file, [screen])).toMatchObject({ width: 1440, maximized: false });
    await saveWindowState(file, { x: 10, y: 20, width: 1200, height: 800, maximized: true });
    expect(await loadWindowState(file, [screen])).toEqual({
      x: 10,
      y: 20,
      width: 1200,
      height: 800,
      maximized: true,
    });
    await saveWindowState(file, { width: 1, height: 1, maximized: false });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ width: 1 });
  });
});
