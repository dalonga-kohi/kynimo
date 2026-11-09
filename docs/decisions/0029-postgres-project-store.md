# 0029 — Postgres project store: versions, row locks and key retention

- Status: accepted (implements ADR-0003's database and ADR-0018's persisted keys and undo history; amends ADR-0024: the store, not the service, serializes writes)
- Date: 2026-11-09

## Context

ADR-0024's stores serialize writes with an in-memory lock, which only works for one process. A remote server (later M3) runs several processes against one database, so the version check and its write must be serialized by the database. ADR-0018 also promises things the local stores don't keep: `expired` from `get_write_outcome`, a project created together with its key, and pinned document versions that exports and previews can later read.

## Decision

- **Postgres on `pg` (node-postgres).** Plain SQL, no ORM, so any managed Postgres works (Neon, Supabase, RDS); the host is chosen in the deploy item. `PostgresStore` talks to a three-method `Database` (`query`, `transaction`, `close`), so tests run the same store on PGlite (in-process Postgres, dev dependency only). `kynimo-mcp` uses it when `KYNIMO_DATABASE_URL` is set. The URL holds a password, so it is never logged.
- **Schema migrations** live in code (`MIGRATIONS`, append-only lists of single statements), recorded in `kynimo_schema_migrations` and applied on startup under a transaction-scoped advisory lock, so several processes starting at once apply each step exactly once. A database migrated by a newer build is refused. Tables are prefixed `kynimo_`, so the store can share a database.
- **Tables.** `kynimo_projects` (version, id counter, undo history, name), `kynimo_project_versions` (the full document of every version, the current one included) and `kynimo_write_keys` (scope = project id or `#create`, actor, key, fingerprint, outcome, created_at). Documents use `json`, not `jsonb`, so they come back with keys in the order they were written.
- **Store interface v2.** Locking moves from the service into the store: `transact(id, fn)` runs the check-and-apply with the project locked, and `create(fn)` does the same for `create_project`. `fn` returns a value and an optional commit (key record + new state), which the store saves atomically. `getVersion(id, n)` returns a past document; no tool reads it yet. `MemoryStore` and `FileStore` keep an in-process lock. `FileStore` writes superseded versions to `versions/<id>/<n>.json` and keeps its project file format.
- **Postgres locking.** A write runs `select … for update` on its project row, then reads the document in a separate statement. A single `select … join … for update` is wrong under READ COMMITTED: after waiting on a competing write, Postgres re-checks the locked row at its new version but keeps the joined version row from the old snapshot, so the project looks missing. The real-server test caught this; PGlite cannot, because it has a single connection. `create_project` has no row to lock, so it takes `pg_advisory_xact_lock` on its (actor, key) before the lookup. The new project, its first version and its key commit in one transaction, which removes ADR-0024's duplicate-on-crash case.
- **Key retention by age.** Outcomes are kept for 7 days. After that the key is a tombstone for 90 days, and then it is forgotten. Age decides the answer even before a purge has run. Each write purges its own scope. Reusing an expired key fails with a new error kind, `key_expired`, rather than applying again. Base versions would stop a double write, but nothing stops a double `create_project`. A forgotten key is new again. The local stores still cap at 1000 keys per scope and never expire.
- **Replay without reading.** A replayed `create_project` returns the request's name, which the fingerprint covers, instead of reading the project inside its own transaction. That read waited on the transaction (PGlite) or used a second pool connection (pg).

## Consequences

- Any number of server processes can share one database. The remote transport and deploy items only need a connection string.
- CI runs a Postgres 16 service for the multi-process tests (`KYNIMO_TEST_DATABASE_URL`, declared in `turbo.json` so it reaches the test task and the cache key). Without it those tests skip, and PGlite still runs the store contract suite for all three stores.
- Every version stores a full document. That is simple and makes pinning free, but it grows with edit count. Pruning or delta storage can come later without a contract change, because only `getVersion` reads old versions.
- Accounts don't exist yet: `#create` is one scope and `list` returns every project. The auth item adds an account column and scopes both.
- `key_expired` is a new error kind. Error kinds are open strings in the output schema, so this is additive.
