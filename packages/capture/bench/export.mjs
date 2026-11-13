// Export benchmark: draws whole reference scenes through an export session and reports where the
// time went. Run after `pnpm build`:
//
//   node packages/capture/bench/export.mjs [scene ...]
//
// KYNIMO_BENCH_FRAMES caps the frames per scene (default: the whole composition).
// KYNIMO_BENCH_JSON=<file> also writes the numbers as JSON.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { launchCapture } from "../dist/index.js";

const REFERENCE = new URL("../reference/", import.meta.url);
const DEFAULT = ["title-card", "product-card", "shader-backgrounds", "components", "motion-blur"];
const scenes = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT;
const cap = Number(process.env.KYNIMO_BENCH_FRAMES ?? Number.POSITIVE_INFINITY);

const session = await launchCapture();
console.log(`chromium ${session.browserVersion} · ${session.gpu}`);
const rows = [];
try {
  for (const scene of scenes) {
    const dir = new URL(`${scene}/`, REFERENCE);
    const doc = JSON.parse(readFileSync(new URL("scene.json", dir), "utf8"));
    const comp = doc.compositions.find((c) => c.id === doc.mainCompositionId);
    const assets = new Map(
      (doc.assets ?? [])
        .filter((a) => a.type === "image" || a.type === "font")
        .map((a) => [a.id, new Uint8Array(readFileSync(new URL(a.uri, dir)))]),
    );
    const frames = Math.min(comp.durationFrames, cap);
    const open = await session.openExport(doc, { assets, alpha: "premultiplied" });
    // Every frame's bytes go into one hash: equal hashes mean an optimization kept the pixels.
    const hash = createHash("sha256");
    const started = performance.now();
    for (let n = 0; n < frames; n++) hash.update((await open.frame(n)).rgba);
    const wallMs = performance.now() - started;
    const t = await open.timings();
    await open.close();
    const per = (ms) => Math.round((ms / frames) * 10) / 10;
    const pageMs = t.evaluateMs + t.rasterMs + t.compositeMs + t.downscaleMs + t.transferMs;
    const row = {
      scene,
      size: `${comp.width}x${comp.height}`,
      frames,
      repeated: t.repeated,
      reused: t.reused,
      "ms/frame": per(wallMs),
      evaluate: per(t.evaluateMs),
      raster: per(t.rasterMs),
      composite: per(t.compositeMs),
      downscale: per(t.downscaleMs),
      base64: per(t.transferMs),
      host: per(wallMs - pageMs),
      sha: hash.digest("hex").slice(0, 12),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
} finally {
  await session.close();
}
console.table(rows);
if (process.env.KYNIMO_BENCH_JSON) writeFileSync(process.env.KYNIMO_BENCH_JSON, JSON.stringify(rows, null, 2));
