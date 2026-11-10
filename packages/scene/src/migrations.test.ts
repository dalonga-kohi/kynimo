import { describe, expect, it } from "vitest";
import { project, visual } from "./fixtures.test-util.js";
import {
  checkMigrations,
  MIGRATIONS,
  type Migration,
  migrateProject,
  runMigrations,
  SCENE_FORMAT_VERSION,
} from "./index.js";

// Synthetic chain: v1 -> v2 renames `name` to `title`, v2 -> v3 adds `tags`. Exercises the runner
// without inventing a schema change.
const steps: Migration[] = [
  {
    from: 1,
    migrate: ({ name, ...rest }) => ({ ...rest, title: name }),
  },
  { from: 2, migrate: (doc) => ({ ...doc, tags: [] }) },
];

describe("runMigrations", () => {
  it("chains steps in order and stamps each version", () => {
    const r = runMigrations({ formatVersion: 1, name: "Demo" }, steps, 3);
    expect(r).toEqual({
      ok: true,
      from: 1,
      to: 3,
      doc: { formatVersion: 3, title: "Demo", tags: [] },
    });
  });

  it("starts from the document's own version", () => {
    const r = runMigrations({ formatVersion: 2, title: "T" }, steps, 3);
    expect(r).toMatchObject({ ok: true, from: 2, doc: { formatVersion: 3, tags: [] } });
  });

  it("is a no-op at the target version and does not modify its input", () => {
    const input = { formatVersion: 1, name: "Demo" };
    expect(runMigrations(input, steps, 1)).toMatchObject({ ok: true, doc: input });
    runMigrations(input, steps, 3);
    expect(input).toEqual({ formatVersion: 1, name: "Demo" });
  });

  it("is deterministic", () => {
    const input = { formatVersion: 1, name: "Demo" };
    expect(runMigrations(input, steps, 3)).toEqual(runMigrations(input, steps, 3));
  });

  it.each([
    ["a number", 42, "JSON object"],
    ["null", null, "JSON object"],
    ["array", [], "JSON object"],
    ["missing version", {}, "formatVersion must be an integer"],
    ["fractional version", { formatVersion: 1.5 }, "formatVersion must be an integer"],
    ["string version", { formatVersion: "1" }, "formatVersion must be an integer"],
    ["version 0", { formatVersion: 0 }, "no longer supported"],
    ["newer than supported", { formatVersion: 4 }, "newer than the supported version 3"],
  ])("rejects %s", (_name, input, message) => {
    const r = runMigrations(input, steps, 3);
    expect(r).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining(message) }] });
  });

  it("reports a missing step, a throwing step and a non-object result without throwing", () => {
    expect(runMigrations({ formatVersion: 2 }, [steps[0] as Migration], 3)).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringContaining("no migration from format version 2") }],
    });
    const boom: Migration = {
      from: 1,
      migrate: () => {
        throw new Error("boom");
      },
    };
    expect(runMigrations({ formatVersion: 1 }, [boom], 2)).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringContaining("boom") }],
    });
    const bad: Migration = { from: 1, migrate: () => null as never };
    expect(runMigrations({ formatVersion: 1 }, [bad], 2)).toMatchObject({ ok: false });
  });

  it("rejects non-JSON input instead of throwing", () => {
    const cyclic: Record<string, unknown> = { formatVersion: 1 };
    cyclic.self = cyclic;
    expect(runMigrations(cyclic, steps, 3)).toMatchObject({ ok: false });
  });
});

describe("checkMigrations", () => {
  it("accepts a complete chain and flags gaps, duplicates and strays", () => {
    expect(checkMigrations(steps, 3)).toEqual([]);
    expect(checkMigrations([steps[1] as Migration], 3)).toHaveLength(1);
    expect(checkMigrations([...steps, ...steps], 3)).toHaveLength(2);
    expect(checkMigrations([...steps, { from: 7, migrate: (d) => d }], 3)).toHaveLength(1);
  });

  it("the shipped MIGRATIONS cover every version up to SCENE_FORMAT_VERSION", () => {
    // Fails when someone bumps SCENE_FORMAT_VERSION without shipping the migration.
    expect(checkMigrations(MIGRATIONS)).toEqual([]);
  });
});

describe("migrateProject", () => {
  it("validates a current-version document and round-trips it unchanged", () => {
    const doc = project();
    const r = migrateProject(JSON.parse(JSON.stringify(doc)));
    expect(r).toMatchObject({ ok: true, from: SCENE_FORMAT_VERSION, to: SCENE_FORMAT_VERSION });
    expect(r.ok && JSON.parse(JSON.stringify(r.doc))).toEqual(doc);
  });

  it("returns pathed schema errors for an invalid document", () => {
    const r = migrateProject(project({ name: "" }));
    expect(r).toMatchObject({ ok: false, errors: [{ path: ["name"] }] });
  });

  it("1 → 2 spells bundled families exactly and leaves unknown families to validation", () => {
    const text = (family: string, i: number) => ({
      id: `t${i}`,
      name: "t",
      inFrame: 0,
      outFrame: 90,
      startFrame: 0,
      hidden: false,
      solo: false,
      editor: { locked: false, shy: false, label: null },
      markers: [],
      parent: null,
      transform: {
        anchorPoint: { value: [0, 0] },
        position: { value: [0, 0] },
        scale: { value: [1, 1] },
        rotation: { value: 0 },
        skew: { value: 0 },
        opacity: { value: 1 },
      },
      type: "text",
      content: { value: "Hi" },
      box: { mode: "point" },
      font: { family, weight: 400, size: { value: 48 } },
      tracking: { value: 0 },
      leading: { value: 1.2 },
      align: "left",
      textCase: "none",
      fill: { value: "#ffffff" },
    });
    const v1 = (families: string[]) => {
      const doc = project() as { compositions: { layers: unknown[] }[] };
      const comp = doc.compositions[0];
      if (comp) comp.layers = families.map(text);
      return { ...doc, formatVersion: 1 };
    };
    const r = migrateProject(v1(["inter", "NOTO SANS", "Inter"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.from).toBe(1);
    expect(
      r.doc.compositions[0]?.layers.map((l) => (l.type === "text" ? l.font.family : null)),
    ).toEqual(["Inter", "Noto Sans", "Inter"]);
    expect(migrateProject(v1(["Comic Sans"]))).toMatchObject({
      ok: false,
      errors: [{ path: ["compositions", 0, "layers", 0, "font", "family"] }],
    });
  });

  it("2 → 3 adds normal blending, no matte and no masks to drawing layers only", () => {
    const base = {
      inFrame: 0,
      outFrame: 90,
      startFrame: 0,
      hidden: false,
      solo: false,
      editor: { locked: false, shy: false, label: null },
      markers: [],
    };
    const transform = {
      anchorPoint: { value: [0, 0] },
      position: { value: [0, 0] },
      scale: { value: [1, 1] },
      rotation: { value: 0 },
      skew: { value: 0 },
      opacity: { value: 1 },
    };
    const solid = { ...base, id: "s", name: "s", parent: null, transform, type: "solid" };
    const v2 = {
      ...(project() as Record<string, unknown>),
      formatVersion: 2,
      assets: [
        {
          id: "music",
          type: "audio",
          name: "Music",
          uri: "assets/music.mp3",
          sha256: "b".repeat(64),
          durationMs: 1000,
        },
      ],
      compositions: [
        {
          id: "main",
          name: "main",
          width: 1920,
          height: 1080,
          fps: { num: 30, den: 1 },
          durationFrames: 90,
          background: "#000000",
          markers: [],
          layers: [
            { ...solid, width: 10, height: 10, color: "#ff0000" },
            { ...base, id: "n", name: "n", parent: null, transform, type: "null" },
            { ...base, id: "a", name: "a", type: "audio", assetId: "music", volume: { value: 1 } },
          ],
        },
      ],
    };
    const r = migrateProject(v2);
    expect(r).toMatchObject({ ok: true, from: 2, to: SCENE_FORMAT_VERSION });
    if (!r.ok) return;
    const [drawn, nul, audio] = r.doc.compositions[0]?.layers ?? [];
    expect(drawn).toMatchObject({ blendMode: "normal", matte: null, masks: [] });
    expect(nul).not.toHaveProperty("blendMode");
    expect(audio).not.toHaveProperty("masks");
  });

  it("3 → 7 leaves a version 3 document unchanged apart from its version", () => {
    const v3 = { ...project(), formatVersion: 3 };
    const r = migrateProject(v3);
    expect(r).toMatchObject({ ok: true, from: 3, to: 7 });
    if (r.ok) expect({ ...r.doc, formatVersion: 3 }).toEqual(v3);
  });

  it("4 → 7 leaves a version 4 document unchanged apart from its version", () => {
    const v4 = { ...project(), formatVersion: 4 };
    const r = migrateProject(v4);
    expect(r).toMatchObject({ ok: true, from: 4, to: 7 });
    if (r.ok) expect({ ...r.doc, formatVersion: 4 }).toEqual(v4);
  });

  it("5 → 6 gives every text layer an empty animator list and changes nothing else", () => {
    const v5 = { ...project(), formatVersion: 5 } as unknown as {
      compositions: { layers: Record<string, unknown>[] }[];
    };
    const text = {
      ...visual("t1"),
      type: "text",
      content: { value: "Hi" },
      box: { mode: "point" },
      font: { family: "Inter", weight: 400, size: { value: 48 } },
      tracking: { value: 0 },
      leading: { value: 1.2 },
      align: "left",
      textCase: "none",
      fill: { value: "#ffffff" },
    } as Record<string, unknown>;
    const comp = v5.compositions[0];
    if (comp) comp.layers = [text];
    const r = migrateProject(v5);
    expect(r).toMatchObject({ ok: true, from: 5, to: 7 });
    if (!r.ok) return;
    const migrated = r.doc.compositions[0]?.layers[0];
    expect(migrated).toMatchObject({ type: "text", animators: [] });
    // Running it again on a layer that already has animators leaves them alone.
    const animator = {
      name: "a",
      selector: {
        unit: "words",
        start: { value: 0 },
        end: { value: 1 },
        offset: { value: 0 },
        shape: "square",
        easeHigh: { value: 0 },
        easeLow: { value: 0 },
        order: "forward",
        seed: 0,
        amount: { value: 1 },
      },
      properties: { opacity: { value: 0 } },
    };
    const withOne = {
      ...r.doc,
      formatVersion: 5,
      compositions: [
        { ...r.doc.compositions[0], layers: [{ ...migrated, animators: [animator] }] },
      ],
    };
    const again = migrateProject(withOne);
    expect(again.ok && again.doc.compositions[0]?.layers[0]).toMatchObject({
      animators: [{ name: "a" }],
    });
  });

  const withoutBehaviors = ({ behaviors: _behaviors, ...rest }: Record<string, unknown>) => rest;

  it("6 → 7 gives every layer with a transform an empty behavior list and leaves audio alone", () => {
    const base = {
      inFrame: 0,
      outFrame: 90,
      startFrame: 0,
      hidden: false,
      solo: false,
      editor: { locked: false, shy: false, label: null },
      markers: [],
    };
    const transform = {
      anchorPoint: { value: [0, 0] },
      position: { value: [0, 0] },
      scale: { value: [1, 1] },
      rotation: { value: 0 },
      skew: { value: 0 },
      opacity: { value: 1 },
    };
    const v6 = {
      ...(project() as Record<string, unknown>),
      formatVersion: 6,
      assets: [
        {
          id: "music",
          type: "audio",
          name: "Music",
          uri: "assets/music.mp3",
          sha256: "b".repeat(64),
          durationMs: 1000,
        },
      ],
      compositions: [
        {
          id: "main",
          name: "main",
          width: 1920,
          height: 1080,
          fps: { num: 30, den: 1 },
          durationFrames: 90,
          background: "#000000",
          markers: [],
          layers: [
            {
              ...withoutBehaviors(visual("s")),
              type: "solid",
              width: 10,
              height: 10,
              color: "#ff0000",
            },
            { ...base, id: "n", name: "n", parent: null, transform, type: "null" },
            { ...base, id: "a", name: "a", type: "audio", assetId: "music", volume: { value: 1 } },
          ],
        },
      ],
    };
    const r = migrateProject(v6);
    expect(r).toMatchObject({ ok: true, from: 6, to: 7 });
    if (!r.ok) return;
    const [solid, nul, audio] = r.doc.compositions[0]?.layers ?? [];
    expect(solid).toMatchObject({ behaviors: [] });
    expect(nul).toMatchObject({ behaviors: [] });
    expect(audio).not.toHaveProperty("behaviors");

    // A layer that already lists behaviors keeps them.
    const wiggle = {
      id: "w",
      name: "w",
      enabled: true,
      property: "rotation",
      type: "wiggle",
      frequency: { value: 2 },
      amplitude: { value: 5 },
      octaves: 1,
      seed: 0,
      linked: false,
    };
    const again = migrateProject({
      ...r.doc,
      formatVersion: 6,
      compositions: [{ ...r.doc.compositions[0], layers: [{ ...solid, behaviors: [wiggle] }] }],
    });
    expect(again.ok && again.doc.compositions[0]?.layers[0]).toMatchObject({
      behaviors: [{ id: "w" }],
    });
  });

  it("rejects unknown and future versions", () => {
    expect(migrateProject({ ...project(), formatVersion: 99 })).toMatchObject({ ok: false });
    expect(migrateProject(null)).toMatchObject({ ok: false });
  });
});
