import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  common,
  composition,
  issues,
  nullLayer,
  type Obj,
  project,
  prop,
  transform,
  visual,
} from "./fixtures.test-util.js";
import { MAX_GROUP_DEPTH, MAX_LAYERS, ProjectSchema } from "./index.js";

describe("ProjectSchema: valid documents", () => {
  it("accepts a minimal project and survives a JSON round trip unchanged", () => {
    const doc = project();
    const parsed = ProjectSchema.parse(doc);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(doc);
  });

  it("accepts every beta layer type with a pinned style, assets and a precomp", () => {
    const doc = project({
      style: { packId: "clean-corporate", version: "1.2.0" },
      assets: [
        {
          id: "logo",
          type: "image",
          name: "Logo",
          uri: "assets/logo.png",
          sha256: "a".repeat(64),
          width: 512,
          height: 512,
        },
        {
          id: "music",
          type: "audio",
          name: "Music",
          uri: "assets/music.mp3",
          sha256: "b".repeat(64),
          durationMs: 30000,
        },
      ],
      compositions: [
        composition("main", [
          {
            ...visual("title", "controller"),
            type: "text",
            content: prop("Hello"),
            box: { mode: "point" },
            font: { family: "inter", weight: 700, size: prop(96) },
            tracking: prop(0),
            leading: prop(1.2),
            align: "center",
            textCase: "none",
            fill: prop("#ffffff"),
          },
          {
            ...visual("badge"),
            type: "shape",
            contents: [
              {
                type: "group",
                id: "g1",
                name: "Group",
                transform: transform(),
                items: [
                  {
                    type: "rect",
                    id: "r1",
                    name: "Rect",
                    position: prop([0, 0]),
                    size: prop([200, 100]),
                    cornerRadius: prop(12),
                  },
                  {
                    type: "fill",
                    id: "f1",
                    name: "Fill",
                    paint: { type: "solid", color: prop("#ff3366") },
                    opacity: prop(1),
                    rule: "nonzero",
                  },
                ],
              },
            ],
          },
          { ...visual("pic"), type: "image", assetId: "logo" },
          { ...visual("bg"), type: "solid", width: 1920, height: 1080, color: "#112233" },
          { ...nullLayer("controller") },
          { ...visual("scene-1"), type: "precomp", compositionId: "intro" },
          { ...visual("grade"), type: "adjustment" },
          {
            ...visual("lower-third"),
            type: "component",
            componentId: "lower-third",
            componentVersion: "1.0.0",
            props: { name: "Ada", nested: { n: [1, 2] } },
          },
          {
            ...common("bed"),
            type: "audio",
            assetId: "music",
            volume: prop(1),
            markers: [{ id: "beat-1", frame: 15, durationFrames: 0, name: "beat" }],
          },
        ]),
        composition("intro", []),
      ],
    });
    expect(issues(doc)).toEqual([]);
  });
});

describe("ProjectSchema: field validation", () => {
  it("rejects a format version other than the current one", () => {
    expect(issues(project({ formatVersion: 0 })).map((i) => i.path)).toContain("formatVersion");
  });

  it("rejects unknown keys so typos surface instead of being dropped", () => {
    expect(issues(project({ nmae: "x" })).map((i) => i.path)).toEqual([""]);
    const typo = { ...nullLayer("a"), transform: { ...transform(), rotaton: prop(0) } };
    expect(
      issues(project({ compositions: [composition("main", [typo])] })).map((i) => i.path),
    ).toEqual(["compositions.0.layers.0.transform"]);
  });

  it("rejects non-finite numbers and fractional frames", () => {
    const comp = composition("main", [{ ...nullLayer("a"), inFrame: 0.5 }]);
    expect(issues(project({ compositions: [comp] })).map((i) => i.path)).toContain(
      "compositions.0.layers.0.inFrame",
    );
    const nan = { ...transform(), rotation: prop(Number.NaN) };
    const comp2 = composition("main", [{ ...nullLayer("a"), transform: nan }]);
    expect(issues(project({ compositions: [comp2] })).map((i) => i.path)).toContain(
      "compositions.0.layers.0.transform.rotation.value",
    );
  });

  it("rejects ids that are not lowercase slugs and non-canonical colors", () => {
    expect(issues(project({ mainCompositionId: "Main Comp" })).map((i) => i.path)).toContain(
      "mainCompositionId",
    );
    const comp = composition("main", []);
    expect(
      issues(project({ compositions: [{ ...comp, background: "#FFF" }] })).map((i) => i.path),
    ).toEqual(["compositions.0.background"]);
  });

  it("rejects out-of-order gradient stops", () => {
    const shape = {
      ...visual("s"),
      type: "shape",
      contents: [
        {
          type: "fill",
          id: "f",
          name: "Fill",
          opacity: prop(1),
          rule: "evenodd",
          paint: {
            type: "linear-gradient",
            start: prop([0, 0]),
            end: prop([1, 0]),
            stops: prop([
              { offset: 0.8, color: "#000000" },
              { offset: 0.2, color: "#ffffff" },
            ]),
          },
        },
      ],
    };
    expect(
      issues(project({ compositions: [composition("main", [shape])] })).map((i) => i.path),
    ).toEqual(["compositions.0.layers.0.contents.0.paint.stops.value"]);
  });
  it("accepts NTSC frame rates exactly and rejects absurd ones", () => {
    const ntsc = { ...composition("main", []), fps: { num: 30000, den: 1001 } };
    expect(issues(project({ compositions: [ntsc] }))).toEqual([]);
    const fast = { ...composition("main", []), fps: { num: 1000, den: 1 } };
    expect(issues(project({ compositions: [fast] })).map((i) => i.path)).toEqual([
      "compositions.0.fps",
    ]);
  });
  it("rejects asset uris that are URLs, absolute paths or traverse out of the store", () => {
    for (const uri of [
      "https://example.com/a.png",
      "file:///etc/passwd",
      "/etc/passwd",
      "assets/../../x",
      "assets//x",
    ]) {
      const asset = {
        id: "x",
        type: "image",
        name: "X",
        uri,
        sha256: "a".repeat(64),
        width: 1,
        height: 1,
      };
      expect([...new Set(issues(project({ assets: [asset] })).map((i) => i.path))], uri).toEqual([
        "assets.0.uri",
      ]);
    }
  });
  it("keeps asset keys canonical and frame rates and durations sane", () => {
    for (const uri of ["assets/a/./b", "assets/a/.", "assets/x/"]) {
      const asset = {
        id: "x",
        type: "image",
        name: "X",
        uri,
        sha256: "a".repeat(64),
        width: 1,
        height: 1,
      };
      expect(
        issues(project({ assets: [asset] })).map((i) => i.path),
        uri,
      ).toContain("assets.0.uri");
    }
    const slow = { ...composition("main", []), fps: { num: 1, den: 1_000_000 } };
    expect(issues(project({ compositions: [slow] })).map((i) => i.path)).toEqual([
      "compositions.0.fps",
    ]);
    const long = { ...composition("main", []), durationFrames: Number.MAX_SAFE_INTEGER };
    expect(issues(project({ compositions: [long] })).map((i) => i.path)).toEqual([
      "compositions.0.durationFrames",
    ]);
  });

  it("requires a pinned component version", () => {
    const layer = { ...visual("c"), type: "component", componentId: "x", props: {} };
    expect(
      issues(project({ compositions: [composition("main", [layer])] })).map((i) => i.path),
    ).toEqual(["compositions.0.layers.0.componentVersion"]);
  });
  it("accepts deeply nested shape groups", () => {
    let items: Obj[] = [
      { type: "ellipse", id: "leaf", name: "Leaf", position: prop([0, 0]), size: prop([1, 1]) },
    ];
    for (let i = 0; i < 20; i++)
      items = [{ type: "group", id: `g${i}`, name: "G", transform: transform(), items }];
    const shape = { ...visual("s"), type: "shape", contents: items };
    expect(issues(project({ compositions: [composition("main", [shape])] }))).toEqual([]);
  });
});

describe("ProjectSchema: hostile input", () => {
  const nest = (depth: number): Obj[] => {
    let items: Obj[] = [
      { type: "ellipse", id: "leaf", name: "Leaf", position: prop([0, 0]), size: prop([1, 1]) },
    ];
    for (let i = 0; i < depth; i++)
      items = [{ type: "group", id: `g${i}`, name: "G", transform: transform(), items }];
    return items;
  };
  const withContents = (contents: Obj[]) =>
    project({ compositions: [composition("main", [{ ...visual("s"), type: "shape", contents }])] });

  it("accepts shape groups nested to the limit and rejects one level deeper with a pathed issue", () => {
    expect(issues(withContents(nest(MAX_GROUP_DEPTH)))).toEqual([]);
    const found = issues(withContents(nest(MAX_GROUP_DEPTH + 1)));
    expect(found).toEqual([
      {
        path: expect.stringMatching(/^compositions\.0\.layers\.0\.contents\.0/),
        message: `group nesting exceeds ${MAX_GROUP_DEPTH} levels; flatten this group into its parent`,
      },
    ]);
  });

  it("returns one clear issue instead of overflowing the stack on extreme nesting", () => {
    expect(issues(withContents(nest(5000)))).toHaveLength(1);
    const deep = (n: number): unknown => {
      let v: unknown = 1;
      for (let i = 0; i < n; i++) v = { a: v };
      return v;
    };
    const comp = (props: unknown) => {
      const layer = {
        ...visual("c"),
        type: "component",
        componentId: "x",
        componentVersion: "1.0.0",
        props,
      };
      return project({ compositions: [composition("main", [layer])] });
    };
    expect(issues(comp(deep(5000)))).toEqual([
      {
        path: expect.stringContaining("compositions.0.layers.0.props.a"),
        message: expect.stringContaining("exceeds 16 levels"),
      },
    ]);
    expect(issues(comp(deep(15)))).toEqual([]);
  });

  it("keeps error output small for wide, too-deep component props", () => {
    const wide: Obj = {};
    for (let k = 0; k < 2000; k++) wide[`k${k}`] = [[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]];
    const layer = {
      ...visual("c"),
      type: "component",
      componentId: "x",
      componentVersion: "1.0.0",
      props: wide,
    };
    const result = ProjectSchema.safeParse(
      project({ compositions: [composition("main", [layer])] }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues).length).toBeLessThan(2_000);
  });

  it("validates a maximum-size layer chain without reporting false cycles", () => {
    const layers = Array.from({ length: MAX_LAYERS }, (_, i) =>
      nullLayer(`l${i}`, i === MAX_LAYERS - 1 ? null : `l${i + 1}`),
    );
    expect(issues(project({ compositions: [composition("main", layers)] }))).toEqual([]);
  });

  it("rejects more layers than the limit", () => {
    const layers = Array.from({ length: MAX_LAYERS + 1 }, (_, i) => nullLayer(`l${i}`));
    expect(
      issues(project({ compositions: [composition("main", layers)] })).map((i) => i.path),
    ).toEqual(["compositions.0.layers"]);
  });
});

describe("ProjectSchema: integrity", () => {
  it("rejects duplicate layer ids across compositions", () => {
    const doc = project({
      compositions: [composition("main", [nullLayer("a")]), composition("other", [nullLayer("a")])],
    });
    expect(issues(doc)).toEqual([
      {
        path: "compositions.1.layers.0.id",
        message: expect.stringContaining("duplicate layer id 'a'"),
      },
    ]);
  });

  it("rejects duplicate asset and composition ids", () => {
    const asset = {
      id: "x",
      type: "image",
      name: "X",
      uri: "assets/u.bin",
      sha256: "a".repeat(64),
      width: 1,
      height: 1,
    };
    const doc = project({
      assets: [asset, asset],
      compositions: [composition("main", []), composition("main", [])],
    });
    expect(
      issues(doc)
        .map((i) => i.path)
        .sort(),
    ).toEqual(["assets.1.id", "compositions.1.id"]);
  });

  it("rejects a missing main composition and names the valid choices", () => {
    expect(issues(project({ mainCompositionId: "nope" }))).toEqual([
      { path: "mainCompositionId", message: expect.stringContaining("one of: main") },
    ]);
  });

  it("rejects inFrame >= outFrame", () => {
    const comp = composition("main", [{ ...nullLayer("a"), inFrame: 30, outFrame: 30 }]);
    expect(issues(project({ compositions: [comp] })).map((i) => i.path)).toEqual([
      "compositions.0.layers.0.outFrame",
    ]);
  });

  it("rejects a parent that is missing, in another composition, or an audio layer", () => {
    const doc = project({
      assets: [
        {
          id: "m",
          type: "audio",
          name: "M",
          uri: "assets/u.bin",
          sha256: "a".repeat(64),
          durationMs: 1000,
        },
      ],
      compositions: [
        composition("main", [
          nullLayer("a", "ghost"),
          nullLayer("b", "far"),
          nullLayer("c", "snd"),
          { ...common("snd"), type: "audio", assetId: "m", volume: prop(1) },
        ]),
        composition("other", [nullLayer("far")]),
      ],
    });
    expect(issues(doc).map((i) => i.path)).toEqual([
      "compositions.0.layers.0.parent",
      "compositions.0.layers.1.parent",
      "compositions.0.layers.2.parent",
    ]);
  });

  it("reports each parenting cycle once, including self-parenting", () => {
    const doc = project({
      compositions: [
        composition("main", [
          nullLayer("a", "b"),
          nullLayer("b", "c"),
          nullLayer("c", "a"),
          nullLayer("d", "d"),
          nullLayer("e", "a"),
        ]),
      ],
    });
    const found = issues(doc);
    expect(found.map((i) => i.path)).toEqual([
      "compositions.0.layers.0.parent",
      "compositions.0.layers.3.parent",
    ]);
    expect(found[0]?.message).toContain("a -> b -> c -> a");
  });

  it("checks asset references exist and match the layer kind", () => {
    const doc = project({
      assets: [
        {
          id: "m",
          type: "audio",
          name: "M",
          uri: "assets/u.bin",
          sha256: "a".repeat(64),
          durationMs: 1000,
        },
      ],
      compositions: [
        composition("main", [
          { ...visual("p1"), type: "image", assetId: "m" },
          { ...visual("p2"), type: "image", assetId: "missing" },
        ]),
      ],
    });
    expect(issues(doc).map((i) => i.path)).toEqual([
      "compositions.0.layers.0.assetId",
      "compositions.0.layers.1.assetId",
    ]);
  });

  it("checks precomp targets exist", () => {
    const doc = project({
      compositions: [
        composition("main", [{ ...visual("p"), type: "precomp", compositionId: "gone" }]),
      ],
    });
    expect(issues(doc).map((i) => i.path)).toEqual(["compositions.0.layers.0.compositionId"]);
  });

  it("rejects duplicate marker ids across layers and compositions", () => {
    const marker = { id: "m1", frame: 0, durationFrames: 0, name: "" };
    const doc = project({
      compositions: [
        { ...composition("main", [{ ...nullLayer("a"), markers: [marker] }]), markers: [marker] },
      ],
    });
    expect(issues(doc).map((i) => i.path)).toEqual(["compositions.0.layers.0.markers.0.id"]);
  });

  it("reports a cycle once and not for chains that merely feed into it", () => {
    const doc = project({
      compositions: [
        composition("main", [nullLayer("x", "a"), nullLayer("a", "b"), nullLayer("b", "a")]),
      ],
    });
    const found = issues(doc);
    expect(found.map((i) => i.path)).toEqual(["compositions.0.layers.1.parent"]);
    expect(found[0]?.message).toContain("a -> b -> a");
  });

  it("rejects duplicate shape item ids within a layer, including inside groups", () => {
    const leaf = {
      type: "ellipse",
      id: "same",
      name: "E",
      position: prop([0, 0]),
      size: prop([1, 1]),
    };
    const shape = {
      ...visual("s"),
      type: "shape",
      contents: [
        leaf,
        { type: "group", id: "g", name: "G", transform: transform(), items: [leaf] },
      ],
    };
    expect(issues(project({ compositions: [composition("main", [shape])] }))).toEqual([
      {
        path: "compositions.0.layers.0.contents.1.items.0.id",
        message: expect.stringContaining("duplicate shape item id 'same'"),
      },
    ]);
  });
});

describe("JSON Schema export", () => {
  it("produces a JSON Schema for MCP resources without throwing", () => {
    const schema = z.toJSONSchema(ProjectSchema, { io: "output" }) as Obj;
    expect(schema.type).toBe("object");
    expect(JSON.stringify(schema)).toContain("formatVersion");
    const compact = z.toJSONSchema(ProjectSchema, { io: "output", reused: "ref" });
    // The MCP resource uses the deduplicated form; keep it small so new properties cannot bloat it unnoticed.
    expect(JSON.stringify(compact).length).toBeLessThan(60_000);
  });
});
