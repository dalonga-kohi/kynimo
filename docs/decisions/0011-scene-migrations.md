# 0011 — Scene migrations

- Status: accepted
- Date: 2026-11-06

## Context

Stored and imported documents carry `formatVersion`. Every schema change bumps it (AGENTS.md invariant), so older documents must be upgraded before anything reads them as a `Project`.

## Decision

- **One pure step per version.** A migration `N → N+1` takes a private copy of the document as untyped JSON and returns JSON. The runner stamps `formatVersion`, so steps cannot forget it.
- **Validate once, at the end.** Intermediate versions have no types or schemas to keep around; only the current `ProjectSchema` validates the final result. Old schemas are never retained.
- **`migrateProject(unknown)` is the edge.** It never throws and returns `{ ok, doc, from, to }` or pathed errors. It rejects non-objects, a missing or non-integer version, versions below `MIN_FORMAT_VERSION`, and versions newer than the build supports.
- **A test enforces coverage.** `checkMigrations(MIGRATIONS)` fails when `SCENE_FORMAT_VERSION` is bumped without a step for every version since `MIN_FORMAT_VERSION`.
- **Not applied by scene operations.** `applyOps` expects a current `Project`; the store or MCP layer calls `migrateProject` when loading.

## Consequences

- The first real migration must ship with a `migrateProject` test that starts from a stored version-1 fixture, because `migrateProject` is only exercised end to end once a step exists.
- `MIGRATIONS` is empty while the format is version 1; the framework is proven with a synthetic chain in tests.
- Dropping support for old versions means raising `MIN_FORMAT_VERSION` and deleting their steps.
