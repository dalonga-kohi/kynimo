export type { DeclarationSizes } from "./declarations.js";
export { sdkDeclarationSizes, sdkDeclarations } from "./declarations.js";
export type {
  ExpandContext,
  ExpandError,
  ExpandInput,
  ExpandResult,
} from "./expand.js";
export { expandScript } from "./expand.js";
export type { RunInput, RunResult, ScriptError, ScriptErrorKind, ScriptLimits } from "./run.js";
export { runScript, SCRIPT_LIMITS } from "./run.js";
export type { CompositionSnapshot, LayerSnapshot, ScriptSnapshot } from "./snapshot.js";
export { scriptSnapshot } from "./snapshot.js";
