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
import {
  applyOps,
  MAX_BATCH_OPS,
  type Op,
  type OpError,
  type Project,
  withLayerDefaults,
} from "@kynimo/scene";
import { z } from "zod";
import { runScript, SCRIPT_LIMITS, type ScriptError, type ScriptLimits } from "./run.js";
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
      /** The operations the failing entry expanded to, when it got that far (what the paths index). */
      ops?: Op[];
    }
  | { kind: "too_many_ops"; message: string }
  | { kind: "too_many_intent_calls"; message: string };

export type ExpandResult =
  | { ok: true; ops: Op[]; entries: number; layersCreated: string[] }
  | { ok: false; error: ExpandError };

const Line = z.number().int().positive().optional();
// The host does not trust the SDK: the entry shape is checked here, ops by the scene on replay.
const EntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("op"),
    op: z.record(z.string(), z.unknown()),
    // Set by `Composition.add`: fill the layer fields every layer shares, like `add_layer`.
    defaults: z.literal(true).optional(),
    line: Line,
  }),
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

const invalid = (
  entry: number,
  line: number | undefined,
  errors: Path[],
  messages: string[],
  ops?: Op[],
) => {
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
      ...(ops === undefined ? {} : { ops }),
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

/** OpErrors of a failed intent `applyOps`; `ops[k]` paths are renamed for what the call produced. */
const fromOpErrors = (errors: OpError[]) => ({
  paths: errors.map((e) => (e.path[0] === "ops" ? ["expanded_ops", ...e.path.slice(1)] : e.path)),
  messages: errors.map((e) => e.message),
});

const layerIds = (doc: Project): string[] =>
  doc.compositions.flatMap((c) => c.layers.map((l) => l.id as string));

/**
 * Runs the script and expands what it recorded into one batch of scene operations, checking the
 * steps against the document as the earlier steps leave it. Never throws for script faults.
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
  const maxIntentCalls = ctx.limits?.maxIntentCalls ?? SCRIPT_LIMITS.maxIntentCalls;
  return replayEntries(doc, run.output, ctx.idCounter, maxIntentCalls, applyOps);
}

const tooMany = (n: number): ExpandResult => ({
  ok: false,
  error: {
    kind: "too_many_ops",
    message: `the script produced ${n} operations; one run applies at most ${MAX_BATCH_OPS} — split the work into several runs`,
  },
});

const isIntentKind = (item: unknown): boolean =>
  typeof item === "object" &&
  item !== null &&
  typeof (item as { kind?: unknown }).kind === "string" &&
  Object.hasOwn(INTENTS, (item as { kind: string }).kind);

/**
 * Replays the recorded entries against a working document. Consecutive raw operations are
 * applied as one batch (one full-document pass); an intent call applies the pending batch first,
 * since it expands against the document as it stands. Exported for tests, which inject `apply`
 * to count passes.
 */
export async function replayEntries(
  doc: Project,
  recorded: unknown[],
  startIdCounter: number,
  maxIntentCalls: number,
  apply: typeof applyOps,
): Promise<ExpandResult> {
  // Both caps are checked before anything is replayed. Every entry makes at least one op.
  if (recorded.length > MAX_BATCH_OPS) return tooMany(recorded.length);
  const intentCalls = recorded.filter(isIntentKind).length;
  if (intentCalls > maxIntentCalls) {
    return {
      ok: false,
      error: {
        kind: "too_many_intent_calls",
        message: `the script made ${intentCalls} intent calls (animate, preset, stagger, retime); one run allows at most ${maxIntentCalls}. Each call takes up to 50 targets: pass arrays of layers, or use stagger, instead of one call per layer`,
      },
    };
  }

  let work = doc;
  let idCounter = startIdCounter;
  const all: Op[] = [];
  // The raw operations waiting for the next pass, and the entry each came from.
  let pending: Op[] = [];
  let owners: { entry: number; line: number | undefined }[] = [];

  /** Applies the pending raw operations in one pass. Returns the failure, if any. */
  const flush = (): ExpandResult | undefined => {
    if (pending.length === 0) return undefined;
    const ops = pending;
    const from = owners;
    pending = [];
    owners = [];
    if (all.length + ops.length > MAX_BATCH_OPS) return tooMany(all.length + ops.length);
    const applied = apply(work, ops, idCounter);
    if (!applied.ok) {
      const at = (e: OpError): number | undefined =>
        e.path[0] === "ops" && typeof e.path[1] === "number" ? e.path[1] : undefined;
      const k = applied.errors.map(at).find((x) => x !== undefined) ?? 0;
      const owner = from[k] ?? from[0];
      if (owner === undefined) return invalid(0, undefined, [[]], ["rejected"]);
      // Only the errors of the entry that failed first; the paths are relative to its operation.
      const mine = applied.errors.filter((e) => (at(e) ?? k) === k);
      return invalid(
        owner.entry,
        owner.line,
        mine.map((e) => (e.path[0] === "ops" ? ["op", ...e.path.slice(2)] : e.path)),
        mine.map((e) => e.message),
        ops[k] === undefined ? undefined : [ops[k]],
      );
    }
    work = applied.doc;
    idCounter = applied.idCounter;
    all.push(...ops);
    return undefined;
  };
  /** A failure of entry `i`: failures of earlier entries still waiting in the batch come first. */
  const bail = (failure: ExpandResult): ExpandResult => flush() ?? failure;

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
      return bail(invalid(i, line, paths, messages));
    }
    const entry = parsed.data;
    if (entry.kind === "op") {
      let op = entry.op;
      if (entry.defaults) {
        if (op.op !== "addLayer") {
          return bail(invalid(i, entry.line, [["op", "op"]], ["defaults apply to addLayer only"]));
        }
        let target = work.compositions.find((c) => c.id === op.composition);
        if (target === undefined && pending.length > 0) {
          // The composition may be one the pending batch creates (precompose): make it current.
          const failed = flush();
          if (failed) return failed;
          target = work.compositions.find((c) => c.id === op.composition);
        }
        op = { ...op, layer: withLayerDefaults(op.layer, target) };
      }
      pending.push(op as unknown as Op);
      owners.push({ entry: i, line: entry.line });
      continue;
    }

    const failed = flush();
    if (failed) return failed;
    const intent = INTENTS[entry.kind];
    const checked = (intent.schema as z.ZodType).safeParse(entry.input);
    if (!checked.success) {
      const { paths, messages } = fromIssues(checked.error.issues, ["input"]);
      return invalid(i, entry.line, paths, messages);
    }
    let ops: Op[];
    try {
      // Each intent has its own input type; the schema above is the one it takes.
      ops = (intent.run as (d: Project, x: unknown) => { ops: Op[] })(work, checked.data).ops;
    } catch (e) {
      if (e instanceof IntentError) {
        return invalid(i, entry.line, [["input", ...e.path]], [e.message]);
      }
      return invalid(i, entry.line, [["input"]], [e instanceof Error ? e.message : String(e)]);
    }
    if (ops.length === 0) continue;
    if (all.length + ops.length > MAX_BATCH_OPS) return tooMany(all.length + ops.length);
    const applied = apply(work, ops, idCounter);
    if (!applied.ok) {
      const { paths, messages } = fromOpErrors(applied.errors);
      return invalid(i, entry.line, paths, messages, ops);
    }
    work = applied.doc;
    idCounter = applied.idCounter;
    all.push(...ops);
  }
  const failed = flush();
  if (failed) return failed;

  return { ok: true, ops: all, entries: recorded.length, layersCreated: created(doc, work, all) };
}

/** Ids of layers that exist at the end but not at the start, in the order they were created. */
function created(before: Project, after: Project, ops: Op[]): string[] {
  const known = new Set(layerIds(before));
  const fresh = layerIds(after).filter((id) => !known.has(id));
  if (fresh.length < 2) return fresh;
  // Layers sit in stacking order; `addLayer` ops give the order they were made in.
  const order = new Map<string, number>();
  for (const [i, op] of ops.entries()) {
    const id = (op as { id?: unknown }).id;
    if (op.op === "addLayer" && typeof id === "string" && !order.has(id)) order.set(id, i);
  }
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  return [...fresh].sort((a, b) => rank(a) - rank(b));
}
