import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withLayerDefaults } from "./defaults.js";
import { KynimoService } from "./service.js";
import { connectPostgres, type Database, PostgresStore } from "./store-postgres.js";

/**
 * Real-server checks that PGlite's single connection cannot give: several pools (as several
 * server processes would have) racing on one database. Opt-in: set KYNIMO_TEST_DATABASE_URL to
 * an empty, disposable database; the test drops and recreates Kynimo's tables in it.
 */
const url = process.env.KYNIMO_TEST_DATABASE_URL;

const settings = {
  width: 640,
  height: 360,
  fps: { num: 30, den: 1 },
  duration_frames: 60,
  background: null,
};

const addSolid = (name: string) => ({
  op: "addLayer",
  composition: "main",
  layer: withLayerDefaults({ type: "solid", name, width: 10, height: 10, color: "#ff0000" }, {
    width: 640,
    height: 360,
    durationFrames: 60,
  } as never),
});

describe.skipIf(url === undefined)("PostgresStore on a real server", () => {
  const PROCESSES = 4;
  let dbs: Database[] = [];
  let services: KynimoService[] = [];

  beforeAll(async () => {
    if (url === undefined) return;
    const fail = (e: Error) => {
      throw e;
    };
    dbs = Array.from({ length: PROCESSES }, () => connectPostgres(url, fail));
    const [first] = dbs;
    if (!first) throw new Error("no database");
    for (const t of [
      "kynimo_write_keys",
      "kynimo_project_versions",
      "kynimo_projects",
      "kynimo_schema_migrations",
    ])
      await first.query(`drop table if exists ${t} cascade`);
    // Every "process" migrates at once; the advisory lock lets exactly one apply each step.
    const stores = await Promise.all(dbs.map((db) => PostgresStore.open(db)));
    services = stores.map((s) => new KynimoService(s, "agent"));
  });
  afterAll(async () => {
    await Promise.all(dbs.map((db) => db.close()));
  });

  it("serializes racing writes from every process: one winner per version", async () => {
    const [first] = services;
    if (!first) throw new Error("no service");
    const { id } = await first.createProject({ name: "Race", idempotency_key: "c", ...settings });
    for (let base = 1; base <= 5; base++) {
      const results = await Promise.allSettled(
        services.map((svc, i) =>
          svc.write(
            { project_id: id, base_version: base, idempotency_key: `w${base}-${i}` },
            { kind: "ops", ops: [addSolid(`l${base}-${i}`)] },
          ),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    }
    const project = await first.getProject(id);
    expect(project.version).toBe(6);
  });

  it("creates one project when every process retries one create at once", async () => {
    const results = await Promise.all(
      services.map((svc) =>
        svc.createProject({ name: "Once", idempotency_key: "same", ...settings }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const [first] = services;
    const listed = (await first?.listProjects())?.filter((p) => p.name === "Once");
    expect(listed).toHaveLength(1);
  });

  it("replays one key raced from every process", async () => {
    const [first] = services;
    if (!first) throw new Error("no service");
    const { id } = await first.createProject({ name: "Replay", idempotency_key: "r", ...settings });
    const results = await Promise.all(
      services.map((svc) =>
        svc.write(
          { project_id: id, base_version: 1, idempotency_key: "one" },
          { kind: "ops", ops: [addSolid("x")] },
        ),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.version))).toEqual(new Set([2]));
  });
});
