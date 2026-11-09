import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AwsClient } from "aws4fetch";

/**
 * Asset keys are content-addressed: `assets/<sha256>.<ext>`, the same string a document's asset
 * entry holds as `uri`. Equal bytes share one object, so a put is idempotent and a retry is free.
 */
export const BLOB_KEY_PATTERN = /^assets\/[0-9a-f]{64}\.(png|jpg|ttf|otf)$/;

/** Largest asset file, decoded: what `upload_asset` takes (ADR-0031). */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** Base64 characters for MAX_ASSET_BYTES, with room for line breaks a client may add. */
export const MAX_ASSET_BASE64 = Math.ceil((Math.ceil(MAX_ASSET_BYTES / 3) * 4 * 1.05) / 4) * 4;

export const isBlobKey = (key: string): boolean => BLOB_KEY_PATTERN.test(key);

export const blobKey = (sha256: string, ext: "png" | "jpg" | "ttf" | "otf"): string =>
  `assets/${sha256}.${ext}`;

function checkKey(key: string): void {
  if (!BLOB_KEY_PATTERN.test(key)) throw new Error(`invalid asset key '${key}'`);
}

/** Where asset bytes live (ADR-0031). Documents hold only the key and the hash. */
export interface BlobStore {
  /** Stores bytes under their key. Storing the same key again is a no-op. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** The bytes, or undefined when nothing is stored under the key. */
  get(key: string): Promise<Uint8Array | undefined>;
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<void> {
    checkKey(key);
    if (!this.blobs.has(key)) this.blobs.set(key, bytes.slice());
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    checkKey(key);
    return this.blobs.get(key)?.slice();
  }
}

const isMissing = (e: unknown) =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT";

/** One file per key under `dir` (the local server keeps it next to its projects). */
export class DirBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    checkKey(key);
    return join(this.dir, key);
  }

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<void> {
    const path = this.path(key);
    try {
      await stat(path);
      return;
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    await mkdir(dirname(path), { recursive: true });
    // Temp file + rename: a crash never leaves a partial object under a content key.
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (e) {
      if (isMissing(e)) return undefined;
      throw e;
    }
  }
}

export interface S3Config {
  /** Origin of the S3-compatible API, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  /** `auto` for R2. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Reads `KYNIMO_S3_*`; undefined when none is set, an error naming what is missing otherwise. */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv): S3Config | undefined {
  const read = (name: string) => env[`KYNIMO_S3_${name}`] || undefined;
  const config = {
    endpoint: read("ENDPOINT"),
    bucket: read("BUCKET"),
    region: read("REGION") ?? "auto",
    accessKeyId: read("ACCESS_KEY_ID"),
    secretAccessKey: read("SECRET_ACCESS_KEY"),
  };
  const required = ["endpoint", "bucket", "accessKeyId", "secretAccessKey"] as const;
  const missing = required.filter((k) => config[k] === undefined);
  if (missing.length === required.length) return undefined;
  if (missing.length > 0)
    throw new Error(
      `asset storage: set all of KYNIMO_S3_ENDPOINT, KYNIMO_S3_BUCKET, KYNIMO_S3_ACCESS_KEY_ID and KYNIMO_S3_SECRET_ACCESS_KEY (missing: ${missing.join(", ")})`,
    );
  const endpoint = new URL(config.endpoint as string);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost")
    throw new Error("asset storage: KYNIMO_S3_ENDPOINT must be an https URL");
  return config as S3Config;
}

type Fetch = (request: Request) => Promise<Response>;

/**
 * An S3-compatible bucket (Cloudflare R2 first; AWS S3, MinIO, Tigris alike), path-style
 * addressing, SigV4-signed with aws4fetch. Objects are immutable under their content key.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(
    config: S3Config,
    private readonly send: Fetch = (r) => fetch(r),
    /** Per request; a stalled bucket must not hang an upload or a render. */
    private readonly timeoutMs = 30_000,
  ) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: config.region,
      retries: 0,
    });
    this.base = `${config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}/`;
  }

  private async request(method: "GET" | "PUT", key: string, init: RequestInit = {}) {
    checkKey(key);
    const signed = await this.client.sign(this.base + key, { method, ...init });
    try {
      return await this.send(new Request(signed, { signal: AbortSignal.timeout(this.timeoutMs) }));
    } catch (e) {
      const name = (e as { name?: unknown }).name;
      if (name === "TimeoutError" || name === "AbortError")
        throw new Error(
          `asset storage: ${method} ${key} timed out after ${this.timeoutMs / 1000} s`,
        );
      throw new Error(
        `asset storage: ${method} ${key} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const res = await this.request("PUT", key, {
      body: bytes,
      // A signed body hash (not UNSIGNED-PAYLOAD): the bucket rejects bytes altered on the way.
      headers: {
        "content-type": contentType,
        "x-amz-content-sha256": createHash("sha256").update(bytes).digest("hex"),
      },
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`asset storage: storing ${key} failed with HTTP ${res.status}`);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const res = await this.request("GET", key);
    if (res.status === 404 || !res.ok) await res.body?.cancel();
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`asset storage: reading ${key} failed with HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
