import {
  type HostEvent,
  type HostMessage,
  type HostMethod,
  type HostMethods,
  type HostRequest,
  isHostEvent,
} from "../shared/protocol.js";

/** The message channel to the host: a utility process's `postMessage` and its messages. */
export interface HostChannel {
  postMessage(message: unknown): void;
  /** Called with every message the host sends. */
  onMessage(listener: (message: HostMessage) => void): void;
  /** Called once when the host process is gone. */
  onExit(listener: () => void): void;
  kill(): void;
}

export interface HostClientOptions {
  /** How long `stop` waits for the host to close before killing it. Default 5 s. */
  closeTimeoutMs?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** Typed request/response over a `HostChannel`, plus the events the host sends unprompted. */
export class HostClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private exited = false;

  constructor(
    private readonly channel: HostChannel,
    private readonly options: HostClientOptions = {},
  ) {
    channel.onMessage((message) => {
      if (isHostEvent(message)) {
        for (const listener of this.listeners) listener(message);
        return;
      }
      const waiting = this.pending.get(message.id);
      if (waiting === undefined) return;
      this.pending.delete(message.id);
      if ("error" in message) waiting.reject(new Error(message.error));
      else waiting.resolve(message.result);
    });
    channel.onExit(() => {
      this.exited = true;
      for (const waiting of this.pending.values()) waiting.reject(new Error("the server stopped"));
      this.pending.clear();
    });
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request<M extends HostMethod>(
    method: M,
    ...params: HostMethods[M]["params"] extends undefined ? [] : [HostMethods[M]["params"]]
  ): Promise<HostMethods[M]["result"]> {
    if (this.exited) return Promise.reject(new Error("the server stopped"));
    const id = this.nextId++;
    const request: HostRequest = {
      id,
      method,
      ...(params[0] === undefined ? {} : { params: params[0] }),
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.channel.postMessage(request);
    });
  }

  /** Asks the host to close its server, waits up to the timeout, then kills it. */
  async stop(): Promise<void> {
    if (this.exited) return;
    const timeout = this.options.closeTimeoutMs ?? 5000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.request("close").catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeout);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.channel.kill();
    }
  }
}
