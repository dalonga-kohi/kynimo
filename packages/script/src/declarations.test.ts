import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_OP_TYPES_CHARS,
  opNames,
  sdkDeclarationSizes,
  sdkDeclarations,
} from "./declarations.js";
import { expandScript } from "./expand.js";
import { baseDoc } from "./fixtures.test-util.js";

// The workspace TypeScript 7 is a native binary behind a node launcher: run it with node.
const TSC = join(import.meta.dirname, "../../../node_modules/typescript/bin/tsc");

const VALID = `
const comp = kynimo.composition();
const title = comp.add("text", {
  name: "Headline", inFrame: 0, outFrame: 90, startFrame: 0, hidden: false, solo: false,
  editor: { locked: false, shy: false, label: null }, markers: [], parent: null,
  transform: {
    anchorPoint: { value: [0, 0] }, position: { value: [960, 300] }, scale: { value: [1, 1] },
    rotation: { value: 0 }, skew: { value: 0 }, opacity: { value: 1 },
  },
  blendMode: "normal", matte: null, masks: [],
  content: { value: "Hello" }, box: { mode: "point" },
  font: { family: "Inter", weight: 700, size: { value: kynimo.tokens.type.display.size } },
  tracking: { value: 0 }, leading: { value: 1.2 }, align: "left", textCase: "none",
  fill: { value: kynimo.tokens.colors.text },
});
title.set("position", [960, 300]);
title.keyframes("scale", [
  { frame: 0, value: [0.9, 0.9], interpolation: { type: "linear" } },
  { frame: comp.frames(600), value: [1, 1], interpolation: { type: "hold" } },
]);
title.animate({ property: "opacity", from: 0, to: 1, duration: "base", easing: "enter" });
title.preset("fade-in");
const back = kynimo.layer({ name: "Back*", composition: "main" });
back.behavior({
  property: "position", type: "wiggle", frequency: { value: 2 }, amplitude: { value: [20, 0] },
  octaves: 2, seed: 7, linked: false,
});
back.update({ name: "Back" });
kynimo.preset({ layers: [title, back], preset: "fade-in", stagger: { offset: "tight" } });
kynimo.animate({ layers: comp.layers, property: "opacity", to: 1, duration: 300 });
kynimo.op({ op: "removeMarker", marker: "none" });
const gap: number = kynimo.tokens.layout.spacing.m * comp.scale + kynimo.random();
`;

const VALID_2 = `
const comp = kynimo.composition();
const all = comp.layers;
if (all.length > 5) kynimo.stagger({ layers: all, offset: 100, order: "reverse" });
kynimo.retime({ layers: comp.find({ type: "text" }), scale: 2, window: { from: 0, to: 30 } });
for (const layer of comp.layers) layer.parent(null);
const first: string = comp.layers[0]?.id ?? "";
`;

const BAD = `
const comp = kynimo.composition();
const title = comp.add("text", { name: "Headline" });
title.set("opacty", 1);
kynimo.animate({ layers: title, property: "nope" });
const frames: number = comp.frames("12");
`;

const run = (dir: string, name: string, source: string) => {
  writeFileSync(join(dir, `${name}.ts`), source);
  return spawnSync(
    process.execPath,
    [
      TSC,
      "--noEmit",
      "--strict",
      "--target",
      "es2023",
      "--lib",
      "es2023",
      "--types",
      "",
      join(dir, "kynimo.d.ts"),
      join(dir, `${name}.ts`),
    ],
    { encoding: "utf8", cwd: dir },
  );
};

describe("sdkDeclarations", () => {
  it("is memoized and mentions every op literal and the SDK surface", () => {
    const text = sdkDeclarations();
    expect(sdkDeclarations()).toBe(text);
    for (const name of opNames()) expect(text).toContain(`"${name}"`);
    expect(text).toContain("declare const kynimo: Kynimo;");
    for (const member of [
      "random()",
      "composition(",
      "layer(",
      "op(",
      "animate(",
      "preset(",
      "stagger(",
      "retime(",
      "behavior(",
      "frames(",
    ]) {
      expect(text).toContain(member);
    }
  });

  it("stays under the size budget with the ops written in full", () => {
    const sizes = sdkDeclarationSizes();
    expect(sizes.used).toBe("full");
    expect(sizes.full).toBeLessThanOrEqual(MAX_OP_TYPES_CHARS);
    expect(sdkDeclarations().length).toBe(sizes.full);
    expect(sizes.loose).toBeLessThan(sizes.full);
  });

  it("type-checks valid example scripts and rejects a wrong one", () => {
    const dir = mkdtempSync(join(tmpdir(), "kynimo-sdk-"));
    try {
      writeFileSync(join(dir, "kynimo.d.ts"), sdkDeclarations());
      for (const [name, source] of [
        ["valid", VALID],
        ["valid2", VALID_2],
      ] as const) {
        const ok = run(dir, name, source);
        expect(`${ok.stdout}${ok.stderr}`).toBe("");
        expect(ok.status).toBe(0);
      }
      const bad = run(dir, "bad", BAD);
      expect(bad.status).not.toBe(0);
      const out = bad.stdout + bad.stderr;
      expect(out).toMatch(/bad\.ts\(3,/); // missing layer fields
      expect(out).toMatch(/bad\.ts\(4,\d+\).*opacty/);
      expect(out).toMatch(/bad\.ts\(5,/);
      expect(out).toMatch(/bad\.ts\(6,\d+\).*string/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the valid examples also run and expand against a document", async () => {
    const doc = baseDoc();
    // VALID removes a marker that does not exist, so drop that line for the run.
    const source = VALID.replace(/kynimo\.op\(\{ op: "removeMarker".*\n/, "");
    const r = await expandScript(doc, { source }, { idCounter: 0 });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.layersCreated).toEqual(["layer-1"]);
    const r2 = await expandScript(doc, { source: VALID_2 }, { idCounter: 0 });
    expect(r2.ok).toBe(true);
  });
});
