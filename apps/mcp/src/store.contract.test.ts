import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { SCENE_FORMAT_VERSION, withLayerDefaults } from "@kynimo/scene";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KynimoService, ToolError } from "./service.js";
import {
  type AccountStore,
  FileStore,
  LOCAL_ACCOUNT,
  MemoryStore,
  type ProjectStore,
} from "./store.js";
import {
  type Database,
  MIGRATIONS,
  migrateDatabase,
  PostgresStore,
  type PostgresStoreOptions,
  type Query,
} from "./store-postgres.js";

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

/** A `Database` over an in-process Postgres. `close` is a no-op: the instance is shared. */
function pgliteDatabase(pg: PGlite): Database {
  const wrap =
    (run: PGlite | Parameters<Parameters<PGlite["transaction"]>[0]>[0]): Query =>
    async (sql, params) =>
      (await run.query(sql, params)).rows as never;
  return {
    query: wrap(pg),
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: async () => undefined,
  };
}

// One in-process Postgres for the file (starting one takes seconds); `freshDatabase` empties it.
let shared: PGlite;
// Starting the WASM Postgres can take well over the default hook timeout on a busy CI runner.
beforeAll(async () => {
  shared = await PGlite.create();
}, 60_000);
afterAll(async () => {
  await shared.close();
});

async function freshDatabase(): Promise<Database> {
  const db = pgliteDatabase(shared);
  const tables = await db.query<{ name: string }>(
    "select tablename as name from pg_tables where schemaname = 'public' and tablename like 'kynimo_%'",
  );
  for (const { name } of tables) await db.query(`drop table ${name} cascade`);
  return db;
}

interface Backend {
  /** A store over the backend's data; called again, it opens the same data (a restart). */
  open(options?: PostgresStoreOptions): Promise<ProjectStore>;
  close(): Promise<void>;
}

const backends: Record<string, () => Promise<Backend>> = {
  memory: async () => {
    const store = new MemoryStore();
    return { open: async () => store, close: async () => undefined };
  },
  file: async () => {
    const dir = await mkdtemp(join(tmpdir(), "kynimo-store-"));
    let open: FileStore | undefined;
    return {
      open: async () => {
        await open?.close();
        open = await FileStore.open(dir);
        return open;
      },
      close: async () => {
        await open?.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  },
  postgres: async () => {
    const db = await freshDatabase();
    return { open: (options) => PostgresStore.open(db, options), close: () => db.close() };
  },
};

async function rejection(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  throw new Error("expected a ToolError");
}

/** Commits through the store directly: a version bump (or not) with an optional script. */
const commitScript = (
  store: ProjectStore,
  id: string,
  key: string,
  options: { bump: boolean; script?: { source: string; seed: number }; omitProject?: boolean },
) =>
  store.transact(id, async (tx) => {
    const version = tx.project.version + (options.bump ? 1 : 0);
    const result = {
      project_id: id,
      version,
      changed: options.bump,
      layers_added: [],
      layers_removed: [],
      layers_changed: [],
      markers_added: [],
      markers_removed: [],
    };
    return {
      value: version,
      commit: {
        record: {
          actor: "agent",
          key,
          fingerprint: key,
          outcome: { status: "applied" as const, version, result },
        },
        ...(options.omitProject ? {} : { project: { ...tx.project, version } }),
        ...(options.script ? { script: options.script } : {}),
      },
    };
  });

for (const [name, make] of Object.entries(backends)) {
  describe(`ProjectStore contract: ${name}`, () => {
    let backend: Backend | undefined;
    afterEach(async () => {
      await backend?.close();
      backend = undefined;
    });

    const setup = async () => {
      backend = await make();
      const store = await backend.open();
      const svc = new KynimoService(store, "agent");
      const { id } = await svc.createProject({ name: "Demo", idempotency_key: "c", ...settings });
      const write = (base: number, key: string, ops: unknown[]) =>
        svc.write(
          { project_id: id, base_version: base, idempotency_key: key },
          { kind: "ops", ops },
        );
      return { store, svc, id, write };
    };

    it("creates, lists and reads a project", async () => {
      const { store, id } = await setup();
      expect(await store.list()).toEqual([{ id, name: "Demo", version: 1 }]);
      expect(await store.get(id)).toMatchObject({ id, version: 1, idCounter: 0, history: {} });
      expect(await store.get("p-0000")).toBeUndefined();
    });

    it("keeps a snapshot of every version", async () => {
      const { store, id, write } = await setup();
      await write(1, "w1", [addSolid("a")]);
      await write(2, "w2", [addSolid("b")]);
      await write(3, "noop", []);
      const names = async (v: number) =>
        (await store.getVersion(id, v))?.compositions[0]?.layers.map((l) => l.name);
      expect(await names(1)).toEqual([]);
      expect(await names(2)).toEqual(["a"]);
      expect(await names(3)).toEqual(["b", "a"]); // top layer first
      expect(await store.getVersion(id, 4)).toBeUndefined();
      expect(await store.getVersion(id, 0)).toBeUndefined();
      expect(await store.getVersion("p-0000", 1)).toBeUndefined();
    });

    it("keeps the script that wrote a version, and lists script versions newest first", async () => {
      const { store, id } = await setup();
      await commitScript(store, id, "s2", { bump: true, script: { source: "a()", seed: 7 } });
      await commitScript(store, id, "n3", { bump: true });
      await commitScript(store, id, "s4", {
        bump: true,
        script: { source: "b()", seed: 4294967295 },
      });
      expect(await store.getScript(id, 2)).toEqual({ version: 2, source: "a()", seed: 7 });
      expect(await store.getScript(id)).toEqual({ version: 4, source: "b()", seed: 4294967295 });
      expect(await store.getScript(id, 3)).toBeUndefined();
      expect(await store.scriptVersions(id, 10)).toEqual([4, 2]);
      expect(await store.scriptVersions(id, 1)).toEqual([4]);
    });

    it("saves no script for a commit that did not change the version", async () => {
      const { store, id } = await setup();
      const script = { source: "x()", seed: 0 };
      await commitScript(store, id, "same", { bump: false, script });
      await commitScript(store, id, "keyonly", { bump: false, omitProject: true, script });
      expect(await store.getScript(id)).toBeUndefined();
      expect(await store.scriptVersions(id, 10)).toEqual([]);
    });

    it("reads no script for a missing project, a bad id or version, or no script", async () => {
      const { store, id } = await setup();
      await commitScript(store, id, "s2", { bump: true, script: { source: "a()", seed: 1 } });
      expect(await store.getScript("p-0000")).toBeUndefined();
      expect(await store.getScript("../x", 2)).toBeUndefined();
      expect(await store.getScript(`p-${"0".repeat(32)}`, 2)).toBeUndefined();
      for (const v of [0, -1, 1.5, 9]) expect(await store.getScript(id, v)).toBeUndefined();
      expect(await store.scriptVersions("p-0000", 5)).toEqual([]);
      expect(await store.scriptVersions(`p-${"0".repeat(32)}`, 5)).toEqual([]);
    });

    it("keeps scripts across a restart", async () => {
      const { id, store } = await setup();
      await commitScript(store, id, "s2", { bump: true, script: { source: "a()", seed: 3 } });
      if (!backend) throw new Error("no backend");
      const reopened = await backend.open();
      expect(await reopened.getScript(id)).toEqual({ version: 2, source: "a()", seed: 3 });
      expect(await reopened.scriptVersions(id, 5)).toEqual([2]);
    });

    it("keeps documents, undo history and keys across a restart", async () => {
      const { id, write } = await setup();
      await write(1, "w1", [addSolid("a")]);
      if (!backend) throw new Error("no backend");
      const reopened = await backend.open();
      expect((await reopened.getVersion(id, 1))?.compositions[0]?.layers).toEqual([]);
      const svc = new KynimoService(reopened, "agent");
      expect(await svc.getWriteOutcome("w1", id)).toMatchObject({ status: "applied", version: 2 });
      expect(await svc.getWriteOutcome("c")).toMatchObject({ status: "applied", version: 1 });
      const undone = await svc.write(
        { project_id: id, base_version: 2, idempotency_key: "u" },
        { kind: "undo" },
      );
      expect(undone).toMatchObject({ version: 3, layers_removed: ["layer-1"] });
      const replay = await svc.createProject({ name: "Demo", idempotency_key: "c", ...settings });
      expect(replay).toEqual({ id, name: "Demo", version: 1, replayed: true });
    });

    it("lets exactly one of two concurrent writes on one version win", async () => {
      const { svc, id, write } = await setup();
      const results = await Promise.allSettled([
        write(1, "a", [addSolid("a")]),
        write(1, "b", [addSolid("b")]),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect((await svc.getProject(id)).version).toBe(2);
      const outcomes = await Promise.all(["a", "b"].map((k) => svc.getWriteOutcome(k, id)));
      expect(outcomes.map((o) => o.status).sort()).toEqual(["applied", "rejected"]);
    });

    it("creates one project for two concurrent creates with one key", async () => {
      const { store, svc } = await setup();
      const both = await Promise.all([
        svc.createProject({ name: "Twice", idempotency_key: "same", ...settings }),
        svc.createProject({ name: "Twice", idempotency_key: "same", ...settings }),
      ]);
      expect(both[0].id).toBe(both[1].id);
      expect(both.map((r) => r.replayed).sort()).toEqual([false, true]);
      expect((await store.list()).filter((p) => p.name === "Twice")).toHaveLength(1);
    });

    it("saves a rejection's key without changing the project", async () => {
      const { store, svc, id, write } = await setup();
      expect((await rejection(write(1, "bad", [{ op: "nope" }]))).kind).toBe("invalid");
      expect(await store.get(id)).toMatchObject({ version: 1 });
      expect(await svc.getWriteOutcome("bad", id)).toMatchObject({ status: "rejected" });
      expect((await rejection(write(1, "bad", [{ op: "nope" }]))).kind).toBe("invalid");
    });

    it("saves nothing when a transaction throws", async () => {
      const { store, id } = await setup();
      await expect(
        store.transact(id, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await store.transact("p-0000", async () => ({ value: 1 }))).toBeUndefined();
      // The lock is released: the next transaction runs.
      expect(await store.transact(id, async (tx) => ({ value: tx.project.version }))).toEqual({
        value: 1,
      });
    });
  });
}

const accountBackends: Record<string, () => Promise<AccountStore>> = {
  memory: async () => new MemoryStore(),
  postgres: async () => PostgresStore.open(await freshDatabase()),
};

for (const [name, make] of Object.entries(accountBackends)) {
  describe(`AccountStore: ${name}`, () => {
    const setup = async () => {
      const root = await make();
      const alice = root.forAccount("user:alice");
      const bob = root.forAccount("user:bob");
      // One actor name in both accounts: keys must still not cross.
      const a = new KynimoService(alice, "agent");
      const b = new KynimoService(bob, "agent");
      const { id } = await a.createProject({ name: "Alice's", idempotency_key: "c", ...settings });
      return { root, alice, bob, a, b, id };
    };

    it("starts as the local account and lists only the account's own projects", async () => {
      const { root, alice, bob, b, id } = await setup();
      expect(root.account).toBe(LOCAL_ACCOUNT);
      expect(alice.account).toBe("user:alice");
      expect(await alice.list()).toEqual([{ id, name: "Alice's", version: 1 }]);
      expect(await bob.list()).toEqual([]);
      expect(await root.list()).toEqual([]);
      await b.createProject({ name: "Bob's", idempotency_key: "c", ...settings });
      expect((await bob.list()).map((p) => p.name)).toEqual(["Bob's"]);
      expect((await alice.list()).map((p) => p.name)).toEqual(["Alice's"]);
    });

    it("hides another account's project from every read and write", async () => {
      const { bob, b, id } = await setup();
      expect(await bob.get(id)).toBeUndefined();
      expect(await bob.getVersion(id, 1)).toBeUndefined();
      expect(await bob.lookupWrite(id, "agent", "c")).toEqual({ status: "unknown" });
      expect(await bob.transact(id, async () => ({ value: 1 }))).toBeUndefined();
      const write = b.write(
        { project_id: id, base_version: 1, idempotency_key: "w" },
        { kind: "ops", ops: [addSolid("x")] },
      );
      expect((await rejection(write)).kind).toBe("not_found");
      expect((await rejection(b.getProject(id))).kind).toBe("not_found");
      expect((await rejection(b.getWriteOutcome("c", id))).kind).toBe("not_found");
    });

    it("hides another account's scripts", async () => {
      const { alice, bob, id } = await setup();
      await commitScript(alice, id, "s2", { bump: true, script: { source: "a()", seed: 1 } });
      expect(await alice.getScript(id)).toMatchObject({ version: 2 });
      expect(await bob.getScript(id)).toBeUndefined();
      expect(await bob.getScript(id, 2)).toBeUndefined();
      expect(await bob.scriptVersions(id, 5)).toEqual([]);
    });

    it("scopes create_project keys to the account", async () => {
      const { a, b, id } = await setup();
      expect(await b.getWriteOutcome("c")).toEqual({ status: "unknown" });
      const bobs = await b.createProject({ name: "Bob's", idempotency_key: "c", ...settings });
      expect(bobs).toMatchObject({ replayed: false });
      expect(bobs.id).not.toBe(id);
      const replay = await a.createProject({ name: "Alice's", idempotency_key: "c", ...settings });
      expect(replay).toMatchObject({ id, replayed: true });
    });
  });
}

describe("PostgresStore", () => {
  let db: Database;
  const start = async (options?: PostgresStoreOptions) => {
    db = await freshDatabase();
    const store = await PostgresStore.open(db, options);
    const svc = new KynimoService(store, "agent");
    const { id } = await svc.createProject({ name: "Demo", idempotency_key: "c", ...settings });
    return { store, svc, id };
  };
  /** Moves every key `seconds` into the past. */
  const age = (seconds: number) =>
    db.query("update kynimo_write_keys set created_at = created_at - make_interval(secs => $1)", [
      seconds,
    ]);

  it("migrates once, and again on reopen is a no-op", async () => {
    await start();
    await migrateDatabase(db);
    expect(await db.query("select version from kynimo_schema_migrations")).toEqual(
      MIGRATIONS.map((_, i) => ({ version: i + 1 })),
    );
  });

  it("gives projects and create keys stored before accounts to the local account", async () => {
    db = await freshDatabase();
    // A database as the first schema left it, with one project and its create key.
    await db.query("create table kynimo_schema_migrations (version integer primary key)");
    for (const sql of MIGRATIONS[0] ?? []) await db.query(sql);
    await db.query("insert into kynimo_schema_migrations (version) values (1)");
    const memory = new MemoryStore();
    const made = await new KynimoService(memory, "agent").createProject({
      name: "Old",
      idempotency_key: "c",
      ...settings,
    });
    const doc = (await memory.get(made.id))?.doc;
    const key = await memory.lookupWrite(undefined, "agent", "c");
    if (key.status !== "found") throw new Error("no key");
    await db.query(
      "insert into kynimo_projects (id, name, version, id_counter, history) values ($1, 'Old', 1, 0, '{}')",
      [made.id],
    );
    await db.query(
      "insert into kynimo_project_versions (project_id, version, doc) values ($1, 1, $2)",
      [made.id, JSON.stringify(doc)],
    );
    await db.query(
      "insert into kynimo_write_keys (scope, actor, key, fingerprint, outcome) values ('#create', 'agent', 'c', $1, $2)",
      [key.record.fingerprint, JSON.stringify(key.record.outcome)],
    );

    const store = await PostgresStore.open(db);
    expect(await store.list()).toEqual([{ id: made.id, name: "Old", version: 1 }]);
    expect(await store.forAccount("user:x").list()).toEqual([]);
    const replay = await new KynimoService(store, "agent").createProject({
      name: "Old",
      idempotency_key: "c",
      ...settings,
    });
    expect(replay).toEqual({ id: made.id, name: "Old", version: 1, replayed: true });
  });

  it("adds the scripts table to a database at migration 2, and drops scripts with their project", async () => {
    db = await freshDatabase();
    await db.query("create table kynimo_schema_migrations (version integer primary key)");
    for (const [i, statements] of MIGRATIONS.slice(0, 2).entries()) {
      for (const sql of statements) await db.query(sql);
      await db.query("insert into kynimo_schema_migrations (version) values ($1)", [i + 1]);
    }
    const store = await PostgresStore.open(db);
    const { id } = await new KynimoService(store, "agent").createProject({
      name: "Demo",
      idempotency_key: "c",
      ...settings,
    });
    await commitScript(store, id, "s2", { bump: true, script: { source: "a()", seed: 5 } });
    expect(await store.getScript(id)).toEqual({ version: 2, source: "a()", seed: 5 });
    await db.query("delete from kynimo_projects where id = $1", [id]);
    expect(await db.query("select 1 from kynimo_project_scripts")).toEqual([]);
  });

  it("refuses a database migrated by a newer build", async () => {
    await start();
    await db.query("insert into kynimo_schema_migrations (version) values ($1)", [
      MIGRATIONS.length + 1,
    ]);
    await expect(PostgresStore.open(db)).rejects.toThrow(/newer than this build supports/);
  });

  it("expires a key's outcome, refuses to reuse it, then forgets it", async () => {
    const { svc, id } = await start({ outcomeSeconds: 100, tombstoneSeconds: 1000 });
    const write = (key: string) =>
      svc.write(
        { project_id: id, base_version: 1, idempotency_key: key },
        { kind: "ops", ops: [addSolid("a")] },
      );
    await write("k");
    await age(200);
    expect(await svc.getWriteOutcome("k", id)).toEqual({ status: "expired" });
    expect(await svc.getWriteOutcome("c")).toEqual({ status: "expired" });
    const err = await rejection(write("k"));
    expect(err.kind).toBe("key_expired");
    await expect(
      svc.createProject({ name: "Demo", idempotency_key: "c", ...settings }),
    ).rejects.toMatchObject({ kind: "key_expired" });

    await age(2000);
    expect(await svc.getWriteOutcome("k", id)).toEqual({ status: "unknown" });
    // A forgotten key is new again; the stale base version still stops a double apply.
    expect((await rejection(write("k"))).kind).toBe("conflict");
    expect(await svc.getWriteOutcome("k", id)).toMatchObject({ status: "rejected" });
  });

  it("purges aged keys of a scope when it is written", async () => {
    const { svc, id } = await start({ outcomeSeconds: 100, tombstoneSeconds: 1000 });
    await rejection(
      svc.write({ project_id: id, base_version: 9, idempotency_key: "old" }, { kind: "undo" }),
    );
    await age(200);
    await rejection(
      svc.write({ project_id: id, base_version: 9, idempotency_key: "new" }, { kind: "undo" }),
    );
    expect(
      await db.query<{ key: string; kept: boolean }>(
        "select key, outcome is not null as kept from kynimo_write_keys where scope = $1 order by key",
        [id],
      ),
    ).toEqual([
      { key: "new", kept: true },
      { key: "old", kept: false },
    ]);
    await age(2000);
    await rejection(
      svc.write({ project_id: id, base_version: 9, idempotency_key: "newer" }, { kind: "undo" }),
    );
    expect(
      (
        await db.query<{ key: string }>("select key from kynimo_write_keys where scope = $1", [id])
      ).map((r) => r.key),
    ).toEqual(["newer"]);
  });

  it("migrates an older stored document on load and drops its undo history", async () => {
    const { store, id } = await start();
    await db.query(
      `update kynimo_project_versions set doc = json_build_object('formatVersion', $2::int)::jsonb
         || (doc::jsonb - 'formatVersion') where project_id = $1`,
      [id, SCENE_FORMAT_VERSION - 1],
    );
    await db.query(`update kynimo_projects set history = '{"agent":{"undo":[[]],"redo":[]}}'`);
    const loaded = await store.get(id);
    expect(loaded?.doc.formatVersion).toBe(SCENE_FORMAT_VERSION);
    expect(loaded?.history).toEqual({});
  });

  it("fails loudly on a corrupt stored document", async () => {
    const { store, id } = await start();
    await db.query(`update kynimo_project_versions set doc = '{"formatVersion": 1}'`);
    await expect(store.get(id)).rejects.toThrow(/not a valid document/);
  });

  it("keeps document key order as written", async () => {
    const { store, id } = await start();
    const [row] = await db.query<{ doc: string }>(
      "select doc::text as doc from kynimo_project_versions where project_id = $1",
      [id],
    );
    expect(row?.doc).toBe(JSON.stringify(await store.getVersion(id, 1)));
  });
});
