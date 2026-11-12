import type { Project, ShaderDefinition } from "@kynimo/scene";
import pg from "pg";
import {
  type AccountStore,
  type Commit,
  type KeyLookup,
  type KeyReader,
  LOCAL_ACCOUNT,
  migrateLoaded,
  PROJECT_ID_PATTERN,
  type ProjectMeta,
  type ProjectState,
  type ProjectTx,
  type ScriptRecord,
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
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    // A process that stalls mid-write must not hold a project's row lock indefinitely.
    idle_in_transaction_session_timeout: 60_000,
  });
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
    // Keys whose outcome is still kept: the outcome purge scans only rows it will change.
    "create index kynimo_write_keys_live on kynimo_write_keys (scope, created_at) where outcome is not null",
  ],
  // Accounts (ADR-0033): every project has an owner. Projects and create keys made before
  // accounts belong to the local account, which no signed-in user can be.
  [
    // The default stays: a build from before accounts, still running during a rolling deploy,
    // keeps creating (local) projects instead of failing.
    `alter table kynimo_projects add column account text not null default '${LOCAL_ACCOUNT}'`,
    "create index kynimo_projects_account on kynimo_projects (account, created_at, id)",
    `update kynimo_write_keys set scope = '#create:${LOCAL_ACCOUNT}' where scope = '#create'`,
  ],
  // The run_script source and seed per version it wrote (ADR-0044). seed is a uint32, which does
  // not fit integer; double precision holds it exactly and reads back as a JS number.
  [
    `create table kynimo_project_scripts (
      project_id text not null references kynimo_projects (id) on delete cascade,
      version integer not null,
      source text not null,
      seed double precision not null,
      created_at timestamptz not null default now(),
      primary key (project_id, version)
    )`,
  ],
  [
    `create table kynimo_shader_definitions (
      project_id text not null references kynimo_projects (id) on delete cascade,
      id text not null,
      version text not null,
      definition json not null,
      primary key (project_id, id, version)
    )`,
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

/** The key scope of an account's `create_project` keys. Project ids never start with `#`. */
const createScope = (account: string) => `#create:${account}`;

interface ProjectRow {
  version: number;
  id_counter: number;
  history: Record<string, Stacks>;
  doc: unknown;
}

const SELECT_PROJECT = `select p.version, p.id_counter, p.history, v.doc
  from kynimo_projects p
  join kynimo_project_versions v on v.project_id = p.id and v.version = p.version
  where p.id = $1 and p.account = $2`;

/**
 * Projects in Postgres, shared by any number of server processes (ADR-0029). A write locks its
 * project row (`select … for update`) for the whole check-and-apply, and saves the new version's
 * document, the undo history and the key in the same transaction. `create_project` takes a
 * transaction-scoped advisory lock on its (account, actor, key). Keys are kept by age, not count.
 * Each instance acts for one account (LOCAL_ACCOUNT from `open`); `forAccount` gives another.
 */
export class PostgresStore implements AccountStore {
  private readonly outcomeSeconds: number;
  private readonly tombstoneSeconds: number;

  private constructor(
    private readonly db: Database,
    private readonly options: PostgresStoreOptions,
    readonly account: string,
  ) {
    this.outcomeSeconds = options.outcomeSeconds ?? 7 * DAY;
    this.tombstoneSeconds = options.tombstoneSeconds ?? 90 * DAY;
    if (!(this.outcomeSeconds > 0 && this.tombstoneSeconds >= this.outcomeSeconds))
      throw new Error("key retention must be positive, and tombstones must outlive outcomes");
  }

  /** Migrates the database schema, then opens the store. */
  static async open(db: Database, options: PostgresStoreOptions = {}): Promise<PostgresStore> {
    await migrateDatabase(db);
    return new PostgresStore(db, options, LOCAL_ACCOUNT);
  }

  forAccount(account: string): PostgresStore {
    return new PostgresStore(this.db, this.options, account);
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
      "select id, name, version from kynimo_projects where account = $1 order by created_at, id",
      [this.account],
    );
  }

  async get(id: string): Promise<ProjectState | undefined> {
    if (!PROJECT_ID_PATTERN.test(id)) return undefined;
    const [row] = await this.db.query<ProjectRow>(SELECT_PROJECT, [id, this.account]);
    return row && this.state(id, row);
  }

  async getVersion(id: string, version: number): Promise<Project | undefined> {
    if (!PROJECT_ID_PATTERN.test(id) || !Number.isInteger(version) || version < 1) return undefined;
    const [row] = await this.db.query<{ doc: unknown }>(
      `select v.doc from kynimo_project_versions v
       join kynimo_projects p on p.id = v.project_id
       where v.project_id = $1 and v.version = $2 and p.account = $3`,
      [id, version, this.account],
    );
    return row && migrateLoaded(id, row.doc, {}).doc;
  }

  async getScript(id: string, version?: number): Promise<ScriptRecord | undefined> {
    if (!PROJECT_ID_PATTERN.test(id)) return undefined;
    if (
      version !== undefined &&
      (!Number.isInteger(version) || version < 1 || version > 2_147_483_647)
    )
      return undefined;
    const [row] = await this.db.query<ScriptRecord>(
      `select s.version, s.source, s.seed from kynimo_project_scripts s
       join kynimo_projects p on p.id = s.project_id
       where s.project_id = $1 and p.account = $2 and ($3::int is null or s.version = $3::int)
       order by s.version desc limit 1`,
      [id, this.account, version ?? null],
    );
    return row && { version: row.version, source: row.source, seed: Number(row.seed) };
  }

  async scriptVersions(id: string, limit: number): Promise<number[]> {
    if (!PROJECT_ID_PATTERN.test(id) || !Number.isFinite(limit) || limit < 1) return [];
    const rows = await this.db.query<{ version: number }>(
      `select s.version from kynimo_project_scripts s
       join kynimo_projects p on p.id = s.project_id
       where s.project_id = $1 and p.account = $2
       order by s.version desc limit $3`,
      [id, this.account, Math.floor(limit)],
    );
    return rows.map((r) => r.version);
  }

  private async shaderDefinitions(q: Query, id: string): Promise<ShaderDefinition[]> {
    const rows = await q<{ definition: ShaderDefinition }>(
      "select definition from kynimo_shader_definitions where project_id = $1",
      [id],
    );
    return rows.map(({ definition }) => definition);
  }

  async listShaderDefinitions(id: string): Promise<ShaderDefinition[] | undefined> {
    if (!PROJECT_ID_PATTERN.test(id)) return undefined;
    const rows = await this.db.query<{ definition: ShaderDefinition | null }>(
      `select d.definition from kynimo_projects p
       left join kynimo_shader_definitions d on d.project_id = p.id
       where p.id = $1 and p.account = $2`,
      [id, this.account],
    );
    if (rows.length === 0) return undefined;
    return rows.flatMap(({ definition }) => (definition === null ? [] : [definition]));
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
    if (projectId === undefined)
      return this.lookup(this.db.query, createScope(this.account), actor, key);
    if (!PROJECT_ID_PATTERN.test(projectId)) return { status: "unknown" };
    // Another account's project has no keys this account can see.
    const owned = await this.db.query(
      "select 1 from kynimo_projects where id = $1 and account = $2",
      [projectId, this.account],
    );
    return owned.length === 0
      ? { status: "unknown" }
      : this.lookup(this.db.query, projectId, actor, key);
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
      const locked = await q(
        "select 1 from kynimo_projects where id = $1 and account = $2 for update",
        [id, this.account],
      );
      if (locked.length === 0) return undefined;
      const [row] = await q<ProjectRow>(SELECT_PROJECT, [id, this.account]);
      if (!row) throw new Error(`project ${id} has no document for its current version`);
      const current = this.state(id, row);
      const step = await fn({
        project: structuredClone(current),
        definitions: () => this.shaderDefinitions(q, id),
        lookup: (actor, key) => this.lookup(q, id, actor, key),
      });
      const { commit } = step;
      if (commit) {
        const next = commit.project;
        if (next) {
          if (next.id !== id) throw new Error(`a commit for ${id} cannot save project ${next.id}`);
          // A version that did not change keeps its stored document: no-op writes change nothing.
          if (next.version !== current.version) {
            await this.insertVersion(q, next);
            if (commit.script)
              await q(
                "insert into kynimo_project_scripts (project_id, version, source, seed) values ($1, $2, $3, $4)",
                [id, next.version, commit.script.source, commit.script.seed],
              );
          }
          await q(
            `update kynimo_projects
             set name = $2, version = $3, id_counter = $4, history = $5, updated_at = now()
             where id = $1`,
            [id, next.doc.name, next.version, next.idCounter, JSON.stringify(next.history)],
          );
        }
        const definition = commit.definition;
        if (definition !== undefined)
          await q(
            "insert into kynimo_shader_definitions (project_id, id, version, definition) values ($1, $2, $3, $4)",
            [id, definition.id, definition.version, JSON.stringify(definition)],
          );
        await this.saveKey(q, id, commit);
      }
      return { value: step.value };
    });
  }

  async create<T>(fn: (tx: KeyReader) => Promise<Step<T>>): Promise<T> {
    const scope = createScope(this.account);
    return this.db.transaction(async (q) => {
      const step = await fn({
        lookup: async (actor, key) => {
          // Two creates with one key wait for each other here, so only one of them inserts.
          await q("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
            JSON.stringify([scope, actor, key]),
          ]);
          return this.lookup(q, scope, actor, key);
        },
      });
      const { commit } = step;
      if (commit) {
        const project = commit.project;
        if (project) {
          await q(
            "insert into kynimo_projects (id, account, name, version, id_counter, history) values ($1, $2, $3, $4, $5, $6)",
            [
              project.id,
              this.account,
              project.doc.name,
              project.version,
              project.idCounter,
              JSON.stringify(project.history),
            ],
          );
          await this.insertVersion(q, project);
        }
        await this.saveKey(q, scope, commit);
      }
      return step.value;
    });
  }
}
