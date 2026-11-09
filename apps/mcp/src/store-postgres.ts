import type { Project } from "@kynimo/scene";
import pg from "pg";
import {
  type Commit,
  type KeyLookup,
  type KeyReader,
  migrateLoaded,
  PROJECT_ID_PATTERN,
  type ProjectMeta,
  type ProjectState,
  type ProjectStore,
  type ProjectTx,
  type Stacks,
  type Step,
  type WriteOutcome,
} from "./store.js";

/** One SQL statement with `$n` parameters; returns its rows. */
export type Query = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

/**
 * The little `PostgresStore` needs from a database, so the same store runs on `pg` in production
 * and on an in-process Postgres (PGlite) in tests.
 */
export interface Database {
  query: Query;
  /** Runs `fn` between BEGIN and COMMIT on one connection, rolling back if it throws. */
  transaction<T>(fn: (query: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A `Database` over a `pg` pool. */
export function pgDatabase(pool: pg.Pool): Database {
  return {
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    async transaction(fn) {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query("begin");
        const value = await fn(async (sql, params) => (await client.query(sql, params)).rows);
        await client.query("commit");
        return value;
      } catch (e) {
        await client.query("rollback").catch((r: unknown) => {
          // A connection that cannot roll back is not handed to the next caller.
          broken = r instanceof Error ? r : new Error(String(r));
        });
        throw e;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

/**
 * Connects to Postgres at `url`. The URL carries the password: it is never logged, and pool
 * errors are reported without it.
 */
export function connectPostgres(url: string, onError: (e: Error) => void): Database {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // An idle client losing its connection must not crash the process; the next query reconnects.
  pool.on("error", onError);
  return pgDatabase(pool);
}

/**
 * Schema migrations, applied in order and recorded in `kynimo_schema_migrations`. Never edit a
 * shipped entry; append a new one. Each entry is a list of single statements.
 */
export const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `create table kynimo_projects (
      id text primary key,
      name text not null,
      version integer not null,
      id_counter integer not null,
      history json not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`,
    // Every version's full document, the current one included (ADR-0029).
    `create table kynimo_project_versions (
      project_id text not null references kynimo_projects (id) on delete cascade,
      version integer not null,
      doc json not null,
      created_at timestamptz not null default now(),
      primary key (project_id, version)
    )`,
    // scope: a project id, or '#create' for create_project keys. outcome is null once expired.
    `create table kynimo_write_keys (
      scope text not null,
      actor text not null,
      key text not null,
      fingerprint text not null,
      outcome json,
      created_at timestamptz not null default now(),
      primary key (scope, actor, key)
    )`,
    "create index kynimo_write_keys_age on kynimo_write_keys (scope, created_at)",
  ],
];

/** Any constant; it only has to be the same in every process migrating one database. */
const MIGRATION_LOCK = 0x6b796e69;

/** Applies pending migrations; refuses a database migrated by a newer build. */
export async function migrateDatabase(db: Database): Promise<void> {
  await db.transaction(async (q) => {
    await q(`select pg_advisory_xact_lock(${MIGRATION_LOCK})`);
    await q(`create table if not exists kynimo_schema_migrations (
      version integer primary key,
      applied_at timestamptz not null default now()
    )`);
    const [row] = await q<{ v: number | null }>(
      "select max(version) as v from kynimo_schema_migrations",
    );
    const current = row?.v ?? 0;
    if (current > MIGRATIONS.length)
      throw new Error(
        `the database schema is at version ${current}, newer than this build supports (${MIGRATIONS.length}); upgrade kynimo-mcp`,
      );
    for (let i = current; i < MIGRATIONS.length; i++) {
      for (const sql of MIGRATIONS[i] ?? []) await q(sql);
      await q("insert into kynimo_schema_migrations (version) values ($1)", [i + 1]);
    }
  });
}

const DAY = 24 * 60 * 60;

export interface PostgresStoreOptions {
  /** How long a key's outcome is kept; after that the key reads as `expired`. Default 7 days. */
  outcomeSeconds?: number;
  /** How long an expired key is remembered; after that it reads as `unknown`. Default 90 days. */
  tombstoneSeconds?: number;
}

const CREATE_SCOPE = "#create";

interface ProjectRow {
  version: number;
  id_counter: number;
  history: Record<string, Stacks>;
  doc: unknown;
}

const SELECT_PROJECT = `select p.version, p.id_counter, p.history, v.doc
  from kynimo_projects p
  join kynimo_project_versions v on v.project_id = p.id and v.version = p.version
  where p.id = $1`;

/**
 * Projects in Postgres, shared by any number of server processes (ADR-0029). A write locks its
 * project row (`select … for update`) for the whole check-and-apply, and saves the new version's
 * document, the undo history and the key in the same transaction. `create_project` takes a
 * transaction-scoped advisory lock on its (actor, key). Keys are kept by age, not count.
 */
export class PostgresStore implements ProjectStore {
  private readonly outcomeSeconds: number;
  private readonly tombstoneSeconds: number;

  private constructor(
    private readonly db: Database,
    options: PostgresStoreOptions,
  ) {
    this.outcomeSeconds = options.outcomeSeconds ?? 7 * DAY;
    this.tombstoneSeconds = options.tombstoneSeconds ?? 90 * DAY;
    if (!(this.outcomeSeconds > 0 && this.tombstoneSeconds >= this.outcomeSeconds))
      throw new Error("key retention must be positive, and tombstones must outlive outcomes");
  }

  /** Migrates the database schema, then opens the store. */
  static async open(db: Database, options: PostgresStoreOptions = {}): Promise<PostgresStore> {
    await migrateDatabase(db);
    return new PostgresStore(db, options);
  }

  private state(id: string, row: ProjectRow): ProjectState {
    return {
      id,
      version: row.version,
      idCounter: row.id_counter,
      ...migrateLoaded(id, row.doc, row.history),
    };
  }

  async list(): Promise<ProjectMeta[]> {
    return this.db.query<ProjectMeta>(
      "select id, name, version from kynimo_projects order by created_at, id",
    );
  }

  async get(id: string): Promise<ProjectState | undefined> {
    if (!PROJECT_ID_PATTERN.test(id)) return undefined;
    const [row] = await this.db.query<ProjectRow>(SELECT_PROJECT, [id]);
    return row && this.state(id, row);
  }

  async getVersion(id: string, version: number): Promise<Project | undefined> {
    if (!PROJECT_ID_PATTERN.test(id) || !Number.isInteger(version) || version < 1) return undefined;
    const [row] = await this.db.query<{ doc: unknown }>(
      "select doc from kynimo_project_versions where project_id = $1 and version = $2",
      [id, version],
    );
    return row && migrateLoaded(id, row.doc, {}).doc;
  }

  private async lookup(q: Query, scope: string, actor: string, key: string): Promise<KeyLookup> {
    const [row] = await q<{
      fingerprint: string;
      outcome: WriteOutcome | null;
      expired: boolean;
      forgotten: boolean;
    }>(
      `select fingerprint, outcome,
         created_at <= now() - make_interval(secs => $4::float8) as expired,
         created_at <= now() - make_interval(secs => $5::float8) as forgotten
       from kynimo_write_keys where scope = $1 and actor = $2 and key = $3`,
      [scope, actor, key, this.outcomeSeconds, this.tombstoneSeconds],
    );
    // Age decides, not whether a purge has run yet, so every reader sees the same answer.
    if (!row || row.forgotten) return { status: "unknown" };
    if (row.expired || row.outcome === null) return { status: "expired" };
    return {
      status: "found",
      record: { actor, key, fingerprint: row.fingerprint, outcome: row.outcome },
    };
  }

  async lookupWrite(projectId: string | undefined, actor: string, key: string): Promise<KeyLookup> {
    if (projectId !== undefined && !PROJECT_ID_PATTERN.test(projectId))
      return { status: "unknown" };
    return this.lookup(this.db.query, projectId ?? CREATE_SCOPE, actor, key);
  }

  /** Saves a key (replacing a forgotten row with the same name) and ages out the scope's keys. */
  private async saveKey(q: Query, scope: string, { record }: Commit): Promise<void> {
    await q(
      `insert into kynimo_write_keys (scope, actor, key, fingerprint, outcome)
       values ($1, $2, $3, $4, $5)
       on conflict (scope, actor, key) do update
         set fingerprint = excluded.fingerprint, outcome = excluded.outcome, created_at = now()`,
      [scope, record.actor, record.key, record.fingerprint, JSON.stringify(record.outcome)],
    );
    await q(
      "delete from kynimo_write_keys where scope = $1 and created_at <= now() - make_interval(secs => $2::float8)",
      [scope, this.tombstoneSeconds],
    );
    await q(
      `update kynimo_write_keys set outcome = null
       where scope = $1 and outcome is not null and created_at <= now() - make_interval(secs => $2::float8)`,
      [scope, this.outcomeSeconds],
    );
  }

  private async insertVersion(q: Query, project: ProjectState): Promise<void> {
    await q("insert into kynimo_project_versions (project_id, version, doc) values ($1, $2, $3)", [
      project.id,
      project.version,
      JSON.stringify(project.doc),
    ]);
  }

  async transact<T>(
    id: string,
    fn: (tx: ProjectTx) => Promise<Step<T>>,
  ): Promise<{ value: T } | undefined> {
    if (!PROJECT_ID_PATTERN.test(id)) return undefined;
    return this.db.transaction(async (q) => {
      // Lock first, then read. One `select … join … for update` is wrong under READ COMMITTED:
      // after waiting for a competing write, Postgres re-checks the locked project row at its new
      // version but keeps the joined version row from the old snapshot, so the join drops it and
      // the project looks missing. Each statement here gets a snapshot taken after the lock.
      const locked = await q("select 1 from kynimo_projects where id = $1 for update", [id]);
      if (locked.length === 0) return undefined;
      const [row] = await q<ProjectRow>(SELECT_PROJECT, [id]);
      if (!row) throw new Error(`project ${id} has no document for its current version`);
      const current = this.state(id, row);
      const step = await fn({
        project: structuredClone(current),
        lookup: (actor, key) => this.lookup(q, id, actor, key),
      });
      const { commit } = step;
      if (commit) {
        const next = commit.project;
        if (next) {
          if (next.id !== id) throw new Error(`a commit for ${id} cannot save project ${next.id}`);
          // A version that did not change keeps its stored document: no-op writes change nothing.
          if (next.version !== current.version) await this.insertVersion(q, next);
          await q(
            `update kynimo_projects
             set name = $2, version = $3, id_counter = $4, history = $5, updated_at = now()
             where id = $1`,
            [id, next.doc.name, next.version, next.idCounter, JSON.stringify(next.history)],
          );
        }
        await this.saveKey(q, id, commit);
      }
      return { value: step.value };
    });
  }

  async create<T>(fn: (tx: KeyReader) => Promise<Step<T>>): Promise<T> {
    return this.db.transaction(async (q) => {
      const step = await fn({
        lookup: async (actor, key) => {
          // Two creates with one key wait for each other here, so only one of them inserts.
          await q("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
            JSON.stringify([CREATE_SCOPE, actor, key]),
          ]);
          return this.lookup(q, CREATE_SCOPE, actor, key);
        },
      });
      const { commit } = step;
      if (commit) {
        const project = commit.project;
        if (project) {
          await q(
            "insert into kynimo_projects (id, name, version, id_counter, history) values ($1, $2, $3, $4, $5)",
            [
              project.id,
              project.doc.name,
              project.version,
              project.idCounter,
              JSON.stringify(project.history),
            ],
          );
          await this.insertVersion(q, project);
        }
        await this.saveKey(q, CREATE_SCOPE, commit);
      }
      return step.value;
    });
  }
}
