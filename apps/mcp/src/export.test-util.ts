import { readFileSync, writeFileSync } from "node:fs";
import {
  type CapturedFrame,
  type CapturedSheet,
  type ExportFrame,
  type ExportSession,
  fitSize,
} from "@kynimo/capture";
import type { Project } from "@kynimo/scene";
import type { EncodeOptions, Encoder, MediaTools } from "./media.js";
import type { FrameRenderer } from "./render.js";

export interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}
export const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
export class FakeSession implements ExportSession {
  readonly width: number;
  readonly height: number;
  closed = false;
  calls: { frame: number; videoKeys: string[] }[] = [];
  private previous: Uint8Array | undefined;
  constructor(
    private readonly owner: FakeRenderer,
    size: { width: number; height: number },
  ) {
    this.width = size.width;
    this.height = size.height;
  }
  async frame(n: number, videoFrames: ReadonlyMap<string, Uint8Array> = new Map()) {
    this.calls.push({ frame: n, videoKeys: [...videoFrames.keys()] });
    if (this.owner.gateAt === n) {
      this.owner.reached.push(n);
      await this.owner.gate.promise;
    }
    if (this.owner.failAt === n) throw new Error("the page crashed");
    const repeated = this.owner.repeat.has(n) && this.previous !== undefined;
    const rgba =
      repeated && this.previous
        ? this.previous
        : new Uint8Array(this.width * this.height * 4).fill(n & 255);
    this.previous = rgba;
    const out: ExportFrame = {
      frame: n,
      width: this.width + this.owner.sizeError,
      height: this.height,
      rgba,
      repeated,
      skipped: this.owner.skipOn(n)
        ? [{ id: "fx", type: "adjustment", reason: "not drawn yet" }]
        : [],
      warnings: [],
    };
    return out;
  }
  async close() {
    this.closed = true;
  }
}

export class FakeRenderer implements FrameRenderer {
  buildId = "build-1";
  opens: { composition: string; maxSize: number; assets: string[]; alpha: string }[] = [];
  sessions: FakeSession[] = [];
  sheets: { frames: number[]; maxSize: number; columns: number }[] = [];
  gate = deferred();
  gateAt: number | null = null;
  reached: number[] = [];
  failAt: number | null = null;
  sizeError = 0;
  repeat = new Set<number>();
  skipOn: (n: number) => boolean = () => false;

  async build() {
    return this.buildId;
  }
  async frames(): Promise<CapturedFrame[]> {
    throw new Error("not used");
  }
  async sheet(
    _doc: Project,
    _composition: string,
    frames: readonly number[],
    layout: { maxSize: number; columns: number; gap: number },
  ): Promise<CapturedSheet> {
    this.sheets.push({ frames: [...frames], maxSize: layout.maxSize, columns: layout.columns });
    return {
      width: 10,
      height: 10,
      png: new TextEncoder().encode("sheet-png"),
      pixelsSha256: "p",
      pngSha256: "q",
      cellWidth: 5,
      cellHeight: 5,
      columns: 3,
      frames: frames.map((frame) => ({ frame, skipped: [], warnings: [] })),
    };
  }
  async openExport(
    doc: Project,
    composition: string,
    maxSize: number,
    assets: ReadonlyMap<string, Uint8Array>,
    alpha: "premultiplied" | "straight",
  ) {
    this.opens.push({ composition, maxSize, assets: [...assets.keys()], alpha });
    const comp = doc.compositions.find((c) => c.id === composition);
    const session = new FakeSession(this, fitSize(comp?.width ?? 1, comp?.height ?? 1, maxSize));
    this.sessions.push(session);
    return session;
  }
  async close() {}
}

export interface EncodeRecord {
  opts: EncodeOptions;
  audio: Buffer | null;
  written: Uint8Array[];
  finished: boolean;
  aborted: boolean;
}

export class FakeMedia implements MediaTools {
  encodes: EncodeRecord[] = [];
  pcmCalls: number[] = [];
  /** One second of stereo at 0.5. */
  pcm = new Float32Array(96_000).fill(0.5);
  failWrite: Error | null = null;
  async version() {
    return "ffmpeg 6.1.1";
  }
  async probe(): Promise<never> {
    throw new Error("not used");
  }
  async decodeFrames(): Promise<number> {
    throw new Error("not used");
  }
  async extractAudio(): Promise<never> {
    throw new Error("not used");
  }
  async decodePcm(_flac: Uint8Array, maxSamples: number) {
    this.pcmCalls.push(maxSamples);
    return this.pcm;
  }
  encode(opts: EncodeOptions): Encoder {
    const record: EncodeRecord = {
      opts,
      audio: opts.audio === null ? null : readFileSync(opts.audio),
      written: [],
      finished: false,
      aborted: false,
    };
    opts.signal.addEventListener("abort", () => {
      record.aborted = true;
    });
    this.encodes.push(record);
    return {
      write: async (frame) => {
        if (this.failWrite) throw this.failWrite;
        record.written.push(frame);
      },
      finish: async () => {
        writeFileSync(opts.out, "fake-video");
        record.finished = true;
      },
    };
  }
}
