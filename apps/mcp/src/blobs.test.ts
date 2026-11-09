import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BlobStore,
  blobKey,
  DirBlobStore,
  MemoryBlobStore,
  S3BlobStore,
  s3ConfigFromEnv,
} from "./blobs.js";

const KEY = blobKey("a".repeat(64), "png");
const bytes = new Uint8Array([1, 2, 3]);

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const local: [string, () => Promise<BlobStore>][] = [
  ["MemoryBlobStore", async () => new MemoryBlobStore()],
  [
    "DirBlobStore",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "kynimo-blobs-"));
      dirs.push(dir);
      return new DirBlobStore(dir);
    },
  ],
];

describe.each(local)("%s", (_, make) => {
  it("stores and reads bytes by key, and a second put of the key is a no-op", async () => {
    const store = await make();
    expect(await store.get(KEY)).toBeUndefined();
    await store.put(KEY, bytes, "image/png");
    await store.put(KEY, new Uint8Array([9]), "image/png");
    expect(await store.get(KEY)).toEqual(bytes);
  });

  it("refuses keys that are not content keys", async () => {
    const store = await make();
    for (const key of ["assets/../x.png", "assets/logo.png", `/${KEY}`, `${KEY}/x`])
      await expect(store.put(key, bytes, "image/png")).rejects.toThrow(/invalid asset key/);
    await expect(store.get("../etc/passwd")).rejects.toThrow(/invalid asset key/);
  });
});

it("DirBlobStore leaves no temp files behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kynimo-blobs-"));
  dirs.push(dir);
  await new DirBlobStore(dir).put(KEY, bytes, "image/png");
  expect(await readdir(join(dir, "assets"))).toEqual([`${"a".repeat(64)}.png`]);
});

describe("S3BlobStore", () => {
  const config = {
    endpoint: "https://acct.r2.cloudflarestorage.com/",
    bucket: "kynimo-assets",
    region: "auto",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret",
  };

  it("sends SigV4-signed, path-style requests and maps 404 to missing", async () => {
    const seen: Request[] = [];
    const responses = [
      new Response(null, { status: 200 }),
      new Response(bytes),
      new Response(null, { status: 404 }),
    ];
    const store = new S3BlobStore(config, async (r) => {
      seen.push(r);
      return responses.shift() as Response;
    });
    await store.put(KEY, bytes, "image/png");
    expect(await store.get(KEY)).toEqual(bytes);
    expect(await store.get(KEY)).toBeUndefined();
    expect(seen.map((r) => [r.method, r.url])).toEqual([
      ["PUT", `https://acct.r2.cloudflarestorage.com/kynimo-assets/${KEY}`],
      ["GET", `https://acct.r2.cloudflarestorage.com/kynimo-assets/${KEY}`],
      ["GET", `https://acct.r2.cloudflarestorage.com/kynimo-assets/${KEY}`],
    ]);
    const auth = seen[0]?.headers.get("authorization") ?? "";
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/);
    expect(auth).not.toContain("secret");
    expect(seen[0]?.headers.get("content-type")).toBe("image/png");
    expect(seen[0]?.headers.get("x-amz-content-sha256")).toBe(
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    );
    expect(auth).toContain("x-amz-content-sha256");
  });

  it("times out a stalled request, naming the key", async () => {
    const store = new S3BlobStore(
      config,
      (r) =>
        new Promise((_, reject) =>
          r.signal.addEventListener("abort", () => reject(r.signal.reason)),
        ),
      20,
    );
    await expect(store.get(KEY)).rejects.toThrow(`asset storage: GET ${KEY} timed out`);
  });

  it("reports other statuses by code only", async () => {
    const store = new S3BlobStore(
      config,
      async () => new Response("<Error>details</Error>", { status: 403 }),
    );
    await expect(store.put(KEY, bytes, "image/png")).rejects.toThrow(/HTTP 403$/);
    await expect(store.get(KEY)).rejects.toThrow(/HTTP 403$/);
  });
});

describe("s3ConfigFromEnv", () => {
  const full = {
    KYNIMO_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    KYNIMO_S3_BUCKET: "b",
    KYNIMO_S3_ACCESS_KEY_ID: "id",
    KYNIMO_S3_SECRET_ACCESS_KEY: "secret",
  };

  it("is undefined when nothing is set and defaults the region to auto", () => {
    expect(s3ConfigFromEnv({})).toBeUndefined();
    expect(s3ConfigFromEnv(full)).toMatchObject({ bucket: "b", region: "auto" });
  });

  it("names what is missing, never the values, and requires https", () => {
    const { KYNIMO_S3_BUCKET: _, ...partial } = full;
    expect(() => s3ConfigFromEnv(partial)).toThrow(/missing: bucket/);
    expect(() => s3ConfigFromEnv(partial)).not.toThrow(/secret/);
    expect(() => s3ConfigFromEnv({ ...full, KYNIMO_S3_ENDPOINT: "http://example.com" })).toThrow(
      /https/,
    );
  });
});
