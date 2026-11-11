/** A path into the tool input: where a refusal points. */
export type InputPath = (string | number)[];

/** Every refusal of an intent expansion: a message and where in the tool input it applies. */
export class IntentError extends Error {
  constructor(
    readonly path: InputPath,
    message: string,
  ) {
    super(message);
    this.name = "IntentError";
  }
}

/** Runs `fn`; an `IntentError` with no path of its own is rethrown at `path`. */
export function scoped<T>(path: InputPath, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof IntentError && e.path.length === 0) throw new IntentError(path, e.message);
    throw e;
  }
}
