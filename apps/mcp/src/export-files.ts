import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export type ExportFormat = "mp4" | "webm" | "gif";

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  gif: "image/gif",
};

export interface SavedExport {
  /** Unguessable download token (32 random bytes, base64url). */
  token: string;
  file: string;
  bytes: number;
  format: ExportFormat;
  expiresAt: number;
}

export interface ExportFilesOptions {
  ttlMs?: number;
  maxBytes?: number;
  now?: () => number;
}

const NAME = /^[a-z0-9-]{1,80}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const gone = (e: unknown) => (e as { code?: unknown }).code === "ENOENT";

async function remove(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (e) {
    if (!gone(e)) throw e;
  }
}

/**
 * Finished exports on local disk, each behind a download token that expires. Files left by an
 * earlier process stay until they are old enough, but have no token.
 */
export class ExportFiles {
  private readonly entries = new Map<string, SavedExport>();

  private constructor(
    readonly dir: string,
    private readonly ttlMs: number,
    private readonly maxBytes: number,
    // Wall-clock time is fine here: expiry is bookkeeping, not an evaluation or render path.
    private readonly now: () => number,
  ) {}

  static async open(dir: string, options: ExportFilesOptions = {}): Promise<ExportFiles> {
    const files = new ExportFiles(
      dir,
      options.ttlMs ?? 24 * 60 * 60 * 1000,
      options.maxBytes ?? 4 * 1024 ** 3,
      options.now ?? Date.now,
    );
    await mkdir(dir, { recursive: true });
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = join(dir, entry.name);
      try {
        if ((await stat(file)).mtimeMs + files.ttlMs <= files.now()) await remove(file);
      } catch (e) {
        if (!gone(e)) throw e;
      }
    }
    return files;
  }

  async save(source: string, name: string, format: ExportFormat): Promise<SavedExport> {
    if (!NAME.test(name)) throw new Error("export file names are 1-80 characters of a-z, 0-9, -");
    if (!(format in EXPORT_CONTENT_TYPES)) throw new Error(`unknown export format '${format}'`);
    const file = join(this.dir, `${name}.${format}`);
    try {
      await rename(source, file);
    } catch (e) {
      if ((e as { code?: unknown }).code !== "EXDEV") throw e;
      await copyFile(source, file);
      await unlink(source);
    }
    const saved: SavedExport = {
      token: randomBytes(32).toString("base64url"),
      file,
      bytes: (await stat(file)).size,
      format,
      expiresAt: this.now() + this.ttlMs,
    };
    // A file saved under the same name replaces the old one; its token would serve the new bytes.
    for (const [token, old] of this.entries) if (old.file === file) this.entries.delete(token);
    this.entries.set(saved.token, saved);
    await this.sweep();
    return { ...saved };
  }

  lookup(token: string): SavedExport | undefined {
    if (!TOKEN.test(token)) return undefined;
    const saved = this.entries.get(token);
    if (saved === undefined) return undefined;
    if (saved.expiresAt <= this.now()) {
      void this.sweep().catch(() => undefined);
      return undefined;
    }
    return { ...saved };
  }

  async sweep(): Promise<void> {
    const now = this.now();
    const drop = async (token: string) => {
      const saved = this.entries.get(token);
      if (saved === undefined) return;
      this.entries.delete(token);
      await remove(saved.file);
    };
    for (const [token, saved] of [...this.entries]) if (saved.expiresAt <= now) await drop(token);
    // Map order is insertion order, so the oldest saves come first.
    let total = 0;
    for (const saved of this.entries.values()) total += saved.bytes;
    for (const [token, saved] of [...this.entries]) {
      if (total <= this.maxBytes) break;
      total -= saved.bytes;
      await drop(token);
    }
  }
}
