/**
 * Newline-delimited JSON-RPC on one side, the app's MCP endpoint on the other. For clients that
 * only know how to launch a stdio server. Pure of process globals: everything it touches is passed in.
 */

export interface BridgeOptions {
  /** Lines from the client. */
  lines: AsyncIterable<string>;
  /** One line to the client (no trailing newline). */
  write(line: string): void;
  /** Diagnostics; the real stdout carries the protocol, so these go to stderr. */
  log(line: string): void;
  /** The endpoint from `endpoint.json`, or undefined when the app has not written it. */
  readEndpoint(): Promise<string | undefined>;
  /** Starts the app. Called at most once. */
  launchApp(): void;
  /** How long to wait for the app to come up before answering "not running". Default 30 s. */
  waitMs?: number;
  /** Pause between attempts while waiting. Default 500 ms. */
  retryMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export const NOT_RUNNING = "Kynimo is not running";
const ERROR_CODE = -32000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The ids of the requests (not notifications) in a message or batch. */
function requestIds(message: unknown): Array<string | number | null> {
  const items = Array.isArray(message) ? message : [message];
  const ids: Array<string | number | null> = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.method !== "string") continue;
    const id = item.id;
    if (typeof id === "string" || typeof id === "number") ids.push(id);
  }
  return ids;
}

const errorReply = (id: string | number | null, text: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code: ERROR_CODE, message: text },
});

/** JSON messages in a response body: plain JSON, or the `data:` events of an event stream. */
function bodyMessages(body: string, contentType: string | null): string[] {
  const text = body.trim();
  if (text === "") return [];
  if (contentType?.includes("text/event-stream")) {
    return text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((data) => data !== "");
  }
  return [text];
}

export async function runBridge(options: BridgeOptions): Promise<void> {
  const { write, log } = options;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? 30_000;
  const retryMs = options.retryMs ?? 500;
  let launched = false;
  const launchOnce = () => {
    if (launched) return;
    launched = true;
    log("Kynimo is not running; starting it");
    try {
      options.launchApp();
    } catch (e) {
      log(`could not start Kynimo: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const emit = (body: string, contentType: string | null): boolean => {
    let wrote = false;
    for (const raw of bodyMessages(body, contentType)) {
      try {
        write(JSON.stringify(JSON.parse(raw)));
        wrote = true;
      } catch {
        log(`dropped a response that is not JSON: ${raw.slice(0, 200)}`);
      }
    }
    return wrote;
  };

  const forward = async (line: string, message: unknown): Promise<void> => {
    const ids = requestIds(message);
    const fail = (text: string) => {
      const replies = ids.map((id) => errorReply(id, text));
      if (replies.length === 0) return;
      write(JSON.stringify(Array.isArray(message) ? replies : replies[0]));
    };
    const deadline = now() + waitMs;
    for (;;) {
      const endpoint = await options.readEndpoint();
      if (endpoint !== undefined) {
        try {
          const res = await doFetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: line,
          });
          const body = res.status === 202 ? "" : await res.text();
          if (!emit(body, res.headers.get("content-type")) && res.status !== 202 && !res.ok)
            fail(`Kynimo answered HTTP ${res.status}`);
          return;
        } catch (e) {
          log(`cannot reach ${endpoint}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      launchOnce();
      if (now() >= deadline) return fail(NOT_RUNNING);
      await sleep(retryMs);
    }
  };

  const pending: Promise<void>[] = [];
  for await (const raw of options.lines) {
    const line = raw.trim();
    if (line === "") continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      );
      continue;
    }
    pending.push(
      forward(line, message).catch((e) => {
        log(`request failed: ${e instanceof Error ? e.message : String(e)}`);
      }),
    );
  }
  await Promise.all(pending);
}
