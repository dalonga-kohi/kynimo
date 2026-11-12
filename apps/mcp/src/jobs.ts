import { randomUUID } from "node:crypto";

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type JobPhase = "queued" | "rendering" | "encoding" | "storing" | "done";

export interface JobProgress {
  phase: JobPhase;
  frames_done: number;
  frames_total: number;
}

export interface JobError {
  code: string;
  message: string;
}

export interface JobRecord<R> {
  id: string;
  account: string;
  actor: string;
  projectId: string;
  /** Opaque to the queue ("export", "preview", ...). */
  kind: string;
  state: JobState;
  progress: JobProgress;
  /** Milliseconds from the queue's clock. */
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  result: R | null;
  error: JobError | null;
}

export const JOB_LIMITS = {
  /** Jobs running at once, server-wide (one capture session). */
  concurrency: 1,
  /** Queued + running per account. */
  maxActivePerAccount: 4,
  /** Queued + running server-wide. */
  maxActive: 32,
  /** Finished records are kept this long. */
  retentionMs: 24 * 60 * 60 * 1000,
  /** Finished records kept per account; the oldest finished are dropped first. */
  maxRecordsPerAccount: 100,
} as const;

export type JobLimits = { -readonly [K in keyof typeof JOB_LIMITS]: number };

export class JobQueueError extends Error {
  override name = "JobQueueError";
  constructor(
    readonly kind: "key_reused" | "busy" | "closed",
    message: string,
  ) {
    super(message);
  }
}

export interface JobContext {
  readonly signal: AbortSignal;
  /** Merges fields into the job's progress; ignored once the job has finished. */
  progress(p: Partial<JobProgress>): void;
}

export interface JobQueueOptions {
  limits?: Partial<JobLimits>;
  now?: () => number;
  makeId?: () => string;
  describeError?: (e: unknown) => JobError;
}

export interface JobSpec<R> {
  account: string;
  actor: string;
  projectId: string;
  kind: string;
  key?: { idempotencyKey: string; fingerprint: string };
  frames_total: number;
  run: (ctx: JobContext) => Promise<R>;
}

interface Entry<R> {
  record: JobRecord<R>;
  run: (ctx: JobContext) => Promise<R>;
  controller: AbortController;
  keyId: string | null;
  fingerprint: string;
  settled: Promise<void>;
  settle: () => void;
  waiters: Set<() => void>;
}

const isFinished = (s: JobState) => s === "succeeded" || s === "failed" || s === "cancelled";

/**
 * An in-process FIFO job queue with a server-wide concurrency limit, per-account limits,
 * idempotent submits and time/count retention of finished records. State is lost on restart.
 */
export class JobQueue<R> {
  private readonly limits: JobLimits;
  // Wall-clock time is fine here: the queue is bookkeeping, not an evaluation or render path.
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly describeError: (e: unknown) => JobError;
  private readonly entries = new Map<string, Entry<R>>();
  private readonly keys = new Map<string, string>();
  private readonly pending: Entry<R>[] = [];
  private running = 0;
  private closed = false;

  constructor(options: JobQueueOptions = {}) {
    this.limits = { ...JOB_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? (() => `j-${randomUUID().replaceAll("-", "")}`);
    this.describeError =
      options.describeError ??
      ((e) => ({ code: "failed", message: e instanceof Error ? e.message : String(e) }));
  }

  submit(spec: JobSpec<R>): { job: JobRecord<R>; replayed: boolean } {
    if (this.closed) throw new JobQueueError("closed", "the server is shutting down");
    this.sweep();
    const keyId =
      spec.key === undefined
        ? null
        : JSON.stringify([spec.account, spec.actor, spec.projectId, spec.key.idempotencyKey]);
    if (keyId !== null) {
      const existing = this.entries.get(this.keys.get(keyId) ?? "");
      if (existing !== undefined) {
        if (existing.fingerprint !== spec.key?.fingerprint)
          throw new JobQueueError(
            "key_reused",
            "idempotency_key was already used for a different request; use a new key",
          );
        return { job: this.copy(existing.record), replayed: true };
      }
    }
    let active = 0;
    let accountActive = 0;
    for (const e of this.entries.values()) {
      if (isFinished(e.record.state)) continue;
      active++;
      if (e.record.account === spec.account) accountActive++;
    }
    if (accountActive >= this.limits.maxActivePerAccount)
      throw new JobQueueError(
        "busy",
        `this account already has ${this.limits.maxActivePerAccount} exports queued or running; wait for one to finish or cancel one`,
      );
    if (active >= this.limits.maxActive)
      throw new JobQueueError(
        "busy",
        `the server is busy with ${active} exports; retry in a minute`,
      );

    let settle = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const entry: Entry<R> = {
      record: {
        id: this.makeId(),
        account: spec.account,
        actor: spec.actor,
        projectId: spec.projectId,
        kind: spec.kind,
        state: "queued",
        progress: { phase: "queued", frames_done: 0, frames_total: spec.frames_total },
        createdAt: this.now(),
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
      },
      run: spec.run,
      controller: new AbortController(),
      keyId,
      fingerprint: spec.key?.fingerprint ?? "",
      settled,
      settle,
      waiters: new Set(),
    };
    this.entries.set(entry.record.id, entry);
    if (keyId !== null) this.keys.set(keyId, entry.record.id);
    this.pending.push(entry);
    queueMicrotask(() => this.pump());
    return { job: this.copy(entry.record), replayed: false };
  }

  get(account: string, id: string): JobRecord<R> | undefined {
    this.sweep();
    const entry = this.owned(account, id);
    return entry && this.copy(entry.record);
  }

  wait(account: string, id: string, ms: number): Promise<JobRecord<R> | undefined> {
    const entry = this.owned(account, id);
    if (entry === undefined) return Promise.resolve(undefined);
    if (isFinished(entry.record.state) || !(ms > 0))
      return Promise.resolve(this.copy(entry.record));
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        entry.waiters.delete(done);
        resolve(this.copy(entry.record));
      };
      const timer = setTimeout(done, ms);
      entry.waiters.add(done);
    });
  }

  cancel(account: string, id: string): JobRecord<R> | undefined {
    const entry = this.owned(account, id);
    if (entry === undefined) return undefined;
    const { record } = entry;
    if (record.state === "queued") {
      this.pending.splice(this.pending.indexOf(entry), 1);
      this.finish(entry, "cancelled");
    } else if (record.state === "running") {
      entry.controller.abort();
    }
    return this.copy(record);
  }

  /** Rejects later submits, cancels queued jobs, aborts running ones and waits for them to settle. */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of [...this.pending]) this.cancel(entry.record.account, entry.record.id);
    const running = [...this.entries.values()].filter((e) => e.record.state === "running");
    for (const e of running) e.controller.abort();
    await Promise.all(running.map((e) => e.settled));
  }

  private owned(account: string, id: string): Entry<R> | undefined {
    const entry = this.entries.get(id);
    return entry?.record.account === account ? entry : undefined;
  }

  private copy(record: JobRecord<R>): JobRecord<R> {
    return {
      ...record,
      progress: { ...record.progress },
      error: record.error && { ...record.error },
    };
  }

  private pump(): void {
    while (!this.closed && this.running < this.limits.concurrency) {
      const entry = this.pending.shift();
      if (entry === undefined) return;
      this.start(entry);
    }
  }

  private start(entry: Entry<R>): void {
    const { record } = entry;
    this.running++;
    record.state = "running";
    record.startedAt = this.now();
    record.progress.phase = "rendering";
    const ctx: JobContext = {
      signal: entry.controller.signal,
      progress: (p) => {
        if (record.state === "running") Object.assign(record.progress, p);
      },
    };
    let run: Promise<R>;
    try {
      run = entry.run(ctx);
    } catch (e) {
      run = Promise.reject(e);
    }
    run.then(
      (result) => {
        if (entry.controller.signal.aborted) this.finish(entry, "cancelled");
        else this.finish(entry, "succeeded", result);
      },
      (e: unknown) => {
        if (entry.controller.signal.aborted) this.finish(entry, "cancelled");
        else this.finish(entry, "failed", undefined, this.describeError(e));
      },
    );
  }

  private finish(
    entry: Entry<R>,
    state: "succeeded" | "failed" | "cancelled",
    result?: R,
    error?: JobError,
  ): void {
    const wasRunning = entry.record.state === "running";
    const { record } = entry;
    record.state = state;
    record.finishedAt = this.now();
    if (state === "succeeded") {
      record.progress.phase = "done";
      record.progress.frames_done = record.progress.frames_total;
      record.result = result as R;
    } else if (state === "failed") {
      record.error = error ?? null;
    }
    for (const done of [...entry.waiters]) done();
    entry.settle();
    if (wasRunning) {
      this.running--;
      this.pump();
    }
  }

  /** Drops expired finished records, then the oldest beyond the per-account cap, with their keys. */
  private sweep(): void {
    const now = this.now();
    const byAccount = new Map<string, Entry<R>[]>();
    for (const entry of [...this.entries.values()]) {
      const { record } = entry;
      if (!isFinished(record.state)) continue;
      if ((record.finishedAt as number) + this.limits.retentionMs <= now) {
        this.drop(entry);
        continue;
      }
      const list = byAccount.get(record.account) ?? [];
      list.push(entry);
      byAccount.set(record.account, list);
    }
    for (const list of byAccount.values()) {
      if (list.length <= this.limits.maxRecordsPerAccount) continue;
      list.sort((a, b) => (a.record.finishedAt as number) - (b.record.finishedAt as number));
      for (const entry of list.slice(0, list.length - this.limits.maxRecordsPerAccount))
        this.drop(entry);
    }
  }

  private drop(entry: Entry<R>): void {
    this.entries.delete(entry.record.id);
    if (entry.keyId !== null) this.keys.delete(entry.keyId);
  }
}
