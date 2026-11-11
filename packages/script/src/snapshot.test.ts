import { keynote } from "@kynimo/guidelines";
import { ProjectSchema } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { baseDoc, prop, solid } from "./fixtures.test-util.js";
import { scriptSnapshot } from "./snapshot.js";

describe("scriptSnapshot", () => {
  it("describes compositions, layers, assets and the resolved pack", () => {
    const snap = scriptSnapshot(baseDoc());
    expect(snap.mainCompositionId).toBe("main");
    expect(snap.layerIds).toEqual(["title", "bg", "o"]);
    expect(snap.assets).toEqual([]);
    expect(snap.compositions.map((c) => [c.id, c.width, c.height, c.durationFrames])).toEqual([
      ["main", 1920, 1080, 300],
      ["other", 800, 600, 48],
    ]);
    expect(snap.compositions[0]?.scale).toBe(1);
    expect(snap.compositions[1]?.scale).toBeCloseTo(600 / 1080);
    expect(snap.compositions[0]?.fps).toEqual({ num: 30, den: 1 });

    const [title, bg] = snap.compositions[0]?.layers ?? [];
    expect(title).toMatchObject({
      id: "title",
      name: "Title",
      type: "text",
      index: 0,
      composition: "main",
      parent: null,
      inFrame: 0,
      outFrame: 90,
      startFrame: 0,
      animated: ["opacity"],
      text: "Hi",
    });
    // Constant tracks give their value, keyframed ones null.
    expect(title?.transform).toEqual({
      anchorPoint: [0, 0],
      position: [960, 540],
      scale: [1, 1],
      rotation: 0,
      skew: 0,
      opacity: null,
    });
    expect(bg).toMatchObject({ id: "bg", index: 1, type: "solid", animated: [] });
    expect(bg?.transform.position).toEqual([100, 200]);
    expect(bg).not.toHaveProperty("text");

    expect(snap.tokens.pack).toEqual({ id: keynote.id, version: keynote.version, pinned: false });
    expect(snap.tokens.colors).toEqual(keynote.color);
    expect(snap.tokens.motion).toEqual(keynote.motion);
  });

  it("is plain JSON and pure", () => {
    const doc = baseDoc();
    const a = scriptSnapshot(doc);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(scriptSnapshot(doc)).toEqual(a);
  });

  it("handles separate position tracks, parents and assets without bytes", () => {
    const sha = "a".repeat(64);
    const doc = ProjectSchema.parse({
      ...baseDoc(),
      assets: [
        {
          id: "logo",
          type: "image",
          name: "Logo",
          uri: `assets/${sha}.png`,
          sha256: sha,
          width: 4,
          height: 4,
        },
      ],
      compositions: [
        {
          ...baseDoc().compositions[0],
          layers: [
            solid("p", {
              transform: { position: { separate: { x: prop(5), y: prop(6) } } },
            }),
            solid("q", {
              parent: "p",
              transform: {
                position: {
                  separate: {
                    x: {
                      keyframes: [
                        { frame: 0, value: 0, interpolation: { type: "linear" } },
                        { frame: 9, value: 1, interpolation: { type: "linear" } },
                      ],
                    },
                    y: prop(6),
                  },
                },
              },
            }),
          ],
        },
      ],
    });
    const snap = scriptSnapshot(doc);
    expect(snap.assets).toEqual([{ id: "logo", type: "image", name: "Logo" }]);
    const [p, q] = snap.compositions[0]?.layers ?? [];
    expect(p?.transform.position).toEqual([5, 6]);
    expect(q).toMatchObject({ parent: "p", animated: ["position"] });
    expect(q?.transform.position).toBeNull();
  });
});
