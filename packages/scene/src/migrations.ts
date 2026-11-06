import { clone } from "./changes.js";
import { type Project, ProjectSchema } from "./project.js";
import { SCENE_FORMAT_VERSION } from "./version.js";

/** Oldest format version this build can still read. Raise it only when old migrations are dropped. */
export const MIN_FORMAT_VERSION = 1;

type Json = Record<string, unknown>;

/**
 * One step from format version `from` to `from + 1`. Pure: takes a private copy of the document as
 * plain JSON and returns the upgraded JSON. It does not set `formatVersion` (the runner does) and
 * must not validate; the final result is validated once against the current schema.
 */
export interface Migration {
  readonly from: number;
  readonly migrate: (doc: Json) => Json;
}

/**
 * Every step, ordered by `from`. Empty while the format is still version 1 (version 0 was a
 * placeholder with no documents). Any format change adds the step that upgrades the previous version.
 */
export const MIGRATIONS: readonly Migration[] = [];

export interface MigrationError {
  path: (string | number)[];
  message: string;
}

export type MigrationResult =
  | { ok: true; doc: Project; from: number; to: number }
  | { ok: false; errors: MigrationError[] };

type RawResult =
  | { ok: true; doc: Json; from: number; to: number }
  | { ok: false; errors: MigrationError[] };

const failure = (
  message: string,
  path: (string | number)[] = [],
): { ok: false; errors: MigrationError[] } => ({
  ok: false,
  errors: [{ path, message }],
});

/** Checks a step list covers every version from `min` up to `target` exactly once. Returns problems. */
export function checkMigrations(
  steps: readonly Migration[],
  target: number = SCENE_FORMAT_VERSION,
  min: number = MIN_FORMAT_VERSION,
): string[] {
  const problems: string[] = [];
  for (let v = min; v < target; v++) {
    const n = steps.filter((s) => s.from === v).length;
    if (n !== 1) problems.push(`expected exactly one migration from version ${v}, found ${n}`);
  }
  for (const s of steps)
    if (!Number.isInteger(s.from) || s.from < min || s.from >= target)
      problems.push(`migration from version ${s.from} is outside ${min}..${target - 1}`);
  return problems;
}

/**
 * Runs the steps from the document's `formatVersion` up to `target` on untrusted JSON, without
 * validating the result. Never throws; the input is not modified.
 */
export function runMigrations(
  input: unknown,
  steps: readonly Migration[] = MIGRATIONS,
  target: number = SCENE_FORMAT_VERSION,
): RawResult {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return failure("a project must be a JSON object");
  const version = (input as Json).formatVersion;
  if (typeof version !== "number" || !Number.isInteger(version))
    return failure("formatVersion must be an integer", ["formatVersion"]);
  if (version > target)
    return failure(
      `document is format version ${version}, newer than the supported version ${target}; upgrade Kynimo to open it`,
      ["formatVersion"],
    );
  if (version < MIN_FORMAT_VERSION)
    return failure(
      `format version ${version} is no longer supported (oldest is ${MIN_FORMAT_VERSION})`,
      ["formatVersion"],
    );

  let doc: Json;
  try {
    doc = clone(input as Json);
  } catch {
    return failure("document is not plain JSON data");
  }
  for (let v = version; v < target; v++) {
    const step = steps.find((s) => s.from === v);
    if (step === undefined)
      return failure(`no migration from format version ${v} to ${v + 1}`, ["formatVersion"]);
    try {
      const next = step.migrate(doc);
      if (typeof next !== "object" || next === null || Array.isArray(next))
        return failure(`migration from version ${v} did not return an object`);
      doc = { ...next, formatVersion: v + 1 };
    } catch (e) {
      return failure(
        `migration from version ${v} to ${v + 1} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { ok: true, doc, from: version, to: target };
}

/**
 * The edge for stored or imported documents: upgrades to the current format, then validates with
 * `ProjectSchema`. A current-version document is only validated. Never throws.
 */
export function migrateProject(input: unknown): MigrationResult {
  const run = runMigrations(input);
  if (!run.ok) return run;
  const parsed = ProjectSchema.safeParse(run.doc);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((e) => ({
        path: e.path.map((p) => (typeof p === "number" ? p : String(p))),
        message: e.message,
      })),
    };
  return { ok: true, doc: parsed.data, from: run.from, to: run.to };
}
