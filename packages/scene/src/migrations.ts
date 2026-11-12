import { clone } from "./changes.js";
import { BUNDLED_FONT_FAMILIES } from "./fonts.js";
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

const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 1 → 2: version 2 checks that text layers name a known family, matched exactly. Version 1 said
 * the family had to be bundled but did not check it, so bundled names spelled in another case
 * ("inter") are corrected. Any other unknown family is left alone and fails validation with a
 * message naming the available families: substituting a font silently would change the design.
 */
function canonicalBundledFamilies(doc: Json): Json {
  const canonical = new Map(BUNDLED_FONT_FAMILIES.map((f) => [f.toLowerCase(), f]));
  const compositions = Array.isArray(doc.compositions) ? doc.compositions : [];
  for (const comp of compositions) {
    if (!isJson(comp) || !Array.isArray(comp.layers)) continue;
    for (const layer of comp.layers) {
      if (!isJson(layer) || layer.type !== "text" || !isJson(layer.font)) continue;
      const family = layer.font.family;
      if (typeof family !== "string") continue;
      const fixed = canonical.get(family.toLowerCase());
      if (fixed !== undefined) layer.font.family = fixed;
    }
  }
  return doc;
}

/**
 * 2 → 3: drawing layers (all visual layers but null) gain a blend mode, a track matte and masks
 * (ADR-0020). Version 2 drew every layer normally, unmatted and unmasked, which is exactly what
 * the defaults say, so every document renders as before.
 */
function addCompositingFields(doc: Json): Json {
  const compositions = Array.isArray(doc.compositions) ? doc.compositions : [];
  for (const comp of compositions) {
    if (!isJson(comp) || !Array.isArray(comp.layers)) continue;
    for (const layer of comp.layers) {
      if (!isJson(layer) || layer.type === "audio" || layer.type === "null") continue;
      if (!("blendMode" in layer)) layer.blendMode = "normal";
      if (!("matte" in layer)) layer.matte = null;
      if (!("masks" in layer)) layer.masks = [];
    }
  }
  return doc;
}

/** 5 → 6: text layers gain an empty animator list (ADR-0038), which changes nothing on screen. */
function addTextAnimators(doc: Json): Json {
  const compositions = Array.isArray(doc.compositions) ? doc.compositions : [];
  for (const comp of compositions) {
    if (!isJson(comp) || !Array.isArray(comp.layers)) continue;
    for (const layer of comp.layers)
      if (isJson(layer) && layer.type === "text" && !("animators" in layer)) layer.animators = [];
  }
  return doc;
}

/** 6 → 7: layers with a transform gain an empty behavior list (ADR-0039), which changes nothing on screen. */
function addBehaviors(doc: Json): Json {
  const compositions = Array.isArray(doc.compositions) ? doc.compositions : [];
  for (const comp of compositions) {
    if (!isJson(comp) || !Array.isArray(comp.layers)) continue;
    for (const layer of comp.layers)
      if (isJson(layer) && layer.type !== "audio" && !("behaviors" in layer)) layer.behaviors = [];
  }
  return doc;
}

/** 7 → 8: drawn layers gain an empty effect stack, preserving their existing pixels. */
function addEffects(doc: Json): Json {
  const compositions = Array.isArray(doc.compositions) ? doc.compositions : [];
  for (const comp of compositions) {
    if (!isJson(comp) || !Array.isArray(comp.layers)) continue;
    for (const layer of comp.layers)
      if (isJson(layer) && layer.type !== "audio" && layer.type !== "null" && !("effects" in layer))
        layer.effects = [];
  }
  return doc;
}

/** 10 → 11: drawn layers gain `motionBlur: null` (ADR-0053), which renders exactly as before. */
function addMotionBlur(doc: Json): Json {
  const compositions = Array.isArray(doc.compositions) ? doc.compositions : [];
  for (const comp of compositions) {
    if (!isJson(comp) || !Array.isArray(comp.layers)) continue;
    for (const layer of comp.layers)
      if (
        isJson(layer) &&
        layer.type !== "audio" &&
        layer.type !== "null" &&
        !("motionBlur" in layer)
      )
        layer.motionBlur = null;
  }
  return doc;
}

/**
 * 11 → 12: visual layers (drawn and null) gain `threeD: false` and their transforms gain zero
 * `positionZ`, `rotationX` and `rotationY` tracks (ADR-0054), which render exactly as before.
 * Shape-group transforms are a separate schema without these tracks and are not touched.
 */
function addThreeD(doc: Json): Json {
  const compositions = Array.isArray(doc.compositions) ? doc.compositions : [];
  for (const comp of compositions) {
    if (!isJson(comp) || !Array.isArray(comp.layers)) continue;
    for (const layer of comp.layers) {
      if (!isJson(layer) || layer.type === "audio") continue;
      if (!("threeD" in layer)) layer.threeD = false;
      if (isJson(layer.transform))
        for (const track of ["positionZ", "rotationX", "rotationY"])
          if (!(track in layer.transform)) layer.transform[track] = { value: 0 };
    }
  }
  return doc;
}

/**
 * Every step, ordered by `from` (version 0 was a placeholder with no documents). Any format change
 * adds the step that upgrades the previous version.
 */
export const MIGRATIONS: readonly Migration[] = [
  { from: 1, migrate: canonicalBundledFamilies },
  { from: 2, migrate: addCompositingFields },
  // 3 → 4 only adds the video asset and layer variants: every version 3 document is valid as is.
  { from: 3, migrate: (doc) => doc },
  // 4 → 5 only adds the trim, round corners and repeater shape items (ADR-0034).
  { from: 4, migrate: (doc) => doc },
  { from: 5, migrate: addTextAnimators },
  { from: 6, migrate: addBehaviors },
  { from: 7, migrate: addEffects },
  // 8 → 9: generator layers and look effects are new variants; nothing to rewrite.
  { from: 8, migrate: (doc) => doc },
  // 9 → 10: audio assets may carry detected beats; the field is optional, so nothing to rewrite.
  { from: 9, migrate: (doc) => doc },
  // 10 → 11: transform motion blur; drawn layers gain `motionBlur: null` (ADR-0053).
  { from: 10, migrate: addMotionBlur },
  // 11 → 12: 2.5D layers; visual layers gain `threeD: false` and zero Z tracks (ADR-0054).
  { from: 11, migrate: addThreeD },
];

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
    return failure("document is not plain JSON data, or is nested too deeply");
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
