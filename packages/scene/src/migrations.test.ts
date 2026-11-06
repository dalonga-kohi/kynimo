import { describe, expect, it } from "vitest";
import { project } from "./fixtures.test-util.js";
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

  it("rejects unknown and future versions", () => {
    expect(migrateProject({ ...project(), formatVersion: 99 })).toMatchObject({ ok: false });
    expect(migrateProject(null)).toMatchObject({ ok: false });
  });
});
