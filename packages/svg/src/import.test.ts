import type { ShapeItem } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { entry, flatten, ICON, INKSCAPE, importValid, LOGO, svg } from "./fixtures.test-util.js";
import { importSvg, SVG_LIMITS, SvgImportError, type SvgImportResult } from "./index.js";
import { utf8Length as utf8Bytes } from "./xml.js";

// Timing is measured in the test only; the importer itself never reads a clock.
const clock = (globalThis as unknown as { performance: { now(): number } }).performance;

type Group = Extract<ShapeItem, { type: "group" }>;
const asGroup = (i: ShapeItem | undefined): Group => {
  expect(i?.type).toBe("group");
  return i as Group;
};
const types = (items: ShapeItem[]) => items.map((i) => i.type);
const val = <T>(a: unknown): T => (a as { value: T }).value;

describe("document order and structure", () => {
  it("lists later SVG children first and puts stroke before fill", () => {
    const r = importValid(
      svg(
        `<rect id="a" width="10" height="10" fill="red" stroke="blue"/><circle id="b" r="5" fill="green"/>`,
      ),
    );
    expect(r.contents.map((i) => i.name)).toEqual(["b", "a"]);
    const a = asGroup(r.contents[1]);
    expect(types(a.items)).toEqual(["rect", "stroke", "fill"]);
  });

  it("reverses inside groups too", () => {
    const r = importValid(
      svg(
        `<g id="g"><rect id="one" width="1" height="1"/><rect id="two" width="1" height="1"/></g>`,
      ),
    );
    const g = asGroup(r.contents[0]);
    expect(g.name).toBe("g");
    expect(g.items.map((i) => i.name)).toEqual(["two", "one"]);
  });

  it("omits the paint items that are none and skips elements with no paint", () => {
    const r = importValid(
      svg(
        `<rect width="1" height="1" fill="none"/><rect id="s" width="1" height="1" fill="none" stroke="red"/>`,
      ),
    );
    expect(r.contents).toHaveLength(1);
    expect(types(asGroup(r.contents[0]).items)).toEqual(["rect", "stroke"]);
    expect(r.report.entries).toEqual([]);
  });

  it("treats a and switch as groups, and switch renders only its first child", () => {
    const r = importValid(
      svg(
        `<a><rect width="1" height="1"/></a><switch><circle r="1"/><rect width="9" height="9"/></switch>`,
      ),
    );
    const flat = flatten(r.contents);
    expect(flat.filter((i) => i.type === "rect")).toHaveLength(1);
    expect(flat.filter((i) => i.type === "ellipse")).toHaveLength(1);
  });

  it("skips empty groups", () => {
    const r = importValid(svg(`<g><g/></g><rect width="1" height="1"/>`));
    expect(r.contents).toHaveLength(1);
  });
});

describe("ids and names", () => {
  it("uses slugified svg ids when valid and unused, else counters", () => {
    const r = importValid(
      svg(
        `<rect id="My Shape!" width="1" height="1"/><rect id="my-shape-" width="1" height="1"/><rect id="x" width="1" height="1"/><rect id="x" width="1" height="1"/><rect width="1" height="1"/>`,
      ),
    );
    const groups = r.contents.map((i) => i.id);
    expect(groups).toContain("my-shape-");
    expect(groups.filter((i) => i === "x")).toHaveLength(1);
    expect(r.contents.map((i) => i.name)).toContain("My Shape!");
  });

  it("generates deterministic type counters and avoids collisions with svg ids", () => {
    const r = importValid(
      svg(`<rect id="rect-1" width="1" height="1"/><rect width="1" height="1"/>`),
    );
    const rects = flatten(r.contents).filter((i) => i.type === "rect");
    expect(new Set(rects.map((i) => i.id)).size).toBe(2);
  });

  it("names groups, fills and strokes", () => {
    const r = importValid(svg(`<g><path id="p" d="M0 0L5 5" stroke="red"/></g>`));
    const g = asGroup(r.contents[0]);
    expect(g.name).toBe("Group");
    const p = asGroup(g.items[0]);
    expect(p.name).toBe("p");
    expect(p.items.map((i) => i.name)).toEqual(["path", "Stroke", "Fill"]);
  });

  it("copes with hostile ids", () => {
    const r = importValid(
      svg(
        `<rect id="__proto__" width="1" height="1"/><rect id="${"a".repeat(300)}" width="1" height="1"/>`,
      ),
    );
    expect(r.contents).toHaveLength(2);
  });
});

describe("shapes", () => {
  it("maps rect to a rect item with the centre as position", () => {
    const r = importValid(svg(`<rect x="10" y="20" width="30" height="40" rx="5"/>`));
    const rect = asGroup(r.contents[0]).items[0];
    expect(rect).toMatchObject({
      type: "rect",
      position: { value: [25, 40] },
      size: { value: [30, 40] },
      cornerRadius: { value: 5 },
    });
  });

  it("copies a missing rx/ry and clamps to half the side", () => {
    const r = importValid(
      svg(`<rect width="20" height="10" ry="3"/><rect width="20" height="20" rx="99"/>`),
    );
    const [b, a] = r.contents.map((i) => asGroup(i).items[0]);
    expect(a).toMatchObject({ type: "rect", cornerRadius: { value: 3 } });
    expect(b).toMatchObject({ type: "rect", cornerRadius: { value: 10 } });
  });

  it("builds a path for elliptical corners", () => {
    const r = importValid(svg(`<rect width="40" height="20" rx="8" ry="4"/>`));
    const p = asGroup(r.contents[0]).items[0];
    expect(p?.type).toBe("path");
    if (p?.type === "path" && "value" in p.path) expect(p.path.value.vertices).toHaveLength(8);
  });

  it("maps circle and ellipse to ellipse items", () => {
    const r = importValid(
      svg(`<circle cx="10" cy="20" r="5"/><ellipse cx="1" cy="2" rx="3" ry="4"/>`),
    );
    const [e, c] = r.contents.map((i) => asGroup(i).items[0]);
    expect(c).toMatchObject({
      type: "ellipse",
      position: { value: [10, 20] },
      size: { value: [10, 10] },
    });
    expect(e).toMatchObject({
      type: "ellipse",
      position: { value: [1, 2] },
      size: { value: [6, 8] },
    });
  });

  it("maps line, polyline and polygon to paths; polyline and line get no fill", () => {
    const r = importValid(
      svg(
        `<line x1="0" y1="0" x2="5" y2="5" stroke="red"/><polyline points="0,0 5,5 9,0" stroke="red"/><polygon points="0 0 5 5 9 0" fill="blue"/>`,
      ),
    );
    const [poly, polyline, line] = r.contents.map((i) => asGroup(i));
    expect(types(line?.items ?? [])).toEqual(["path", "stroke"]);
    expect(types(polyline?.items ?? [])).toEqual(["path", "stroke"]);
    expect(types(poly?.items ?? [])).toEqual(["path", "fill"]);
    const p = poly?.items[0];
    if (p?.type === "path" && "value" in p.path) expect(p.path.value.closed).toBe(true);
  });

  it("makes one path item per subpath under a single fill", () => {
    const r = importValid(svg(`<path d="M0 0 L9 0 L9 9 Z M2 2 L5 2 L5 5 Z" fill-rule="evenodd"/>`));
    const g = asGroup(r.contents[0]);
    expect(types(g.items)).toEqual(["path", "path", "fill"]);
    expect(g.items[2]).toMatchObject({ rule: "evenodd" });
  });

  it("drops degenerate subpaths silently and zero-size shapes", () => {
    const r = importValid(
      svg(`<path d="M5 5 M0 0 L9 9"/><rect width="0" height="5"/><circle r="0"/><path d="M1 1"/>`),
    );
    expect(r.contents).toHaveLength(1);
    expect(r.report.entries).toEqual([]);
  });

  it("reports path data errors but keeps the good part", () => {
    const r = importValid(svg(`<path id="bad" d="M0 0 L10 10 L20 oops"/>`));
    const e = entry(r, "path-data-error");
    expect(e).toMatchObject({ kind: "approximated", count: 1, elements: ["path#bad"] });
    expect(flatten(r.contents).filter((i) => i.type === "path")).toHaveLength(1);
  });

  it("reports an odd polygon points list", () => {
    const r = importValid(svg(`<polygon points="0 0 5 5 9" />`));
    expect(entry(r, "path-data-error")).toBeDefined();
  });
});

describe("transforms", () => {
  it("puts an element transform on its group item", () => {
    const r = importValid(
      svg(`<rect width="1" height="1" transform="translate(10 20) rotate(90) scale(2)"/>`),
    );
    const t = asGroup(r.contents[0]).transform;
    expect(val(t.position)).toEqual([10, 20]);
    expect(val(t.rotation)).toBe(90);
    expect(val(t.scale)).toEqual([2, 2]);
    expect(val(t.anchorPoint)).toEqual([0, 0]);
  });

  it("keeps group transforms on groups and does not touch geometry", () => {
    const r = importValid(svg(`<g transform="translate(5 6)"><rect width="10" height="10"/></g>`));
    const g = asGroup(r.contents[0]);
    expect(val(g.transform.position)).toEqual([5, 6]);
    expect(asGroup(g.items[0]).items[0]).toMatchObject({ position: { value: [5, 5] } });
    expect(entry(r, "baked-transform")).toBeUndefined();
  });

  it("bakes a skew beyond 85 degrees into the geometry and reports it", () => {
    const r = importValid(
      svg(`<rect id="s" width="10" height="10" transform="skewX(89)" fill="red"/>`),
    );
    const g = asGroup(r.contents[0]);
    expect(val(g.transform.skew)).toBe(0);
    expect(val(g.transform.scale)).toEqual([1, 1]);
    const p = g.items[0];
    expect(p?.type).toBe("path");
    if (p?.type === "path" && "value" in p.path) {
      const top = p.path.value.vertices
        .filter((v) => v.point[1] === 10)
        .sort((a, b) => a.point[0] - b.point[0])[0];
      expect(top?.point[0]).toBeCloseTo(10 * Math.tan((89 * Math.PI) / 180), -1);
    }
    expect(entry(r, "baked-transform")).toMatchObject({ kind: "flattened", elements: ["rect#s"] });
  });

  it("bakes singular matrices", () => {
    const r = importValid(svg(`<rect width="10" height="10" transform="scale(1 0)" fill="red"/>`));
    expect(entry(r, "baked-transform")).toBeDefined();
  });

  it("bakes a group's transform into descendants and keeps their own transforms", () => {
    const r = importValid(
      svg(
        `<g transform="matrix(1 0 0 0 0 0)"><rect width="10" height="10" transform="translate(5 5)"/></g>`,
      ),
    );
    expect(entry(r, "baked-transform")).toBeDefined();
    const g = asGroup(r.contents[0]);
    expect(val(g.transform.position)).toEqual([0, 0]);
  });

  it("scales stroke width when baking a non-uniform matrix and reports it", () => {
    const r = importValid(
      svg(
        `<path d="M0 0 L10 0" stroke="red" stroke-width="2" transform="matrix(2 0 0 0.5 0 0) skewX(89)"/>`,
      ),
    );
    const stroke = flatten(r.contents).find((i) => i.type === "stroke");
    expect(stroke?.type === "stroke" && val(stroke.width)).toBeCloseTo(2 * Math.sqrt(1), 5);
    expect(entry(r, "non-uniform-stroke")).toMatchObject({ kind: "approximated" });
  });

  it("reports an unparseable transform and ignores it", () => {
    const r = importValid(svg(`<rect width="1" height="1" transform="wobble(3)"/>`));
    expect(entry(r, "transform-error")).toMatchObject({ kind: "dropped" });
    expect(val(asGroup(r.contents[0]).transform.position)).toEqual([0, 0]);
  });

  it("dissolves groups nested deeper than the group depth limit", () => {
    const depth = 40;
    const r = importValid(
      svg(
        `${"<g transform='translate(1 0)'>".repeat(depth)}<rect width="1" height="1"/>${"</g>".repeat(depth)}`,
      ),
    );
    expect(entry(r, "group-depth")).toMatchObject({ kind: "flattened" });
    let d = 0;
    let cur: ShapeItem | undefined = r.contents[0];
    while (cur?.type === "group") {
      d++;
      cur = cur.items[0];
    }
    expect(d).toBeLessThanOrEqual(32);
    // the translations are not lost: the rect still ends up at x = 40 + 0.5
    const flat = flatten(r.contents);
    const total = flat
      .filter((i): i is Group => i.type === "group")
      .reduce((s, g) => s + (val<number[]>(g.transform.position)[0] ?? 0), 0);
    expect(total).toBe(depth);
  });

  it("chunks more than 500 siblings into plain groups, preserving order", () => {
    const body = Array.from(
      { length: 1200 },
      (_, i) => `<rect id="r${i}" width="1" height="1"/>`,
    ).join("");
    const r = importValid(svg(body));
    expect(r.contents.length).toBeLessThanOrEqual(500);
    expect(r.contents).toHaveLength(3);
    const rects = flatten(r.contents).filter(
      (i): i is Group => i.type === "group" && i.name.startsWith("r"),
    );
    expect(rects.map((g) => g.name)).toEqual(
      Array.from({ length: 1200 }, (_, i) => `r${1199 - i}`),
    );
    expect(entry(r, "group-depth")).toBeUndefined();
  });
});

describe("style cascade", () => {
  it("applies presentation attributes, then style, with inheritance", () => {
    const r = importValid(
      svg(
        `<g fill="red" stroke="blue" stroke-width="3" style="fill:green"><rect width="1" height="1" fill="yellow" style="stroke-width:5;fill:#00f"/><rect width="1" height="1"/></g>`,
      ),
    );
    const [plain, styled] = asGroup(r.contents[0]).items.map((i) => asGroup(i).items);
    expect(styled?.find((i) => i.type === "fill")).toMatchObject({
      paint: { color: { value: "#0000ff" } },
    });
    expect(styled?.find((i) => i.type === "stroke")).toMatchObject({ width: { value: 5 } });
    expect(plain?.find((i) => i.type === "fill")).toMatchObject({
      paint: { color: { value: "#008000" } },
    });
    expect(plain?.find((i) => i.type === "stroke")).toMatchObject({ width: { value: 3 } });
  });

  it("does not inherit opacity or display", () => {
    const r = importValid(svg(`<g opacity="0.5"><rect width="1" height="1"/></g>`));
    const g = asGroup(r.contents[0]);
    expect(val(g.transform.opacity)).toBe(0.5);
    expect(val(asGroup(g.items[0]).transform.opacity)).toBe(1);
  });

  it("supports the inherit keyword", () => {
    const r = importValid(
      svg(`<g fill="red"><g fill="blue"><rect width="1" height="1" fill="inherit"/></g></g>`),
    );
    const fill = flatten(r.contents).find((i) => i.type === "fill");
    expect(fill).toMatchObject({ paint: { color: { value: "#0000ff" } } });
  });

  it("uses defaults: black fill, no stroke, nonzero", () => {
    const r = importValid(svg(`<rect width="1" height="1"/>`));
    const items = asGroup(r.contents[0]).items;
    expect(types(items)).toEqual(["rect", "fill"]);
    expect(items[1]).toMatchObject({
      paint: { type: "solid", color: { value: "#000000" } },
      opacity: { value: 1 },
      rule: "nonzero",
    });
  });

  it("maps fill and stroke opacity and color alpha separately", () => {
    const r = importValid(
      svg(
        `<rect width="1" height="1" fill="#ff000080" fill-opacity="0.5" stroke="blue" stroke-opacity="25%"/>`,
      ),
    );
    const items = asGroup(r.contents[0]).items;
    expect(items.find((i) => i.type === "fill")).toMatchObject({
      paint: { color: { value: "#ff000080" } },
      opacity: { value: 0.5 },
    });
    expect(items.find((i) => i.type === "stroke")).toMatchObject({ opacity: { value: 0.25 } });
  });

  it("resolves currentColor from the inherited color", () => {
    const r = importValid(
      svg(`<g color="#336699"><rect width="1" height="1" fill="currentColor"/></g>`),
    );
    expect(flatten(r.contents).find((i) => i.type === "fill")).toMatchObject({
      paint: { color: { value: "#336699" } },
    });
    const d = importValid(svg(`<rect width="1" height="1" fill="currentColor"/>`));
    expect(flatten(d.contents).find((i) => i.type === "fill")).toMatchObject({
      paint: { color: { value: "#000000" } },
    });
  });

  it("treats an invalid color as none and reports it with the value", () => {
    const r = importValid(svg(`<rect id="x" width="1" height="1" fill="notacolor" stroke="red"/>`));
    const e = entry(r, "invalid-color");
    expect(e).toMatchObject({ kind: "dropped", count: 1 });
    expect(e?.detail).toContain("notacolor");
    expect(flatten(r.contents).some((i) => i.type === "fill")).toBe(false);
  });

  it("maps stroke properties", () => {
    const r = importValid(
      svg(
        `<path d="M0 0 L9 9" stroke="red" stroke-width="2pt" stroke-linecap="round" stroke-linejoin="bevel" stroke-miterlimit="7" stroke-dasharray="3,2,1" stroke-dashoffset="4"/>`,
      ),
    );
    const s = flatten(r.contents).find((i) => i.type === "stroke");
    expect(s).toMatchObject({
      cap: "round",
      join: "bevel",
      miterLimit: 7,
      dashes: [3, 2, 1, 3, 2, 1],
      dashOffset: { value: 4 },
    });
    expect(s?.type === "stroke" && val(s.width)).toBeCloseTo(2 * (96 / 72), 5);
  });

  it("approximates miter-clip and arcs joins, ignores bad miterlimit", () => {
    const r = importValid(
      svg(`<path d="M0 0 L9 9" stroke="red" stroke-linejoin="arcs" stroke-miterlimit="0.2"/>`),
    );
    expect(flatten(r.contents).find((i) => i.type === "stroke")).toMatchObject({
      join: "miter",
      miterLimit: 4,
    });
    expect(entry(r, "line-join")).toMatchObject({ kind: "approximated" });
  });

  it("handles dash edge cases: zero, negative, too many", () => {
    const zero = importValid(svg(`<path d="M0 0L9 9" stroke="red" stroke-dasharray="0 0"/>`));
    expect(flatten(zero.contents).find((i) => i.type === "stroke")).toMatchObject({ dashes: [] });
    const neg = importValid(svg(`<path d="M0 0L9 9" stroke="red" stroke-dasharray="3 -1"/>`));
    expect(flatten(neg.contents).find((i) => i.type === "stroke")).toMatchObject({ dashes: [] });
    expect(entry(neg, "dash-invalid")).toBeDefined();
    const many = importValid(
      svg(
        `<path d="M0 0L9 9" stroke="red" stroke-dasharray="${Array.from({ length: 20 }, () => 1).join(" ")}"/>`,
      ),
    );
    const s = flatten(many.contents).find((i) => i.type === "stroke");
    expect(s?.type === "stroke" && s.dashes).toHaveLength(16);
    expect(entry(many, "dash-count")).toBeDefined();
  });

  it("skips zero-width strokes and reports non-scaling-stroke", () => {
    const z = importValid(
      svg(`<rect width="1" height="1" fill="none" stroke="red" stroke-width="0"/>`),
    );
    expect(z.contents).toHaveLength(0);
    const v = importValid(
      svg(`<rect width="1" height="1" stroke="red" vector-effect="non-scaling-stroke"/>`),
    );
    expect(entry(v, "vector-effect")).toMatchObject({ kind: "approximated" });
  });

  it("converts units and percentages against the viewBox", () => {
    const r = importValid(
      svg(`<rect x="10%" y="10%" width="50%" height="1in"/>`, 'viewBox="0 0 200 400"'),
    );
    expect(asGroup(r.contents[0]).items[0]).toMatchObject({
      position: { value: [70, 88] },
      size: { value: [100, 96] },
    });
    const em = importValid(svg(`<rect width="2em" height="1ex"/>`));
    expect(asGroup(em.contents[0]).items[0]).toMatchObject({ size: { value: [32, 8] } });
    expect(entry(em, "relative-unit")).toMatchObject({ kind: "approximated", count: 2 });
  });

  it("rounds numbers to 6 significant digits", () => {
    const r = importValid(svg(`<rect x="0.123456789" y="1234.56789" width="1" height="1"/>`));
    const rect = asGroup(r.contents[0]).items[0];
    expect(rect).toMatchObject({ position: { value: [0.623457, 1235.07] } });
  });
});

describe("opacity", () => {
  it("puts element opacity on its group transform", () => {
    const r = importValid(svg(`<rect width="1" height="1" opacity="0.4"/>`));
    expect(val(asGroup(r.contents[0]).transform.opacity)).toBe(0.4);
    expect(r.report.entries).toEqual([]);
  });

  it("reports group opacity only with several painted descendants", () => {
    const one = importValid(svg(`<g opacity="0.5"><rect width="1" height="1"/></g>`));
    expect(entry(one, "group-opacity")).toBeUndefined();
    const two = importValid(
      svg(`<g opacity="0.5"><rect width="1" height="1"/><rect width="1" height="1"/></g>`),
    );
    expect(entry(two, "group-opacity")).toMatchObject({ kind: "approximated", count: 1 });
  });

  it("reports element opacity when fill and stroke both paint", () => {
    const r = importValid(svg(`<rect width="1" height="1" opacity="0.5" stroke="red"/>`));
    expect(entry(r, "element-opacity")).toMatchObject({ kind: "approximated" });
    const only = importValid(svg(`<rect width="1" height="1" opacity="0.5"/>`));
    expect(entry(only, "element-opacity")).toBeUndefined();
  });
});

describe("gradients", () => {
  const stops = `<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>`;
  const fillOf = (r: ReturnType<typeof importValid>) =>
    flatten(r.contents).find((i) => i.type === "fill");

  it("maps objectBoundingBox coordinates through the element bbox", () => {
    const r = importValid(
      svg(
        `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient></defs><rect x="10" y="20" width="100" height="50" fill="url(#g)"/>`,
      ),
    );
    expect(fillOf(r)).toMatchObject({
      paint: {
        type: "linear-gradient",
        start: { value: [10, 20] },
        end: { value: [110, 70] },
        stops: {
          value: [
            { offset: 0, color: "#ff0000" },
            { offset: 1, color: "#0000ff" },
          ],
        },
      },
    });
  });

  it("defaults to a left-to-right gradient", () => {
    const r = importValid(
      svg(
        `<linearGradient id="g">${stops}</linearGradient><rect width="40" height="10" fill="url(#g)"/>`,
      ),
    );
    expect(fillOf(r)).toMatchObject({
      paint: { start: { value: [0, 0] }, end: { value: [40, 0] } },
    });
  });

  it("supports userSpaceOnUse with percentages and gradientTransform", () => {
    const r = importValid(
      svg(
        `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="50%" y2="0" gradientTransform="translate(10 5)">${stops}</linearGradient><rect width="9" height="9" fill="url(#g)"/>`,
      ),
    );
    expect(fillOf(r)).toMatchObject({
      paint: { start: { value: [10, 5] }, end: { value: [60, 5] } },
    });
  });

  it("applies gradientTransform in bbox space", () => {
    const r = importValid(
      svg(
        `<linearGradient id="g" gradientTransform="rotate(90)">${stops}</linearGradient><rect width="40" height="20" fill="url(#g)"/>`,
      ),
    );
    // unit (0,0)->(1,0) rotated 90 = (0,0)->(0,1), then scaled by the bbox
    expect(fillOf(r)).toMatchObject({
      paint: { start: { value: [0, 0] }, end: { value: [0, 20] } },
    });
  });

  it("reports a linear gradient whose bands would lean, and not an exact one", () => {
    const leaning = importValid(
      svg(
        `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient><rect width="140" height="35" fill="url(#g)"/>`,
      ),
    );
    expect(entry(leaning, "gradient-transform")).toMatchObject({ kind: "approximated" });
    const square = importValid(
      svg(
        `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient><rect width="40" height="40" fill="url(#g)"/>`,
      ),
    );
    expect(entry(square, "gradient-transform")).toBeUndefined();
    const axis = importValid(
      svg(
        `<linearGradient id="g">${stops}</linearGradient><rect width="140" height="35" fill="url(#g)"/>`,
      ),
    );
    expect(entry(axis, "gradient-transform")).toBeUndefined();
  });

  it("inherits attributes and stops through href, safely with cycles", () => {
    const r = importValid(
      svg(
        `<linearGradient id="base" x2="0" y2="1">${stops}</linearGradient><linearGradient id="derived" xlink:href="#base"/><rect width="10" height="10" fill="url(#derived)"/>`,
      ),
    );
    expect(fillOf(r)).toMatchObject({
      paint: { type: "linear-gradient", end: { value: [0, 10] } },
    });
    const cyc = importValid(
      svg(
        `<linearGradient id="a" href="#b">${stops}</linearGradient><linearGradient id="b" href="#a"/><rect width="10" height="10" fill="url(#b)"/>`,
      ),
    );
    expect(fillOf(cyc)?.type).toBe("fill");
  });

  it("converts radial gradients (uniform case)", () => {
    const r = importValid(
      svg(
        `<radialGradient id="g" cx="50" cy="40" r="20" gradientUnits="userSpaceOnUse">${stops}</radialGradient><rect width="9" height="9" fill="url(#g)"/>`,
      ),
    );
    expect(fillOf(r)).toMatchObject({
      paint: { type: "radial-gradient", center: { value: [50, 40] }, radius: { value: 20 } },
    });
    expect(entry(r, "gradient-transform")).toBeUndefined();
  });

  it("reports a stretched radial gradient and uses the mean radius", () => {
    const r = importValid(
      svg(
        `<radialGradient id="g">${stops}</radialGradient><rect width="40" height="10" fill="url(#g)"/>`,
      ),
    );
    expect(fillOf(r)).toMatchObject({
      paint: { center: { value: [20, 5] }, radius: { value: 10 } },
    });
    expect(entry(r, "gradient-transform")).toBeDefined();
  });

  it("transforms gradient coordinates with a baked element matrix", () => {
    const r = importValid(
      svg(
        `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="10" y1="0" y2="0">${stops}</linearGradient><rect width="10" height="10" fill="url(#g)" transform="translate(100 0) skewX(89)"/>`,
      ),
    );
    expect(fillOf(r)).toMatchObject({
      paint: { start: { value: [100, 0] }, end: { value: [110, 0] } },
    });
  });

  it("paints strokes with gradients too", () => {
    const r = importValid(
      svg(
        `<linearGradient id="g">${stops}</linearGradient><path d="M0 0 L20 10" fill="none" stroke="url(#g)"/>`,
      ),
    );
    expect(flatten(r.contents).find((i) => i.type === "stroke")).toMatchObject({
      paint: { type: "linear-gradient", end: { value: [20, 0] } },
    });
  });

  it("reads stop color and opacity from style, clamps and orders offsets", () => {
    const r = importValid(
      svg(
        `<linearGradient id="g"><stop offset="50%" style="stop-color:#00ff00;stop-opacity:.5"/><stop offset="0.2" stop-color="red"/><stop offset="2" stop-color="blue"/></linearGradient><rect width="9" height="9" fill="url(#g)"/>`,
      ),
    );
    const paint = (
      fillOf(r) as { paint: { stops: { value: { offset: number; color: string }[] } } }
    ).paint;
    expect(paint.stops.value).toEqual([
      { offset: 0.5, color: "#00ff0080" },
      { offset: 0.5, color: "#ff0000" },
      { offset: 1, color: "#0000ff" },
    ]);
  });

  it("makes one stop a solid paint and zero stops none", () => {
    const one = importValid(
      svg(
        `<linearGradient id="g"><stop stop-color="#123456"/></linearGradient><rect width="9" height="9" fill="url(#g)"/>`,
      ),
    );
    expect(fillOf(one)).toMatchObject({ paint: { type: "solid", color: { value: "#123456" } } });
    const none = importValid(
      svg(`<linearGradient id="g"/><rect width="9" height="9" fill="url(#g)"/>`),
    );
    expect(fillOf(none)).toBeUndefined();
  });

  it("keeps 64 stops and reports the rest", () => {
    const many = Array.from(
      { length: 70 },
      (_, i) => `<stop offset="${i / 70}" stop-color="red"/>`,
    ).join("");
    const r = importValid(
      svg(
        `<linearGradient id="g">${many}</linearGradient><rect width="9" height="9" fill="url(#g)"/>`,
      ),
    );
    const paint = (fillOf(r) as { paint: { stops: { value: unknown[] } } }).paint;
    expect(paint.stops.value).toHaveLength(64);
    expect(entry(r, "gradient-stops")).toMatchObject({ kind: "approximated" });
  });

  it("reports focal points and spread methods", () => {
    const r = importValid(
      svg(
        `<radialGradient id="g" fx="0.2" spreadMethod="reflect">${stops}</radialGradient><rect width="9" height="9" fill="url(#g)"/>`,
      ),
    );
    expect(entry(r, "gradient-focal")).toMatchObject({ kind: "approximated" });
    expect(entry(r, "spread-method")).toMatchObject({ kind: "approximated" });
  });

  it("uses the fallback color for a missing reference, else reports it", () => {
    const fb = importValid(svg(`<rect width="9" height="9" fill="url(#nope) #ff0000"/>`));
    expect(fillOf(fb)).toMatchObject({ paint: { color: { value: "#ff0000" } } });
    expect(entry(fb, "missing-reference")).toBeUndefined();
    const miss = importValid(svg(`<rect id="m" width="9" height="9" fill="url(#nope)"/>`));
    expect(fillOf(miss)).toBeUndefined();
    expect(entry(miss, "missing-reference")).toMatchObject({
      kind: "dropped",
      elements: ["rect#m"],
    });
  });

  it("drops a gradient on a zero-area bbox", () => {
    const r = importValid(
      svg(
        `<linearGradient id="g">${stops}</linearGradient><path d="M0 0 L20 0" fill="none" stroke="url(#g)"/>`,
      ),
    );
    expect(flatten(r.contents).some((i) => i.type === "stroke")).toBe(false);
    expect(entry(r, "gradient-bbox")).toBeDefined();
  });
});

describe("use", () => {
  it("expands a referenced element in a group named use, with x/y as a translate", () => {
    const r = importValid(
      svg(`<defs><rect id="r" width="5" height="5"/></defs><use href="#r" x="10" y="20"/>`),
    );
    const g = asGroup(r.contents[0]);
    expect(g.name).toBe("use");
    expect(val(g.transform.position)).toEqual([10, 20]);
    expect(asGroup(g.items[0]).name).toBe("r");
  });

  it("names the group after the use id and supports xlink:href", () => {
    const r = importValid(
      svg(`<defs><rect id="r" width="5" height="5"/></defs><use id="u" xlink:href="#r"/>`),
    );
    expect(asGroup(r.contents[0]).name).toBe("u");
  });

  it("inherits style from the use element into the referenced content", () => {
    const r = importValid(
      svg(
        `<defs><rect id="r" width="5" height="5"/></defs><use href="#r" fill="#00ff00"/><use href="#r"/>`,
      ),
    );
    const fills = flatten(r.contents).filter((i) => i.type === "fill");
    expect(
      fills.map((f) => (f.type === "fill" && f.paint.type === "solid" ? val(f.paint.color) : "")),
    ).toEqual(["#000000", "#00ff00"]);
  });

  it("references symbols as groups and reports their viewBox", () => {
    const r = importValid(
      svg(`<symbol id="s" viewBox="0 0 10 10"><circle r="3"/></symbol><use href="#s"/>`),
    );
    expect(flatten(r.contents).some((i) => i.type === "ellipse")).toBe(true);
    expect(entry(r, "symbol-viewbox")).toMatchObject({ kind: "approximated" });
  });

  it("does not paint symbols and defs directly", () => {
    const r = importValid(
      svg(`<defs><rect width="5" height="5"/></defs><symbol><rect width="5" height="5"/></symbol>`),
    );
    expect(r.contents).toHaveLength(0);
  });

  it("reports missing targets and cycles instead of looping", () => {
    const missing = importValid(svg(`<use href="#nope"/><use/>`));
    expect(entry(missing, "missing-reference")).toMatchObject({ kind: "dropped", count: 2 });
    const cyc = importValid(svg(`<g id="a"><rect width="1" height="1"/><use href="#a"/></g>`));
    expect(entry(cyc, "missing-reference")).toBeDefined();
    expect(flatten(cyc.contents).filter((i) => i.type === "rect")).toHaveLength(1);
    const indirect = importValid(
      svg(`<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g><use href="#a"/>`),
    );
    expect(entry(indirect, "missing-reference")).toBeDefined();
  });
});

describe("root and title", () => {
  it("reads the viewBox, size and title", () => {
    const r = importValid(ICON);
    expect(r.viewBox).toEqual({ x: 0, y: 0, width: 24, height: 24 });
    expect(r.size).toEqual({ width: 24, height: 24 });
    expect(r.anchorPoint).toEqual([12, 12]);
    expect(r.scale).toEqual([1, 1]);
    expect(r.title).toBe("Record");
  });

  it("falls back from viewBox to width/height to 300x150", () => {
    expect(
      importValid(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"/>`).viewBox,
    ).toEqual({
      x: 0,
      y: 0,
      width: 80,
      height: 40,
    });
    const d = importValid(`<svg xmlns="http://www.w3.org/2000/svg"/>`);
    expect(d.viewBox).toEqual({ x: 0, y: 0, width: 300, height: 150 });
    expect(d.size).toEqual({ width: 300, height: 150 });
  });

  it("scales the viewBox to the size and centres the anchor on the viewBox", () => {
    const r = importValid(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 50 25" width="100" height="50"/>`,
    );
    expect(r.anchorPoint).toEqual([35, 32.5]);
    expect(r.scale).toEqual([2, 2]);
  });

  it("derives a missing side from the viewBox aspect ratio and resolves percentages", () => {
    const w = importValid(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12" width="48"/>`,
    );
    expect(w.size).toEqual({ width: 48, height: 24 });
    const p = importValid(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12" width="50%" height="100%"/>`,
    );
    expect(p.size).toEqual({ width: 12, height: 12 });
  });

  it("follows preserveAspectRatio", () => {
    const attrs = (par: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="100" height="50" preserveAspectRatio="${par}"/>`;
    expect(importValid(attrs("none")).scale).toEqual([10, 5]);
    expect(importValid(attrs("xMidYMid meet")).scale).toEqual([5, 5]);
    expect(importValid(attrs("xMidYMid slice")).scale).toEqual([10, 10]);
    const other = importValid(attrs("xMinYMax meet"));
    expect(other.scale).toEqual([5, 5]);
    expect(entry(other, "preserve-aspect-ratio")).toMatchObject({ kind: "approximated" });
  });

  it("ignores an invalid viewBox with a report", () => {
    const r = importValid(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 10" width="20" height="10"/>`,
    );
    expect(r.viewBox.width).toBe(20);
    expect(entry(r, "invalid-viewbox")).toBeDefined();
  });

  it("treats a nested svg as a group moved to x/y", () => {
    const r = importValid(svg(`<svg x="5" y="7"><rect width="1" height="1"/></svg>`));
    expect(val(asGroup(r.contents[0]).transform.position)).toEqual([5, 7]);
    expect(entry(r, "nested-svg")).toMatchObject({ kind: "approximated" });
  });

  it("applies root presentation attributes to the content", () => {
    const r = importValid(svg(`<rect width="1" height="1"/>`, 'viewBox="0 0 9 9" fill="#ff0000"'));
    expect(flatten(r.contents).find((i) => i.type === "fill")).toMatchObject({
      paint: { color: { value: "#ff0000" } },
    });
  });

  it("accepts an svg: prefixed root and children", () => {
    const r = importValid(
      `<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 9 9"><svg:rect width="1" height="1"/></svg:svg>`,
    );
    expect(r.contents).toHaveLength(1);
  });
});

describe("fidelity report", () => {
  const dropped = (body: string, feature: string) => {
    const r = importValid(svg(body));
    const e = entry(r, feature);
    expect(e, feature).toBeDefined();
    expect(e?.detail.length).toBeGreaterThan(20);
    return { r, e };
  };

  it("reports text with a pointer to text layers", () => {
    const { e } = dropped(`<text x="1" y="1">Hi <tspan>there</tspan></text>`, "text");
    expect(e).toMatchObject({ kind: "dropped", count: 1 });
    expect(e?.detail).toContain("text layer");
  });

  it("reports images, foreignObject, style sheets and animation", () => {
    expect(dropped(`<image href="a.png"/>`, "image").e?.detail).toContain("upload_asset");
    dropped(`<foreignObject><div/></foreignObject>`, "foreign-object");
    const style = dropped(
      `<defs><style>.a{fill:red}</style></defs><rect class="a" width="1" height="1"/>`,
      "style-sheet",
    );
    expect(style.e?.detail).toContain("presentation attributes");
    const anim = dropped(
      `<rect width="1" height="1"><animate attributeName="x" to="5"/></rect><animateTransform/>`,
      "animation",
    );
    expect(anim.e?.count).toBe(2);
    expect(anim.e?.detail).toContain("intent tools");
  });

  it("reports filter, clip-path, mask, markers and patterns", () => {
    expect(dropped(`<rect width="1" height="1" filter="url(#f)"/>`, "filter").e?.detail).toContain(
      "add_effect",
    );
    expect(
      dropped(`<rect width="1" height="1" clip-path="url(#c)"/>`, "clip-path").e?.detail,
    ).toContain("add_mask");
    expect(
      dropped(`<rect width="1" height="1" style="mask:url(#m)"/>`, "mask").e?.detail,
    ).toContain("add_mask");
    dropped(`<path d="M0 0L5 5" stroke="red" marker-end="url(#m)"/>`, "marker");
    const pat = dropped(
      `<pattern id="p" width="2" height="2"><rect width="1" height="1"/></pattern><rect width="9" height="9" fill="url(#p)" stroke="red"/>`,
      "pattern",
    );
    expect(flatten(pat.r.contents).some((i) => i.type === "fill")).toBe(false);
    expect(flatten(pat.r.contents).filter((i) => i.type === "rect")).toHaveLength(1);
  });

  it("reports hidden content and unknown elements", () => {
    const hidden = dropped(
      `<rect width="1" height="1" display="none"/><g visibility="hidden"><rect width="1" height="1"/></g><rect width="1" height="1" style="visibility:collapse"/>`,
      "hidden",
    );
    expect(hidden.e?.count).toBe(3);
    expect(hidden.r.contents).toHaveLength(0);
    dropped(`<blink/>`, "unknown-element");
  });

  it("lets a child override inherited hidden visibility", () => {
    const r = importValid(
      svg(`<g visibility="hidden"><rect width="1" height="1" visibility="visible"/></g>`),
    );
    expect(flatten(r.contents).filter((i) => i.type === "rect")).toHaveLength(1);
  });

  it("aggregates by kind and feature, counts occurrences and keeps at most 5 examples", () => {
    const body =
      Array.from({ length: 8 }, (_, i) => `<text id="t${i}">x</text>`).join("") +
      `<image id="im"/>`;
    const r = importValid(svg(body));
    const text = entry(r, "text");
    expect(text?.count).toBe(8);
    expect(text?.elements).toEqual(["text#t0", "text#t1", "text#t2", "text#t3", "text#t4"]);
    expect(r.report.entries.map((e) => `${e.kind}/${e.feature}`)).toEqual([
      "dropped/image",
      "dropped/text",
    ]);
  });

  it("labels elements without ids by index path", () => {
    const r = importValid(
      svg(`<g/><g><rect width="1" height="1"/><text>a</text><text>b</text></g>`),
    );
    expect(entry(r, "text")?.elements).toEqual(["g[2] > text[1]", "g[2] > text[2]"]);
  });

  it("sorts entries by kind, then feature", () => {
    const r = importValid(
      svg(
        `<text>a</text><rect width="1" height="1" transform="skewX(89)" opacity=".5" stroke="red"/><image/>`,
      ),
    );
    const keys = r.report.entries.map((e) => `${e.kind}/${e.feature}`);
    expect(keys).toEqual([...keys].sort());
    expect(keys.length).toBeGreaterThanOrEqual(4);
  });

  it("summarises the output", () => {
    const r = importValid(ICON);
    expect(r.report.summary).toMatchObject({ elements: 4, paths: 3, fills: 2, strokes: 0 });
    expect(r.report.summary.vertices).toBe(8);
    expect(r.report.summary.groups).toBe(2);
  });
});

describe("fixtures", () => {
  it("imports an icon with an evenodd hole as two subpaths under one fill", () => {
    const r = importValid(ICON);
    const ring = asGroup(r.contents[1]);
    expect(ring.name).toBe("ring");
    expect(types(ring.items)).toEqual(["path", "path", "fill"]);
    expect(ring.items[2]).toMatchObject({
      rule: "evenodd",
      paint: { color: { value: "#1a1a1a" } },
    });
    expect(r.contents[0]).toBeDefined();
    expect(asGroup(r.contents[0]).items[0]).toMatchObject({
      type: "ellipse",
      size: { value: [6, 6] },
    });
    expect(r.report.entries).toEqual([]);
  });

  it("imports a logo with gradients, groups, use and dashes", () => {
    const r = importValid(LOGO);
    expect(r.size).toEqual({ width: 400, height: 200 });
    expect(r.scale).toEqual([2, 2]);
    const flat = flatten(r.contents);
    expect(
      flat.filter((i) => i.type === "fill" && i.paint.type === "linear-gradient"),
    ).toHaveLength(1);
    expect(
      flat.filter((i) => i.type === "fill" && i.paint.type === "radial-gradient"),
    ).toHaveLength(1);
    expect(flat.find((i) => i.type === "stroke" && i.dashes.length === 2)).toBeDefined();
    const mark = r.contents.find((i) => i.name === "mark") as Group;
    expect(val(mark.transform.position)).toEqual([20, 10]);
    expect(r.report.entries).toEqual([]);
  });

  it("imports an Inkscape export with transforms, metadata and a style sheet", () => {
    const r = importValid(INKSCAPE);
    expect(r.size.width).toBeCloseTo((210 * 96) / 25.4, 3);
    expect(r.viewBox.width).toBe(210);
    const keys = r.report.entries.map((e) => `${e.kind}/${e.feature}`);
    expect(keys).toEqual(["dropped/clip-path", "dropped/style-sheet", "dropped/text"]);
    const layer = asGroup(r.contents[0]);
    expect(val(layer.transform.position)).toEqual([-10, -20]);
    const path = flatten(r.contents).find(
      (i): i is Group => i.type === "group" && i.name === "path10",
    );
    expect(val(path?.transform.rotation ?? { value: 0 })).toBeCloseTo(-10, 5);
    // inline style wins over the (unapplied) class rule
    expect(path?.items.find((i) => i.type === "fill")).toMatchObject({
      paint: { color: { value: "#336699" } },
    });
    const ellipse = flatten(r.contents).find(
      (i): i is Group => i.type === "group" && i.name === "ellipse12",
    );
    expect(val(ellipse?.transform.opacity ?? { value: 0 })).toBe(0.8);
  });
});

describe("reports for approximations and silent drops", () => {
  const rect = `<rect width="10" height="10"/>`;

  it("applies a transform on the root svg", () => {
    const r = importValid(svg(rect, `viewBox="0 0 100 100" transform="translate(10 20)"`));
    expect(r.contents).toHaveLength(1);
    const g = asGroup(r.contents[0]);
    expect(val(g.transform.position)).toEqual([10, 20]);
    expect(g.items).toHaveLength(1);
    expect(r.report.entries).toEqual([]);
  });

  it("reports unsupported properties by name, once per property", () => {
    const r = importValid(
      svg(
        `<rect width="10" height="10" style="paint-order:stroke;mix-blend-mode:multiply" /><circle r="3" style="transform:rotate(5deg);cx:5;r:9" paint-order="stroke"/>`,
      ),
    );
    const e = entry(r, "unsupported-property");
    expect(e).toMatchObject({ kind: "dropped", count: 6 });
    for (const name of ["paint-order", "mix-blend-mode", "transform", "cx"]) {
      expect(e?.detail).toContain(name);
    }
  });

  it("lists at most ten distinct property names", () => {
    const style = Array.from({ length: 15 }, (_, i) => `prop-${i}:1`).join(";");
    const e = entry(
      importValid(svg(`<rect width="1" height="1" style="${style}"/>`)),
      "unsupported-property",
    );
    expect(e?.detail).toContain("prop-9");
    expect(e?.detail).not.toContain("prop-10");
    expect(e?.detail).toContain("5 more");
  });

  it("stays quiet for carried, harmless and default-valued properties", () => {
    const r = importValid(
      svg(
        `<rect width="10" height="10" shape-rendering="crispEdges" style="fill:red;stroke:blue;font-size:12px;text-anchor:middle;-inkscape-font-specification:Sans;isolation:auto;mix-blend-mode:normal;paint-order:normal;pointer-events:none;cursor:pointer;overflow:hidden;color-interpolation:sRGB;display:inline;vector-effect:none"/>`,
      ),
    );
    expect(entry(r, "unsupported-property")).toBeUndefined();
    expect(r.report.entries).toEqual([]);
  });

  it("reports a switch with conditional children", () => {
    const r = importValid(
      svg(`<switch><rect systemLanguage="de" width="1" height="1"/><circle r="2"/></switch>`),
    );
    expect(entry(r, "switch")).toMatchObject({ kind: "approximated" });
    const plain = importValid(svg(`<switch><rect width="1" height="1"/><circle r="2"/></switch>`));
    expect(entry(plain, "switch")).toBeUndefined();
  });

  it("reports content outside the visible area", () => {
    const out = importValid(svg(`<rect x="90" y="0" width="30" height="10"/>`));
    expect(entry(out, "viewport-clip")).toMatchObject({ kind: "approximated" });
    const inside = importValid(
      svg(`<rect x="90" y="0" width="10" height="10" stroke="red" stroke-width="4"/>`),
    );
    expect(entry(inside, "viewport-clip")).toBeUndefined();
    // a transformed shape is measured in root space
    const moved = importValid(
      svg(`<g transform="translate(95 0)"><rect width="10" height="10"/></g>`),
    );
    expect(entry(moved, "viewport-clip")).toBeDefined();
    // hidden content does not count
    const hidden = importValid(svg(`<rect x="500" width="9" height="9" display="none"/>`));
    expect(entry(hidden, "viewport-clip")).toBeUndefined();
  });

  it("measures the visible area by the viewport, with meet and slice", () => {
    const wide = `viewBox="0 0 100 100" width="200" height="100"`;
    // meet: the viewport shows x from -50 to 150
    expect(
      entry(importValid(svg(`<rect x="110" width="30" height="10"/>`, wide)), "viewport-clip"),
    ).toBeUndefined();
    expect(
      entry(importValid(svg(`<rect x="110" width="50" height="10"/>`, wide)), "viewport-clip"),
    ).toBeDefined();
    // slice: the viewport crops the viewBox to y 25..75
    const sliced = `${wide} preserveAspectRatio="xMidYMid slice"`;
    expect(
      entry(importValid(svg(`<rect y="0" width="10" height="10"/>`, sliced)), "viewport-clip"),
    ).toBeDefined();
    expect(
      entry(importValid(svg(`<rect y="30" width="10" height="10"/>`, sliced)), "viewport-clip"),
    ).toBeUndefined();
  });

  it("reports zero-length subpaths that need round or square caps", () => {
    const dot = (cap: string) =>
      importValid(svg(`<path d="M5 5 z" stroke="red" stroke-linecap="${cap}" fill="none"/>`));
    expect(entry(dot("round"), "zero-length-cap")).toMatchObject({ kind: "dropped" });
    expect(entry(dot("square"), "zero-length-cap")).toBeDefined();
    expect(entry(dot("butt"), "zero-length-cap")).toBeUndefined();
    const line = importValid(
      svg(`<line x1="3" y1="3" x2="3" y2="3" stroke="red" stroke-linecap="round"/>`),
    );
    expect(entry(line, "zero-length-cap")).toBeDefined();
  });

  it("reports a radial gradient focal radius", () => {
    const grad = (extra: string) =>
      importValid(
        svg(
          `<defs><radialGradient id="g" ${extra}><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient></defs><rect width="10" height="10" fill="url(#g)"/>`,
        ),
      );
    expect(entry(grad('fr="0.2"'), "gradient-focal")).toMatchObject({ kind: "approximated" });
    expect(entry(grad('fr="0"'), "gradient-focal")).toBeUndefined();
  });
});

describe("limits and hostile input", () => {
  const code = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      if (e instanceof SvgImportError) return `${e.code}: ${e.message}`;
      throw e;
    }
    return "no error";
  };

  it("rejects input over the byte limit before parsing, counting UTF-8 bytes", () => {
    const big = svg(`<desc>${"é".repeat(SVG_LIMITS.sourceBytes / 2 + 1)}</desc>`);
    const msg = code(() => importSvg(big));
    expect(msg).toMatch(/^too-large:/);
    expect(msg).toContain("524 288");
  });

  it("rejects too many elements and names the limit", () => {
    const body = "<g/>".repeat(SVG_LIMITS.elements + 10);
    const msg = code(() => importSvg(svg(body)));
    expect(msg).toMatch(/^limit: .*5 000/);
  });

  it("rejects non-SVG and malformed input", () => {
    expect(code(() => importSvg(""))).toMatch(/^not-svg/);
    expect(code(() => importSvg("<html><body/></html>"))).toMatch(/^not-svg/);
    expect(code(() => importSvg("just text"))).toMatch(/^malformed|^not-svg/);
    expect(code(() => importSvg("<svg><g></svg>"))).toMatch(/^malformed/);
    expect(code(() => importSvg('<svg a="1" a="2"/>'))).toMatch(/^malformed/);
  });

  it("rejects DOCTYPE entity declarations (billion laughs, XXE)", () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "ha"><!ENTITY b "&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;">]><svg xmlns="http://www.w3.org/2000/svg"><text>&c;</text></svg>`;
    expect(code(() => importSvg(laughs))).toMatch(/^entities:/);
    const xxe = `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"/>`;
    expect(code(() => importSvg(xxe))).toMatch(/^entities:/);
    expect(code(() => importSvg(xxe.replace("ENTITY", "entity")))).toMatch(/^entities:/);
  });

  it("does not expand undeclared entities and reads the built-in ones", () => {
    const r = importValid(svg(`<title>a &amp; b &lt;&#65;</title>`));
    expect(
      importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>a &amp; b &lt;&#65;</title></svg>`,
      ).title,
    ).toBe("a & b <A");
    expect(r.contents).toEqual([]);
  });

  it("accepts a harmless DOCTYPE", () => {
    const r = importValid(
      `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9"><rect width="1" height="1"/></svg>`,
    );
    expect(r.contents).toHaveLength(1);
  });

  it("rejects absurd element nesting with a limit error, not a stack overflow", () => {
    const n = 20_000;
    const msg = code(() => importSvg(svg(`${"<g>".repeat(n)}${"</g>".repeat(n)}`)));
    expect(msg).toMatch(/^limit:/);
    const mid = 300;
    expect(code(() => importSvg(svg(`${"<g>".repeat(mid)}${"</g>".repeat(mid)}`)))).toMatch(
      /^limit:.*256/,
    );
  });

  it("limits <use> nesting depth", () => {
    const defs = Array.from(
      { length: 12 },
      (_, i) => `<g id="u${i}"><use href="#u${i + 1}"/></g>`,
    ).join("");
    const msg = code(() =>
      importSvg(svg(`${defs}<g id="u12"><rect width="1" height="1"/></g><use href="#u0"/>`)),
    );
    expect(msg).toMatch(/^limit:.*8/);
    const ok = Array.from(
      { length: 4 },
      (_, i) => `<g id="v${i}"><use href="#v${i + 1}"/></g>`,
    ).join("");
    expect(
      code(() =>
        importSvg(svg(`${ok}<g id="v4"><rect width="1" height="1"/></g><use href="#v0"/>`)),
      ),
    ).toBe("no error");
  });

  it("limits <use> expansion (exponential blow-up)", () => {
    // each level references the next ten times; depth 6 would expand to 10^6 groups
    let defs = `<g id="l6"><rect width="1" height="1"/></g>`;
    for (let i = 5; i >= 0; i--)
      defs += `<g id="l${i}">${`<use href="#l${i + 1}"/>`.repeat(10)}</g>`;
    const msg = code(() => importSvg(svg(`${defs}<use href="#l0"/>`)));
    expect(msg).toMatch(/^limit:.*5 000/);
  });

  it("limits vertices per subpath and in total", () => {
    const longPath = `M0 0 ${Array.from({ length: 1500 }, (_, i) => `L${i} ${i % 7}`).join(" ")}`;
    const msg = code(() => importSvg(svg(`<path id="big" d="${longPath}"/>`)));
    expect(msg).toMatch(/^limit: path#big .*1 000/);

    const path = `M0 0 ${Array.from({ length: 900 }, (_, i) => `L${i} ${i % 7}`).join(" ")}`;
    const many = Array.from({ length: 60 }, () => `<path d="${path}"/>`).join("");
    expect(code(() => importSvg(svg(many)))).toMatch(/^limit:.*50 000/);
  });

  describe("linear-time attribute parsing", () => {
    const BIG = 400_000;
    /** Imports, returning the elapsed milliseconds; refusals count as completing. */
    const timed = (source: string): { ms: number; result: SvgImportResult | undefined } => {
      const t0 = clock.now();
      let result: SvgImportResult | undefined;
      try {
        result = importSvg(source);
      } catch (e) {
        if (!(e instanceof SvgImportError)) throw e;
      }
      return { ms: clock.now() - t0, result };
    };

    it("url() paints with a huge unterminated body", () => {
      for (const fill of [
        `url(${" ".repeat(BIG)}`,
        `url(#a${" ".repeat(BIG)}x`,
        `url(${"( ".repeat(BIG / 2)}`,
      ]) {
        const { ms, result } = timed(svg(`<rect width="1" height="1" fill="${fill}"/>`));
        expect(ms).toBeLessThan(1000);
        expect(result && entry(result, "missing-reference")).toBeDefined();
      }
    });

    it("rgb()/hsl() colors with a huge body", () => {
      for (const fill of [
        `rgb(${" ".repeat(BIG)}`,
        `rgb(${" ".repeat(BIG)}1 2 3 x)`,
        `hsl(${"1 ".repeat(BIG / 2)}`,
      ]) {
        const { ms, result } = timed(svg(`<rect width="1" height="1" fill="${fill}"/>`));
        expect(ms).toBeLessThan(1000);
        expect(result && entry(result, "invalid-color")).toBeDefined();
      }
    });

    it("number lists and lengths made of digits", () => {
      const digits = "1".repeat(BIG);
      const cases = [
        svg(`<polygon points="${digits}x"/>`),
        svg(`<polyline points="${"1.".repeat(BIG / 2)}x" stroke="red"/>`),
        svg(`<rect width="${digits}x" height="1"/>`),
        svg(`<path d="M${digits}e"/>`),
        svg(`<path d="M0 0 L${"0.".repeat(BIG / 2)}"/>`),
        svg(`<rect width="1" height="1"/>`, `viewBox="${digits}x 0 1 1"`),
      ];
      for (const source of cases) expect(timed(source).ms).toBeLessThan(1000);
    });

    it("transform lists with endless separators", () => {
      for (const t of [
        `${" ".repeat(BIG)}x`,
        `${", ".repeat(BIG / 2)}x`,
        `translate(1)${" ".repeat(BIG)}x`,
        `translate(${" ".repeat(BIG)}`,
      ]) {
        const { ms, result } = timed(svg(`<rect width="1" height="1" transform="${t}"/>`));
        expect(ms).toBeLessThan(1000);
        expect(result && entry(result, "transform-error")).toBeDefined();
      }
    });

    it("style attributes and long ids", () => {
      const style = `fill:red${"!important ".repeat(BIG / 11)}x`;
      expect(timed(svg(`<rect width="1" height="1" style="${style}"/>`)).ms).toBeLessThan(1000);
      const id = "a".repeat(BIG);
      const { ms, result } = timed(svg(`<rect id="${id}" width="1" height="1" filter="url(#f)"/>`));
      expect(ms).toBeLessThan(1000);
      const label = (result && entry(result, "filter"))?.elements[0] ?? "";
      expect(label.length).toBeLessThanOrEqual(70);
    });

    it("a 500 KB SVG of mixed hostile attributes", () => {
      const part = 90_000;
      const body = [
        `<rect width="1" height="1" fill="url(${" ".repeat(part)}"/>`,
        `<rect width="1" height="1" fill="rgb(${" ".repeat(part)}"/>`,
        `<rect width="1" height="1" transform="${", ".repeat(part / 2)}x"/>`,
        `<polygon points="${"1.".repeat(part / 2)}x"/>`,
        `<path d="M${"0".repeat(part)}e"/>`,
      ].join("");
      const source = svg(body);
      expect(utf8Bytes(source)).toBeGreaterThan(440_000);
      expect(utf8Bytes(source)).toBeLessThan(SVG_LIMITS.sourceBytes);
      expect(timed(source).ms).toBeLessThan(2000);
    });

    it("a use fan-out near the limits finishes quickly with short labels", () => {
      const uses = Array.from({ length: 1500 }, () => `<use href="#a" filter="url(#f)"/>`).join("");
      const { ms, result } = timed(
        svg(`<g id="a"><rect width="1" height="1" filter="url(#f)"/></g>${uses}`),
      );
      expect(ms).toBeLessThan(1000);
      expect(entry(result as SvgImportResult, "filter")?.elements.length).toBeLessThanOrEqual(5);
    });
  });

  describe("non-finite output", () => {
    const refused = (source: string): string => {
      try {
        importSvg(source);
      } catch (e) {
        if (e instanceof SvgImportError) return `${e.code}: ${e.message}`;
        throw e;
      }
      return "no error";
    };

    it("refuses transforms whose result overflows", () => {
      const m = "matrix(1e200 0 0 1e200 0 0)";
      expect(refused(svg(`<g transform="${m}"><path d="M0 0 L1e200 1e200 L5 1z"/></g>`))).toMatch(
        /^limit:.*±1e15/,
      );
      expect(refused(svg(`<path transform="${m}" d="M0 0 L1e200 1e200 L5 1z"/>`))).toMatch(
        /^limit:/,
      );
      // finite after baking: still imports
      expect(refused(svg(`<g transform="${m}"><rect width="1" height="1"/></g>`))).toBe("no error");
    });

    it("refuses path data that overflows", () => {
      expect(refused(svg(`<path d="M1e308 0 l1e308 0 l0 1z"/>`))).toMatch(/^limit:/);
    });

    it("refuses absurd viewBox and size values", () => {
      expect(refused(svg(`<rect width="1" height="1"/>`, `viewBox="0 0 1e-320 1e-320"`))).toMatch(
        /^limit:.*1e-6/,
      );
      expect(
        refused(svg(`<rect width="1" height="1"/>`, `viewBox="0 0 1 1e-300" height="1e300"`)),
      ).toMatch(/^limit:/);
      expect(refused(svg(`<circle r="100%" cx="1" cy="1"/>`, `viewBox="0 0 1e308 1e308"`))).toMatch(
        /^limit:/,
      );
    });
  });

  describe("XML depth", () => {
    const nest = (n: number): string =>
      svg(`${"<g>".repeat(n)}<rect width="1" height="1"/>${"</g>".repeat(n)}`);

    it("imports just under the depth limit", () => {
      const r = importSvg(nest(SVG_LIMITS.xmlDepth - 2));
      expect(flatten(r.contents).some((i) => i.type === "rect")).toBe(true);
    });

    it("refuses past the limit and names it", () => {
      let msg = "";
      try {
        importSvg(nest(SVG_LIMITS.xmlDepth + 1));
      } catch (e) {
        msg = e instanceof SvgImportError ? `${e.code}: ${e.message}` : String(e);
      }
      expect(msg).toMatch(/^limit:.*256/);
    });
  });

  it("is deterministic", () => {
    for (const source of [ICON, LOGO, INKSCAPE]) {
      expect(importSvg(source)).toEqual(importSvg(source));
    }
  });

  it("produces valid contents for every fixture and tricky mix", () => {
    for (const source of [
      ICON,
      LOGO,
      INKSCAPE,
      svg(
        `<g transform="rotate(45)"><g transform="skewX(88)"><path d="M0 0 a5 5 0 1 1 10 0z" stroke="red" stroke-dasharray="1 2 3"/></g></g>`,
      ),
    ]) {
      importValid(source);
    }
  });
});
