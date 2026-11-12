import { writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { base64, clickPcm } from "./assets.test-util.js";
import { MemoryBlobStore } from "./blobs.js";
import type { MediaTools } from "./media.js";
import { KynimoService } from "./service.js";
import { MemoryStore } from "./store.js";

/** A media fake with one audio stream and a chosen decoded signal; no FFmpeg. */
class AudioMedia implements MediaTools {
  pcm: Float32Array = new Float32Array(0);
  pcmCalls: number[] = [];
  decodeError: Error | null = null;
  async version() {
    return "ffmpeg 6.1.1";
  }
  async probe() {
    return { hasAudio: true, durationMs: 10_000 };
  }
  async decodeFrames(): Promise<number> {
    throw new Error("not used");
  }
  async extractAudio(_file: string, out: string) {
    await writeFile(out, new Uint8Array([1, 2, 3]));
    return { durationMs: 10_000 };
  }
  async decodePcm(_flac: Uint8Array, maxSamples: number) {
    this.pcmCalls.push(maxSamples);
    if (this.decodeError !== null) throw this.decodeError;
    return this.pcm;
  }
  encode(): never {
    throw new Error("not used");
  }
}

describe("beat detection at upload", () => {
  let media: AudioMedia;
  let service: KynimoService;
  let project_id: string;
  const meta = (base_version: number, idempotency_key: string) => ({
    project_id,
    base_version,
    idempotency_key,
  });
  const upload = (key: string, version: number) =>
    service.uploadAsset(meta(version, key), {
      name: "song.wav",
      data: base64(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt ")),
    });

  beforeEach(async () => {
    media = new AudioMedia();
    service = new KynimoService(new MemoryStore(), "agent", {
      blobs: new MemoryBlobStore(),
      media,
    });
    ({ id: project_id } = await service.createProject({
      name: "P",
      idempotency_key: "c",
      width: 320,
      height: 180,
      fps: { num: 30, den: 1 },
      duration_frames: 60,
      background: null,
    }));
  });

  it("stores the detected beats on the audio asset and summarises them in list_assets", async () => {
    media.pcm = clickPcm(120, 10);
    const r = await upload("u", 1);
    const beats = (r.asset as { beats?: { bpm: number; confidence: number; timesMs: number[] } })
      .beats;
    expect(Math.abs((beats?.bpm ?? 0) - 120)).toBeLessThanOrEqual(1);
    expect(beats?.timesMs.length).toBeGreaterThanOrEqual(18);
    // 10 s of audio plus 1 s of slack, in frames per channel.
    expect(media.pcmCalls).toEqual([10_000 * 48 + 48_000]);
    const { assets } = await service.listAssets(project_id);
    expect(assets[0]).toMatchObject({
      type: "audio",
      duration_ms: 10_000,
      bpm: beats?.bpm,
      beat_count: beats?.timesMs.length,
    });
    expect(assets[0]).not.toHaveProperty("timesMs");
    expect(JSON.stringify(assets)).not.toContain("timesMs");
  });

  it("leaves beats out when there is no steady beat", async () => {
    media.pcm = new Float32Array(48_000 * 2 * 5);
    const r = await upload("u", 1);
    expect(r.asset).not.toHaveProperty("beats");
    const { assets } = await service.listAssets(project_id);
    expect(assets[0]).not.toHaveProperty("bpm");
    expect(assets[0]).not.toHaveProperty("beat_count");
  });

  it("does not fail the upload when decoding throws", async () => {
    media.decodeError = new Error("decoder crashed");
    const r = await upload("u", 1);
    expect(r).toMatchObject({ version: 2, asset: { type: "audio" } });
    expect(r.asset).not.toHaveProperty("beats");
  });
});
