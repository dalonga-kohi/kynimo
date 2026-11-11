import {
  AnimateInputSchema,
  ApplyPresetInputSchema,
  animate,
  applyPreset,
  IntentError,
  RetimeInputSchema,
  retime,
  StaggerInputSchema,
  stagger,
} from "@kynimo/intent";
import { applyOps, MAX_BATCH_OPS, type Op, type OpError, type Project } from "@kynimo/scene";
import { z } from "zod";
import { runScript, type ScriptError, type ScriptLimits } from "./run.js";
import { SDK_SOURCE } from "./sdk-source.js";
import { scriptSnapshot } from "./snapshot.js";

export interface ExpandInput {
  source: string;
  /** uint32; default 0. */
  seed?: number;
}

export interface ExpandContext {
  /** The project's id counter; ops that generate ids (precompose, ...) continue from it. */
  idCounter: number;
  limits?: Partial<ScriptLimits>;
}

export type ExpandError =
  | ScriptError
  | {
      kind: "invalid";
      message: string;
      /** Index of the recorded SDK call that failed. */
      entry: number;
      /** The script line that made the call, when known. */
      line?: number;
      /** Paths start with `["entries", entry, ...]`. */
      errors: { path: (string | number)[]; message: string }[];
    }
  | { kind: "too_many_ops"; message: string };

export type ExpandResult =
  | { ok: true; ops: Op[]; entries: number; layersCreated: string[] }
  | { ok: false; error: ExpandError };

const Line = z.number().int().positive().optional();
// The host does not trust the SDK: the entry shape is checked here, ops by the scene on replay.
const EntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("op"), op: z.record(z.string(), z.unknown()), line: Line }),
  z.strictObject({ kind: z.literal("animate"), input: z.unknown(), line: Line }),
  z.strictObject({ kind: z.literal("preset"), input: z.unknown(), line: Line }),
  z.strictObject({ kind: z.literal("stagger"), input: z.unknown(), line: Line }),
  z.strictObject({ kind: z.literal("retime"), input: z.unknown(), line: Line }),
]);

type Path = (string | number)[];

const INTENTS = {
  animate: { schema: AnimateInputSchema, run: animate },
  preset: { schema: ApplyPresetInputSchema, run: applyPreset },
  stagger: { schema: StaggerInputSchema, run: stagger },
  retime: { schema: RetimeInputSchema, run: retime },
} as const;

const invalid = (entry: number, line: number | undefined, errors: Path[], messages: string[]) => {
  const first = errors[0] ?? [];
  const where = first.length > 0 ? `${first.join(".")}: ` : "";
  return {
    ok: false as const,
    error: {
      kind: "invalid" as const,
      message: `entry ${entry}${line === undefined ? "" : ` (line ${line})`}: ${where}${messages[0] ?? "invalid"}`,
      entry,
      ...(line === undefined ? {} : { line }),
      errors: errors.map((path, i) => ({
        path: ["entries", entry, ...path],
        message: messages[i] ?? "invalid",
      })),
    },
  };
};

/** Errors of one failed step as relative paths and messages. */
const fromIssues = (issues: { path: PropertyKey[]; message: string }[], prefix: Path = []) => ({
  paths: issues.map((i) => [
    ...prefix,
    ...i.path.map((p) => (typeof p === "number" ? p : String(p))),
  ]),
  messages: issues.map((i) => i.message),
});

/** OpErrors of a failed `applyOps`; `ops[k]` paths are renamed for what the entry produced. */
const fromOpErrors = (errors: OpError[], raw: boolean) => ({
  paths: errors.map((e) => {
    if (e.path[0] === "ops") return raw ? e.path.slice(2) : ["expanded_ops", ...e.path.slice(1)];
    return e.path;
  }),
  messages: errors.map((e) => e.message),
});

const layerIds = (doc: Project): string[] =>
  doc.compositions.flatMap((c) => c.layers.map((l) => l.id as string));

/**
 * Runs the script and expands what it recorded into one batch of scene operations, checking each
 * step against the document as the earlier steps leave it. Never throws for script faults.
 */
export async function expandScript(
  doc: Project,
  input: ExpandInput,
  ctx: ExpandContext,
): Promise<ExpandResult> {
  const run = await runScript(
    {
      source: input.source,
      seed: (input.seed ?? 0) >>> 0,
      sdk: SDK_SOURCE,
      data: scriptSnapshot(doc),
    },
    ctx.limits,
  );
  if (!run.ok) return { ok: false, error: run.error };

  if (!Array.isArray(run.output)) {
    return invalid(0, undefined, [[]], ["the script did not record a list of calls"]);
  }
  const recorded: unknown[] = run.output;
  const tooMany = (n: number): ExpandResult => ({
    ok: false,
    error: {
      kind: "too_many_ops",
      message: `the script produced ${n} operations; one run applies at most ${MAX_BATCH_OPS} — split the work into several runs`,
    },
  });
  // Checked before anything is replayed: a lower bound, every entry makes at least one op.
  if (recorded.length > MAX_BATCH_OPS) return tooMany(recorded.length);

  let work = doc;
  let idCounter = ctx.idCounter;
  const all: Op[] = [];
  const known = new Set(layerIds(doc));
  const layersCreated: string[] = [];
  for (const [i, item] of recorded.entries()) {
    const parsed = EntrySchema.safeParse(item);
    const line =
      typeof item === "object" &&
      item !== null &&
      typeof (item as { line?: unknown }).line === "number"
        ? (item as { line: number }).line
        : undefined;
    if (!parsed.success) {
      const { paths, messages } = fromIssues(parsed.error.issues);
      return invalid(i, line, paths, messages);
    }
    const entry = parsed.data;
    let ops: Op[];
    let raw = false;
    if (entry.kind === "op") {
      ops = [entry.op as unknown as Op];
      raw = true;
    } else {
      const intent = INTENTS[entry.kind];
      const checked = (intent.schema as z.ZodType).safeParse(entry.input);
      if (!checked.success) {
        const { paths, messages } = fromIssues(checked.error.issues, ["input"]);
        return invalid(i, entry.line, paths, messages);
      }
      try {
        // Each intent has its own input type; the schema above is the one it takes.
        ops = (intent.run as (d: Project, x: unknown) => { ops: Op[] })(work, checked.data).ops;
      } catch (e) {
        if (e instanceof IntentError) {
          return invalid(i, entry.line, [["input", ...e.path]], [e.message]);
        }
        return invalid(i, entry.line, [["input"]], [e instanceof Error ? e.message : String(e)]);
      }
    }
    if (ops.length === 0) continue;
    const applied = applyOps(work, ops, idCounter);
    if (!applied.ok) {
      const { paths, messages } = fromOpErrors(applied.errors, raw);
      return invalid(i, entry.line, paths, messages);
    }
    work = applied.doc;
    idCounter = applied.idCounter;
    for (const id of layerIds(work)) {
      if (!known.has(id)) {
        known.add(id);
        layersCreated.push(id);
      }
    }
    all.push(...ops);
  }
  if (all.length > MAX_BATCH_OPS) return tooMany(all.length);

  return { ok: true, ops: all, entries: recorded.length, layersCreated };
}
