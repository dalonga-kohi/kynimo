# 0044 — Script source kept per version

- Status: accepted (extends ADR-0041, completes ADR-0036's contract line)
- Date: 2026-11-11

## Context

ADR-0036 said the source of a script is kept with the change record, so a later session can read, change and re-run it. ADR-0041 built `run_script` but deferred that: only the operations a script produced were stored, and the source was lost when the call returned. An agent that comes back to a project could not tell what program made the scene, and had to rewrite it from the document.

## Decision

- **What is stored.** The `source` and the effective `seed` (0 when the call omitted it) of a `run_script` call, against the version that call wrote. Nothing is stored for a dry run, an idempotent replay, a rejected run or a run that changed nothing (no new version). Undo and redo never store one, and a script stays readable at its version after an undo. The document never depends on it.
- **Memory store.** A map from version to script per project.
- **File store.** `scripts/<id>/<n>.json`, written after the project file. A crash can lose a script but never label a version with a script that did not write it.
- **Postgres.** Migration 3 adds `kynimo_project_scripts` (project id, version, source, seed), written in the transaction of the version it belongs to and removed with the project (`on delete cascade`). The seed is `double precision`: the uint32 seed overflows `integer`, and `bigint` reads back as a string.
- **Retention.** Kept as long as the project, at most 64 KB each (the `run_script` source limit).
- **`get_script` tool.** Input `project_id` and an optional `version` (default: the latest script). Output `project_id`, `version`, `seed`, `source` and `script_versions`: the 20 most recent versions that have a script, newest first. A project or version without a script is `not_found`. With no version the message is `no run_script has written to project <id> yet`. With a version it is `version <v> of project <id> was not written by run_script; script versions (newest first): <list or none>`. It is a read tool (`readOnlyHint`).
- **Listing size.** The new tool and the longer descriptions took `tools/list` to 76,669 bytes, under the 77 KB budget of ADR-0043, so the budget is unchanged. The M8 compaction item still targets 60 KB.

## Considered and not adopted

- A nullable column on `kynimo_project_versions`: that table holds superseded snapshots, not the current version, and a script belongs to the version just written.
- A separate `list_scripts` tool: costs listing budget; `script_versions` in `get_script` covers it.
- An MCP resource only: client support for resources is uneven, a tool works everywhere.
- Keeping the source in the idempotency record: Postgres expires outcomes after 7 days.

## Consequences

- A later session reads the script that wrote a version, changes it and re-runs it on the current base version.
- Storage grows by at most 64 KB per `run_script` version, for as long as the project exists.
- Follow-ups: none required. The brief suite's with/without-script comparison can read these sources later.
