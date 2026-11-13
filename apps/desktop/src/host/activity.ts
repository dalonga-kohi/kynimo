import { rename } from "node:fs/promises";
import type { McpRequestEvent } from "@kynimo/mcp/local";
import { clientLabel, UNKNOWN_CLIENT } from "./client-label.js";
import { atomicWriteJson, readJson } from "./files.js";

/** Tools that draw frames for the agent to look at: the agent is checking its work. */
export const FRAME_TOOLS: ReadonlySet<string> = new Set(["render_frames", "render_contact_sheet"]);

/** A new project belongs to the client that called `create_project` within this long before. */
export const CREATE_ATTRIBUTION_MS = 60_000;

/** Client labels kept; the least recently seen go first. */
const MAX_CLIENTS = 50;

export interface ProjectActivity {
  createdBy?: string;
  createdAt?: number;
  updatedAt?: number;
  lastClient?: string;
  lastCheckAt?: number;
}

export interface ActivityData {
  version: 1;
  projects: Record<string, ProjectActivity>;
  clients: Record<string, { lastSeenAt: number }>;
}

const emptyData = (): ActivityData => ({ version: 1, projects: {}, clients: {} });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length <= 200 ? v : undefined;

/** The log as read from disk, or undefined when it is not a version 1 log. */
export function parseActivity(raw: unknown): ActivityData | undefined {
  if (!isRecord(raw) || raw.version !== 1) return undefined;
  if (!isRecord(raw.projects) || !isRecord(raw.clients)) return undefined;
  const data = emptyData();
  for (const [id, value] of Object.entries(raw.projects)) {
    if (!isRecord(value)) return undefined;
    const entry: ProjectActivity = {};
    const createdBy = str(value.createdBy);
    const lastClient = str(value.lastClient);
    if (createdBy !== undefined) entry.createdBy = createdBy;
    if (lastClient !== undefined) entry.lastClient = lastClient;
    for (const key of ["createdAt", "updatedAt", "lastCheckAt"] as const) {
      const n = num(value[key]);
      if (n !== undefined) entry[key] = n;
    }
    data.projects[id] = entry;
  }
  for (const [label, value] of Object.entries(raw.clients)) {
    const lastSeenAt = isRecord(value) ? num(value.lastSeenAt) : undefined;
    if (lastSeenAt === undefined) return undefined;
    data.clients[label] = { lastSeenAt };
  }
  return data;
}

export interface ActivityLogOptions {
  file: string;
  now: () => number;
  /** Wait before a change is written. Default 1000 ms. */
  debounceMs?: number;
  /** Called when something the studio shows changed. */
  onChange?: () => void;
}

/**
 * What agents did, as far as the app can tell: who connected, who made and touched which project,
 * who is looking at frames. Kept in `activity.json`; the MCP server itself knows none of this.
 */
export class ActivityLog {
  private data: ActivityData;
  /** Versions seen by the last poll. */
  private readonly versions = new Map<string, number>();
  private polled = false;
  /** The label each user agent introduced itself with, for requests without `initialize`. */
  private readonly learned = new Map<string, string>();
  private recent: { label: string; at: number } | undefined;
  private lastCreate: { label: string; at: number } | undefined;
  private first: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: ActivityLogOptions,
    data: ActivityData,
  ) {
    this.data = data;
  }

  /** Reads the log; a missing file starts empty, a corrupt one starts empty and is kept as `.bak`. */
  static async open(options: ActivityLogOptions): Promise<ActivityLog> {
    let data: ActivityData | undefined;
    let corrupt = false;
    try {
      const raw = await readJson(options.file);
      if (raw === undefined) data = emptyData();
      else {
        data = parseActivity(raw);
        corrupt = data === undefined;
      }
    } catch {
      corrupt = true;
    }
    if (corrupt) {
      try {
        await rename(options.file, `${options.file}.bak`);
      } catch {
        // Nothing to keep, or no way to keep it: start empty all the same.
      }
    }
    return new ActivityLog(options, data ?? emptyData());
  }

  /** What one request tells us. `event.at` is the request's own time. */
  recordRequest(event: McpRequestEvent): void {
    const agent = event.userAgent ?? "";
    let label: string | undefined;
    for (const message of event.messages) {
      if (message.method === "initialize") {
        label = clientLabel(message.clientName);
        this.learned.set(agent, label);
      }
    }
    label ??= this.learned.get(agent) ?? UNKNOWN_CLIENT;

    this.first ??= event.at;
    this.recent = { label, at: event.at };
    this.data.clients[label] = { lastSeenAt: event.at };
    this.trimClients();
    for (const message of event.messages) {
      if (message.method !== "tools/call") continue;
      if (message.tool === "create_project") this.lastCreate = { label, at: event.at };
      const id = message.projectId;
      const entry = id === undefined ? undefined : this.data.projects[id];
      if (entry === undefined) continue;
      entry.lastClient = label;
      if (message.tool !== undefined && FRAME_TOOLS.has(message.tool)) entry.lastCheckAt = event.at;
    }
    this.changed();
  }

  /**
   * Compares the store's projects with the last poll: a new id was created now, by the client that
   * most likely did it; a higher version was updated now. The first poll only learns the
   * projects that exist, so it never invents a time for them.
   */
  observeProjects(projects: ReadonlyArray<{ id: string; version: number }>): void {
    const now = this.options.now();
    const first = !this.polled;
    this.polled = true;
    let touched = false;
    const ids = new Set<string>();
    for (const { id, version } of projects) {
      ids.add(id);
      const seen = this.versions.get(id);
      this.versions.set(id, version);
      let entry = this.data.projects[id];
      if (entry === undefined) {
        entry = {};
        this.data.projects[id] = entry;
        touched = true;
      }
      if (seen === undefined) {
        if (first) continue;
        entry.createdAt = now;
        entry.updatedAt = now;
        const by = this.creator(now);
        if (by !== undefined) entry.createdBy = by;
        touched = true;
      } else if (version > seen) {
        entry.updatedAt = now;
        touched = true;
      }
    }
    // Projects the store no longer lists leave the log.
    for (const id of Object.keys(this.data.projects)) {
      if (ids.has(id)) continue;
      delete this.data.projects[id];
      this.versions.delete(id);
      touched = true;
    }
    if (touched) this.changed();
  }

  project(id: string): ProjectActivity | undefined {
    return this.data.projects[id];
  }

  /** The client with the most recent request since this process started. */
  latestClient(): { name: string; lastSeenAt: number } | undefined {
    return this.recent === undefined
      ? undefined
      : { name: this.recent.label, lastSeenAt: this.recent.at };
  }

  get firstRequestAt(): number | undefined {
    return this.first;
  }

  /** Writes now if anything changed, and waits for writes in flight. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.dirty) this.write();
    await this.writing;
  }

  private creator(now: number): string | undefined {
    const create = this.lastCreate;
    if (create !== undefined && now - create.at <= CREATE_ATTRIBUTION_MS) return create.label;
    return this.recent?.label;
  }

  private trimClients(): void {
    const labels = Object.entries(this.data.clients);
    if (labels.length <= MAX_CLIENTS) return;
    labels.sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt);
    this.data.clients = Object.fromEntries(labels.slice(0, MAX_CLIENTS));
  }

  private changed(): void {
    this.dirty = true;
    this.options.onChange?.();
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write();
    }, this.options.debounceMs ?? 1000);
    this.timer.unref();
  }

  private write(): void {
    this.dirty = false;
    const snapshot = structuredClone(this.data);
    this.writing = this.writing
      .then(() => atomicWriteJson(this.options.file, snapshot))
      .catch(() => {
        // A failed write leaves the log in memory; the next change writes again.
        this.dirty = true;
      });
  }
}
