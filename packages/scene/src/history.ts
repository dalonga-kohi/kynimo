import { type ApplyResult, applyOps, type OpError, validateDoc } from "./apply.js";
import { applyChange, type Change, clone, invert } from "./changes.js";
import type { Project } from "./project.js";

/** Most batches kept per actor; the oldest are dropped first. */
export const MAX_HISTORY = 100;

interface Stacks {
  readonly undo: readonly (readonly Change[])[];
  readonly redo: readonly (readonly Change[])[];
}

/** Per-actor undo/redo stacks, owned by the caller. Immutable: every operation returns a new one. */
export type History = ReadonlyMap<string, Stacks>;

/** Everything the write path carries between calls. The caller stores it (e.g. per session). */
export interface SceneState {
  readonly doc: Project;
  /** Seeded id counter (ADR-0009). */
  readonly idCounter: number;
  readonly history: History;
}

export const createSceneState = (doc: Project, idCounter = 0): SceneState => ({
  doc,
  idCounter,
  history: new Map(),
});

export type StepResult =
  | { ok: true; state: SceneState; changes: Change[] }
  /** `state` is the original, untouched state. */
  | { ok: false; kind: "invalid" | "conflict" | "empty"; state: SceneState; errors: OpError[] };

const EMPTY: Stacks = { undo: [], redo: [] };
const actorError = (state: SceneState, actor: unknown): StepResult | undefined =>
  typeof actor === "string" && actor.length > 0 && actor.length <= 100
    ? undefined
    : {
        ok: false,
        kind: "invalid",
        state,
        errors: [
          {
            path: ["actor"],
            message: "actor must be a non-empty string of at most 100 characters",
          },
        ],
      };

const withStacks = (state: SceneState, actor: string, stacks: Stacks): History =>
  new Map(state.history).set(actor, stacks);

/** Applies `changes` in order to a copy; any mismatch or an invalid result is a conflict. */
function replay(
  doc: Project,
  changes: readonly Change[],
): { doc: Project } | { errors: OpError[] } {
  const draft = clone(doc);
  for (const change of changes) {
    const conflict = applyChange(draft, change);
    if (conflict !== undefined) return { errors: [{ path: [], message: conflict }] };
  }
  return validateDoc(draft);
}

/** Applies a batch for `actor` atomically and records it for that actor's undo. A new batch clears the actor's redo. */
export function applyBatch(state: SceneState, actor: string, ops: unknown): StepResult {
  const bad = actorError(state, actor);
  if (bad) return bad;
  const result: ApplyResult = applyOps(state.doc, ops, state.idCounter);
  if (!result.ok) return { ok: false, kind: "invalid", state, errors: result.errors };
  if (result.changes.length === 0)
    return {
      ok: true,
      state: { ...state, doc: result.doc, idCounter: result.idCounter },
      changes: [],
    };
  const stacks = state.history.get(actor) ?? EMPTY;
  const undo = [...stacks.undo, result.changes].slice(-MAX_HISTORY);
  return {
    ok: true,
    changes: result.changes,
    state: {
      doc: result.doc,
      idCounter: result.idCounter,
      history: withStacks(state, actor, { undo, redo: [] }),
    },
  };
}

/** Reverts the actor's most recent batch, unless a later edit touched the same properties. */
export function undo(state: SceneState, actor: string): StepResult {
  const bad = actorError(state, actor);
  if (bad) return bad;
  const stacks = state.history.get(actor) ?? EMPTY;
  const entry = stacks.undo[stacks.undo.length - 1];
  if (entry === undefined)
    return {
      ok: false,
      kind: "empty",
      state,
      errors: [{ path: [], message: `nothing to undo for actor '${actor}'` }],
    };
  const changes = [...entry].reverse().map(invert);
  const replayed = replay(state.doc, changes);
  if ("errors" in replayed) return { ok: false, kind: "conflict", state, errors: replayed.errors };
  return {
    ok: true,
    changes,
    state: {
      ...state,
      doc: replayed.doc,
      history: withStacks(state, actor, {
        undo: stacks.undo.slice(0, -1),
        redo: [...stacks.redo, entry],
      }),
    },
  };
}

/** Re-applies the batch the actor last undid, if the document still matches what it expects. */
export function redo(state: SceneState, actor: string): StepResult {
  const bad = actorError(state, actor);
  if (bad) return bad;
  const stacks = state.history.get(actor) ?? EMPTY;
  const entry = stacks.redo[stacks.redo.length - 1];
  if (entry === undefined)
    return {
      ok: false,
      kind: "empty",
      state,
      errors: [{ path: [], message: `nothing to redo for actor '${actor}'` }],
    };
  const replayed = replay(state.doc, entry);
  if ("errors" in replayed) return { ok: false, kind: "conflict", state, errors: replayed.errors };
  return {
    ok: true,
    changes: [...entry],
    state: {
      ...state,
      doc: replayed.doc,
      history: withStacks(state, actor, {
        undo: [...stacks.undo, entry],
        redo: stacks.redo.slice(0, -1),
      }),
    },
  };
}
