import {
  ID_PATTERN,
  MAX_GROUP_DEPTH,
  MAX_SHAPE_ITEMS,
  type Paint,
  type ShapeItem,
  type ShapeItemId,
  ShapeItemIdSchema,
} from "@kynimo/scene";
import {
  decompose,
  determinant,
  IDENTITY,
  isIdentity,
  isSimilarity,
  type Matrix,
  multiply,
  parseTransform,
} from "./affine.js";
import { parseColor } from "./color.js";
import {
  type Bbox,
  bboxOfContours,
  type Contour,
  contoursOf,
  type Geometry,
  geometryBbox,
  roundedRectContour,
  transformContour,
} from "./geometry.js";
import { buildGradient } from "./gradient.js";
import { NUMBER_SOURCE, parseNumber, round6 } from "./numbers.js";
import { parsePathData } from "./path-data.js";
import { ReportCollector } from "./report.js";
import {
  computeInherited,
  currentColorOf,
  declared,
  type Inherited,
  parseOpacity,
  unsupportedProperties,
} from "./style.js";
import { formatCount, SVG_LIMITS, SvgImportError, type SvgImportResult } from "./types.js";
import { type Axis, parseLength, type Viewport } from "./units.js";
import { labelOf, type ParsedSvg, type XNode } from "./xml.js";

const PAINTED = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const SILENT = new Set([
  "defs",
  "symbol",
  "title",
  "desc",
  "metadata",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "filter",
  "marker",
  "pattern",
]);
const EDITOR_PREFIXES = new Set(["sodipodi", "inkscape", "rdf", "cc", "dc", "dcterms", "xlink"]);
const ANIMATION = new Set(["animate", "animateTransform", "animateMotion", "animateColor", "set"]);
const CONDITIONAL = ["systemLanguage", "requiredExtensions", "requiredFeatures"] as const;
const TEXT = new Set(["text", "tspan", "textPath"]);
const MAX_VERTICES_PER_PATH = 1000;
/** Groups beyond this depth are dissolved into their parent. */
const MAX_GROUP_NESTING = MAX_GROUP_DEPTH - 1;

type Item<T extends ShapeItem["type"]> = Extract<ShapeItem, { type: T }>;
type GroupItem = Item<"group">;

interface Ctx {
  inh: Inherited;
  /** Matrix from the current element's parent coordinates into the nearest real group, when an ancestor was baked. */
  pre: Matrix | null;
  /** Nesting depth the next group item would have (1 = directly in the layer contents). */
  depth: number;
  useDepth: number;
  /** Matrix from the current element's parent coordinates to the root's user space. */
  ctm: Matrix;
}

/** Splits `url(#id) fallback` by hand (linear time). `ref` is empty when the syntax is invalid. */
function parseUrlPaint(value: string): { ref: string; rest: string } {
  let i = 4;
  const skip = (): void => {
    while (i < value.length && /\s/.test(value[i] ?? "")) i++;
  };
  skip();
  const q = value[i];
  let ref: string;
  if (q === '"' || q === "'") {
    const end = value.indexOf(q, i + 1);
    if (end < 0) return { ref: "", rest: "" };
    ref = value.slice(i + 1, end);
    i = end + 1;
  } else {
    const start = i;
    while (i < value.length && value[i] !== ")" && !/\s/.test(value[i] ?? "")) i++;
    ref = value.slice(start, i);
  }
  skip();
  if (value[i] !== ")") return { ref: "", rest: "" };
  return { ref: ref.trim(), rest: value.slice(i + 1).trim() };
}

const MIN_SIZE = 1e-6;
const MAX_MAGNITUDE = 1e15;
const NON_FINITE_MESSAGE =
  "SVG coordinates are too large or too small to represent; keep numbers within ±1e15 and sizes above 1e-6";

/** Every number reachable from `root` is finite (iterative; the value is plain JSON-like data). */
function allFinite(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return false;
    } else if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (typeof v === "object" && v !== null) {
      for (const x of Object.values(v)) stack.push(x);
    }
  }
  return true;
}

const constant = <T>(value: T): { value: T } => ({ value });

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);

const roundContour = (c: Contour): Contour => ({
  closed: c.closed,
  vertices: c.vertices.map((v) => ({
    point: [round6(v.point[0]), round6(v.point[1])],
    inTangent: [round6(v.inTangent[0]), round6(v.inTangent[1])],
    outTangent: [round6(v.outTangent[0]), round6(v.outTangent[1])],
  })),
});

export class Converter {
  private readonly report = new ReportCollector();
  private readonly usedIds = new Set<string>();
  private readonly counters = new Map<string, number>();
  private readonly active = new Set<XNode>();
  private viewport: Viewport = { width: 300, height: 150 };
  private visited = 0;
  private vertexTotal = 0;
  private paintedCount = 0;
  /** `[minX, minY, maxX, maxY]` of painted shapes in root user space. */
  private contentBox: [number, number, number, number] | null = null;

  constructor(private readonly doc: ParsedSvg) {}

  // ---------------------------------------------------------------- ids and small helpers

  private newId(type: string, svgId?: string): ShapeItemId {
    if (svgId !== undefined) {
      const slug = slugify(svgId);
      if (ID_PATTERN.test(slug) && !this.usedIds.has(slug)) {
        this.usedIds.add(slug);
        return ShapeItemIdSchema.parse(slug);
      }
    }
    for (;;) {
      const n = (this.counters.get(type) ?? 0) + 1;
      this.counters.set(type, n);
      const candidate = `${type}-${n}`;
      if (!this.usedIds.has(candidate)) {
        this.usedIds.add(candidate);
        return ShapeItemIdSchema.parse(candidate);
      }
    }
  }

  private visit(node: XNode): void {
    this.visited++;
    if (this.visited > SVG_LIMITS.expandedElements) {
      throw new SvgImportError(
        "limit",
        `SVG expands to more than ${formatCount(SVG_LIMITS.expandedElements)} elements once <use> references are resolved (at ${labelOf(node)}); the limit is ${formatCount(SVG_LIMITS.expandedElements)} — reduce how often <use> repeats content`,
      );
    }
  }

  private length(node: XNode, raw: string | undefined, axis: Axis): number | undefined {
    if (raw === undefined) return undefined;
    const parsed = parseLength(raw, axis, this.viewport);
    if (parsed === undefined) return undefined;
    if (parsed.relative) {
      this.report.add(
        "approximated",
        "relative-unit",
        node,
        "An em or ex length was converted with a fixed 16 px font size (ex: 8 px); use px values if the size matters.",
      );
    }
    return parsed.value;
  }

  private transformOf(node: XNode): Matrix {
    const raw = node.attrs.transform;
    if (raw === undefined) return IDENTITY;
    const parsed = parseTransform(raw);
    if (parsed === undefined) {
      this.report.add(
        "dropped",
        "transform-error",
        node,
        `The transform "${raw.trim().slice(0, 60)}" could not be parsed and was ignored; use matrix(), translate(), scale(), rotate(), skewX() or skewY().`,
      );
      return IDENTITY;
    }
    return parsed;
  }

  private reportEffects(node: XNode, decl: Record<string, string>): void {
    const set = (name: string): boolean => {
      const v = decl[name];
      return v !== undefined && v !== "" && v !== "none" && v !== "inherit";
    };
    if (set("filter")) {
      this.report.add(
        "dropped",
        "filter",
        node,
        "A filter is not applied and the element draws without it; use add_effect for blur, shadow or glow.",
      );
    }
    if (set("clip-path")) {
      this.report.add(
        "dropped",
        "clip-path",
        node,
        "A clip-path is not applied, so the content draws unclipped; use add_mask to clip a layer.",
      );
    }
    if (set("mask")) {
      this.report.add(
        "dropped",
        "mask",
        node,
        "A mask is not applied, so the content draws unmasked; use add_mask to mask a layer.",
      );
    }
    for (const name of unsupportedProperties(node)) this.report.addProperty(node, name);
    if (set("marker") || set("marker-start") || set("marker-mid") || set("marker-end")) {
      this.report.add(
        "dropped",
        "marker",
        node,
        "Markers (arrowheads, line end shapes) are not drawn; draw them as separate shapes.",
      );
    }
  }

  private hidden(node: XNode): [] {
    this.report.add(
      "dropped",
      "hidden",
      node,
      "A hidden element (display:none or visibility:hidden) was skipped; make it visible in the SVG if it should appear.",
    );
    return [];
  }

  // ---------------------------------------------------------------- walking

  convert(): SvgImportResult {
    const { root } = this.doc;
    const viewBox = this.readViewBox(root);
    const size = this.readSize(root, viewBox);
    this.viewport = { width: viewBox.width, height: viewBox.height };

    for (const node of this.doc.all) {
      if (node.tag === "style") {
        this.report.add(
          "dropped",
          "style-sheet",
          node,
          "<style> rules are not applied, so class and selector styling is lost; use presentation attributes (fill, stroke) or an inline style attribute.",
        );
      }
    }

    const par = this.readAspect(root);
    const sx0 = size.width / viewBox.width;
    const sy0 = size.height / viewBox.height;
    const scale: [number, number] =
      par === "none"
        ? [sx0, sy0]
        : par === "slice"
          ? [Math.max(sx0, sy0), Math.max(sx0, sy0)]
          : [Math.min(sx0, sy0), Math.min(sx0, sy0)];

    const tooSmall = (n: number): boolean => !(n >= MIN_SIZE && n <= MAX_MAGNITUDE);
    if (
      tooSmall(viewBox.width) ||
      tooSmall(viewBox.height) ||
      tooSmall(size.width) ||
      tooSmall(size.height) ||
      !scale.every((v) => Number.isFinite(v) && v > 0)
    ) {
      throw new SvgImportError("limit", NON_FINITE_MESSAGE);
    }

    this.active.add(root);
    const rootDecl = declared(root);
    const inh = computeInherited(root, {});
    const ctx: Ctx = { inh, pre: null, depth: 1, useDepth: 0, ctm: IDENTITY };
    this.reportEffects(root, rootDecl);
    const top: ShapeItem[] =
      rootDecl.display === "none"
        ? this.hidden(root)
        : this.group(root, ctx, { name: "Group", extra: null, elideWhenPlain: true }, (c) =>
            this.walkChildren(root, c),
          );
    // `group` returns items in document order; the layer lists them top-first.
    const contents = this.chunk(top.reverse());
    this.checkDepth(contents);
    this.checkViewportClip(root, viewBox, size, scale);

    const title = root.children
      .find((c) => c.tag === "title")
      ?.text.trim()
      .slice(0, 200);
    const result: SvgImportResult = {
      contents,
      viewBox,
      size,
      anchorPoint: [round6(viewBox.x + viewBox.width / 2), round6(viewBox.y + viewBox.height / 2)],
      scale: [round6(scale[0]), round6(scale[1])],
      report: { entries: this.report.sorted(), summary: this.summarize(contents) },
    };
    if (title !== undefined && title !== "") result.title = title;
    if (
      !allFinite(result.contents) ||
      !allFinite([result.scale, result.size, result.anchorPoint, result.viewBox])
    ) {
      throw new SvgImportError("limit", NON_FINITE_MESSAGE);
    }
    return result;
  }

  private readViewBox(root: XNode): SvgImportResult["viewBox"] {
    const raw = root.attrs.viewBox;
    if (raw !== undefined) {
      const nums = raw
        .trim()
        .split(/[\s,]+/)
        .map((s) => parseNumber(s));
      const [x, y, w, h] = nums;
      if (
        nums.length === 4 &&
        x !== undefined &&
        y !== undefined &&
        w !== undefined &&
        h !== undefined &&
        w > 0 &&
        h > 0
      ) {
        return { x, y, width: w, height: h };
      }
      this.report.add(
        "approximated",
        "invalid-viewbox",
        root,
        `The viewBox "${raw.trim().slice(0, 60)}" is not four numbers with a positive width and height, so it was ignored; write viewBox="minX minY width height".`,
      );
    }
    const w = this.absolute(root, root.attrs.width);
    const h = this.absolute(root, root.attrs.height);
    return { x: 0, y: 0, width: w ?? 300, height: h ?? 150 };
  }

  /** A width/height attribute against the default 300×150 viewport (used before the viewBox is known). */
  private absolute(node: XNode, raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const p = parseLength(raw, "x", { width: 300, height: 150 });
    if (p === undefined || !(p.value > 0)) return undefined;
    if (p.relative) this.length(node, raw, "x");
    return p.value;
  }

  private readSize(root: XNode, vb: SvgImportResult["viewBox"]): SvgImportResult["size"] {
    const viewport = { width: vb.width, height: vb.height };
    const get = (raw: string | undefined, axis: Axis): number | undefined => {
      if (raw === undefined) return undefined;
      const p = parseLength(raw, axis, viewport);
      if (p === undefined || !(p.value > 0)) return undefined;
      if (p.relative) this.length(root, raw, axis);
      return p.value;
    };
    const w = get(root.attrs.width, "x");
    const h = get(root.attrs.height, "y");
    const ratio = vb.width / vb.height;
    // One missing side follows the viewBox aspect ratio, as browsers do.
    return {
      width: round6(w ?? (h !== undefined ? h * ratio : vb.width)),
      height: round6(h ?? (w !== undefined ? w / ratio : vb.height)),
    };
  }

  private readAspect(root: XNode): "none" | "meet" | "slice" {
    const raw = root.attrs.preserveAspectRatio;
    if (raw === undefined) return "meet";
    const tokens = raw
      .trim()
      .split(/\s+/)
      .filter((t) => t !== "defer");
    const align = tokens[0] ?? "xMidYMid";
    const mode = tokens[1] ?? "meet";
    const valid =
      /^(none|x(Min|Mid|Max)Y(Min|Mid|Max))$/.test(align) && (mode === "meet" || mode === "slice");
    if (!valid) {
      this.report.add(
        "approximated",
        "preserve-aspect-ratio",
        root,
        `preserveAspectRatio="${raw.trim().slice(0, 40)}" is not valid, so the default xMidYMid meet was used.`,
      );
      return "meet";
    }
    if (align === "none") return "none";
    if (align !== "xMidYMid") {
      this.report.add(
        "approximated",
        "preserve-aspect-ratio",
        root,
        `preserveAspectRatio alignment "${align}" is centered (xMidYMid) instead; move the layer to reposition the content.`,
      );
    }
    return mode === "slice" ? "slice" : "meet";
  }

  private walkChildren(node: XNode, ctx: Ctx): ShapeItem[] {
    let children = node.children;
    if (node.tag === "switch") {
      if (children.some((c) => CONDITIONAL.some((a) => c.attrs[a] !== undefined))) {
        this.report.add(
          "approximated",
          "switch",
          node,
          "A <switch> with systemLanguage, requiredFeatures or requiredExtensions tests is not evaluated: its first child is used, which may differ from the branch a browser picks. Keep only the child you want.",
        );
      }
      children = children.slice(0, 1);
    }
    const out: ShapeItem[] = [];
    for (const child of children)
      for (const item of this.walkNode(child, ctx, false)) out.push(item);
    return out;
  }

  /** Items of one node, in document order (the parent reverses them). */
  private walkNode(node: XNode, ctx: Ctx, viaUse: boolean): ShapeItem[] {
    const tag = node.tag;
    if (PAINTED.has(tag)) return this.painted(node, ctx);
    switch (tag) {
      case "g":
      case "a":
      case "switch":
        return this.container(node, ctx, "Group", null);
      case "symbol":
        if (!viaUse) return [];
        if (node.attrs.viewBox !== undefined) {
          this.report.add(
            "approximated",
            "symbol-viewbox",
            node,
            "A <symbol> viewBox is ignored, so its content is not rescaled to the <use> size; scale the <use> with a transform instead.",
          );
        }
        return this.container(node, ctx, "Group", null);
      case "svg": {
        this.report.add(
          "approximated",
          "nested-svg",
          node,
          "A nested <svg> is treated as a group moved to its x and y; its width, height, viewBox and clipping are ignored.",
        );
        const x = this.length(node, node.attrs.x, "x") ?? 0;
        const y = this.length(node, node.attrs.y, "y") ?? 0;
        return this.container(node, ctx, "Group", [1, 0, 0, 1, x, y]);
      }
      case "use":
        return this.use(node, ctx);
      case "image":
        this.report.add(
          "dropped",
          "image",
          node,
          "Embedded images are not imported; upload the image with upload_asset and add an image layer.",
        );
        return [];
      case "foreignObject":
        this.report.add(
          "dropped",
          "foreign-object",
          node,
          "<foreignObject> (embedded HTML) is not imported; rebuild that content with layers.",
        );
        return [];
      case "style":
        return [];
      default:
    }
    if (TEXT.has(tag)) {
      this.report.add(
        "dropped",
        "text",
        node,
        "Text is not imported as shapes; recreate it with a text layer.",
      );
      return [];
    }
    if (ANIMATION.has(tag)) {
      this.reportAnimation(node);
      return [];
    }
    if (SILENT.has(tag)) return [];
    const colon = tag.indexOf(":");
    if (colon > 0 && EDITOR_PREFIXES.has(tag.slice(0, colon))) return [];
    this.report.add(
      "dropped",
      "unknown-element",
      node,
      `The element <${tag.slice(0, 40)}> is not supported and was skipped; redraw it with paths and basic shapes.`,
    );
    return [];
  }

  private reportAnimation(node: XNode): void {
    this.report.add(
      "dropped",
      "animation",
      node,
      "SVG animation (animate, animateTransform, animateMotion, set) is not imported; animate the layer with the intent tools instead.",
    );
  }

  // ---------------------------------------------------------------- groups

  private container(node: XNode, ctx: Ctx, name: string, extra: Matrix | null): ShapeItem[] {
    const decl = declared(node);
    if (decl.display === "none") return this.hidden(node);
    this.visit(node);
    this.reportEffects(node, decl);
    return this.group(node, ctx, { name, extra, elideWhenPlain: false }, (c) =>
      this.walkChildren(node, c),
    );
  }

  /**
   * Builds the group for a container-like node. Returns the group (or, past the depth limit, its
   * children dissolved into the parent) in document order. `build` produces the children for a context.
   */
  private group(
    node: XNode,
    ctx: Ctx,
    opts: { name: string; extra: Matrix | null; elideWhenPlain: boolean },
    build: (childCtx: Ctx) => ShapeItem[],
  ): ShapeItem[] {
    const decl = declared(node);
    const inh = computeInherited(node, ctx.inh);
    let own = this.transformOf(node);
    if (opts.extra !== null) own = multiply(own, opts.extra);
    const local = ctx.pre === null ? own : multiply(ctx.pre, own);
    const opacity = parseOpacity(decl.opacity) ?? 1;
    const canGroup = ctx.depth <= MAX_GROUP_NESTING;
    const dec = canGroup ? decompose(local) : null;
    const bakedMatrix = dec === null && !isIdentity(local) ? local : null;
    if (bakedMatrix !== null && canGroup) {
      this.report.add(
        "flattened",
        "baked-transform",
        node,
        "A transform that cannot be a layer transform (singular, or skewed beyond 85 degrees) was baked into the geometry of the shapes inside; their transform properties are not editable.",
      );
    }
    const childCtx: Ctx = {
      inh,
      pre: dec !== null ? null : bakedMatrix,
      depth: canGroup ? ctx.depth + 1 : ctx.depth,
      useDepth: ctx.useDepth,
      ctm: multiply(ctx.ctm, own),
    };
    const before = this.paintedCount;
    this.active.add(node);
    const children = build(childCtx);
    this.active.delete(node);
    if (children.length === 0) return [];
    if (!canGroup) {
      this.report.add(
        "flattened",
        "group-depth",
        node,
        `Groups nested deeper than ${MAX_GROUP_NESTING} levels were dissolved into their parent (their transform is baked in and their opacity is lost); flatten the nesting in the SVG.`,
      );
      return children;
    }
    if (opts.elideWhenPlain && dec !== null && isIdentity(local) && opacity >= 1) return children;
    if (opacity < 1 && this.paintedCount - before > 1) {
      this.report.add(
        "approximated",
        "group-opacity",
        node,
        "A group's opacity is applied to each shape separately, so overlapping shapes show through each other; flatten the shapes into one path or fade the whole layer instead.",
      );
    }
    const group: GroupItem = {
      type: "group",
      id: this.newId("group", node.attrs.id),
      name: (node.attrs.id ?? opts.name).slice(0, 200) || opts.name,
      transform: transformValues(dec, opacity),
      items: children.slice().reverse(),
    };
    group.items = this.chunk(group.items);
    return [group];
  }

  private use(node: XNode, ctx: Ctx): ShapeItem[] {
    const decl = declared(node);
    if (decl.display === "none") return this.hidden(node);
    this.visit(node);
    const href = (node.attrs.href ?? node.attrs["xlink:href"])?.trim();
    const target = href?.startsWith("#") ? this.doc.ids.get(href.slice(1)) : undefined;
    if (target === undefined) {
      this.report.add(
        "dropped",
        "missing-reference",
        node,
        `A <use> points to ${href === undefined || href === "" ? "nothing" : `"${href.slice(0, 60)}"`}, which is not an element in this SVG, so it was skipped.`,
      );
      return [];
    }
    if (this.active.has(target)) {
      this.report.add(
        "dropped",
        "missing-reference",
        node,
        `A <use> references "${href}", which contains the <use> itself (a reference cycle), so it was skipped.`,
      );
      return [];
    }
    if (ctx.useDepth >= SVG_LIMITS.useDepth) {
      throw new SvgImportError(
        "limit",
        `<use> elements nest more than ${SVG_LIMITS.useDepth} levels deep (at ${labelOf(node)}); the limit is ${SVG_LIMITS.useDepth} — inline some of the references`,
      );
    }
    this.reportEffects(node, decl);
    const x = this.length(node, node.attrs.x, "x") ?? 0;
    const y = this.length(node, node.attrs.y, "y") ?? 0;
    return this.group(
      node,
      ctx,
      { name: "use", extra: x === 0 && y === 0 ? null : [1, 0, 0, 1, x, y], elideWhenPlain: false },
      (c) => this.walkNode(target, { ...c, useDepth: c.useDepth + 1 }, true),
    );
  }

  // ---------------------------------------------------------------- painted elements

  private painted(node: XNode, ctx: Ctx): ShapeItem[] {
    const decl = declared(node);
    if (decl.display === "none") return this.hidden(node);
    const inh = computeInherited(node, ctx.inh);
    const visibility = inh.visibility;
    if (visibility === "hidden" || visibility === "collapse") return this.hidden(node);
    this.visit(node);
    this.reportEffects(node, decl);
    for (const child of node.children) if (ANIMATION.has(child.tag)) this.reportAnimation(child);

    const geometry = this.geometryOf(node);
    if (geometry === null) return [];
    const isOpenShape = node.tag === "line" || node.tag === "polyline";
    const bbox = geometryBbox(geometry);

    const own = this.transformOf(node);
    const local = ctx.pre === null ? own : multiply(ctx.pre, own);
    const dec = decompose(local);
    const bake = dec === null ? local : null;
    const elementCtm = multiply(ctx.ctm, own);

    const fillPaint = isOpenShape
      ? null
      : this.resolvePaint(node, inh.fill ?? "black", inh, bbox, bake);
    const strokePaint = this.resolvePaint(node, inh.stroke ?? "none", inh, bbox, bake);
    if (fillPaint === null && strokePaint === null) return [];

    let contours: Contour[] | null = null;
    if (bake !== null) {
      contours = contoursOf(geometry).map((c) => transformContour(c, bake));
      if (!isIdentity(bake)) {
        this.report.add(
          "flattened",
          "baked-transform",
          node,
          "A transform that cannot be a layer transform (singular, or skewed beyond 85 degrees) was baked into the shape's geometry; its transform properties are not editable.",
        );
      }
    } else if (geometry.kind === "paths") contours = geometry.contours;

    const capRaw = inh["stroke-linecap"]?.trim();
    if (
      strokePaint !== null &&
      (capRaw === "round" || capRaw === "square") &&
      contours?.some(isZeroLength) === true
    ) {
      this.report.add(
        "dropped",
        "zero-length-cap",
        node,
        "A zero-length subpath with a round or square cap draws a dot in SVG but is not drawn here; use a small circle or a very short line instead.",
      );
    }
    const geomItems: ShapeItem[] = [];
    if (contours !== null) {
      for (const c of contours) {
        if (c.vertices.length < 2) continue;
        if (c.vertices.length > MAX_VERTICES_PER_PATH) {
          throw new SvgImportError(
            "limit",
            `${labelOf(node)} has a subpath with ${formatCount(c.vertices.length)} vertices; the limit is ${formatCount(MAX_VERTICES_PER_PATH)} per path — simplify the path or split it into several paths`,
          );
        }
        this.vertexTotal += c.vertices.length;
        geomItems.push({
          type: "path",
          id: this.newId("path"),
          name: node.tag,
          path: constant(roundContour(c)),
        });
      }
    } else if (geometry.kind === "rect") {
      geomItems.push({
        type: "rect",
        id: this.newId("rect"),
        name: node.tag,
        position: constant([
          round6(geometry.x + geometry.width / 2),
          round6(geometry.y + geometry.height / 2),
        ]),
        size: constant([round6(geometry.width), round6(geometry.height)]),
        cornerRadius: constant(round6(geometry.radius)),
      });
    } else if (geometry.kind === "ellipse") {
      geomItems.push({
        type: "ellipse",
        id: this.newId("ellipse"),
        name: node.tag,
        position: constant([round6(geometry.cx), round6(geometry.cy)]),
        size: constant([round6(2 * geometry.rx), round6(2 * geometry.ry)]),
      });
    }
    if (this.vertexTotal > SVG_LIMITS.vertices) {
      throw new SvgImportError(
        "limit",
        `The SVG has more than ${formatCount(SVG_LIMITS.vertices)} path vertices (at ${labelOf(node)}); the limit is ${formatCount(SVG_LIMITS.vertices)} — simplify the paths`,
      );
    }
    if (geomItems.length === 0) return [];

    const items: ShapeItem[] = geomItems;
    if (strokePaint !== null) {
      const stroke = this.strokeItem(node, inh, strokePaint, decl, bake);
      if (stroke !== null) items.push(stroke);
    }
    if (fillPaint !== null) {
      items.push({
        type: "fill",
        id: this.newId("fill"),
        name: "Fill",
        paint: fillPaint,
        opacity: constant(round6(parseOpacity(inh["fill-opacity"]) ?? 1)),
        rule: inh["fill-rule"]?.trim() === "evenodd" ? "evenodd" : "nonzero",
      });
    }
    const hasFill = items.some((i) => i.type === "fill");
    const hasStroke = items.some((i) => i.type === "stroke");
    if (!hasFill && !hasStroke) return [];

    const opacity = parseOpacity(decl.opacity) ?? 1;
    if (opacity < 1 && hasFill && hasStroke) {
      this.report.add(
        "approximated",
        "element-opacity",
        node,
        "An element with both fill and stroke and an opacity below 1 is composited as one in SVG, but here the opacity applies to the fill and stroke separately, so their overlap shows; use fill and stroke opacity or a single paint.",
      );
    }
    this.paintedCount++;
    this.extendContentBox(geometry, elementCtm);
    return [
      {
        type: "group",
        id: this.newId("group", node.attrs.id),
        name: (node.attrs.id ?? node.tag).slice(0, 200) || node.tag,
        transform: transformValues(dec, opacity),
        items,
      },
    ];
  }

  /** Grows the content box (root user space) by the shape's exact outline, strokes excluded. */
  private extendContentBox(geometry: Geometry, ctm: Matrix): void {
    const box = bboxOfContours(contoursOf(geometry).map((c) => transformContour(c, ctm)));
    if (box === null) return;
    const b = this.contentBox;
    this.contentBox =
      b === null
        ? [box.x, box.y, box.x + box.width, box.y + box.height]
        : [
            Math.min(b[0], box.x),
            Math.min(b[1], box.y),
            Math.max(b[2], box.x + box.width),
            Math.max(b[3], box.y + box.height),
          ];
  }

  /** Reports content outside the visible viewport region, which browsers clip and we do not. */
  private checkViewportClip(
    root: XNode,
    viewBox: SvgImportResult["viewBox"],
    size: SvgImportResult["size"],
    scale: [number, number],
  ): void {
    const b = this.contentBox;
    if (b === null) return;
    const cx = viewBox.x + viewBox.width / 2;
    const cy = viewBox.y + viewBox.height / 2;
    const halfW = size.width / (2 * scale[0]);
    const halfH = size.height / (2 * scale[1]);
    const tolX = 1e-4 * halfW;
    const tolY = 1e-4 * halfH;
    if (
      b[0] < cx - halfW - tolX ||
      b[2] > cx + halfW + tolX ||
      b[1] < cy - halfH - tolY ||
      b[3] > cy + halfH + tolY
    ) {
      this.report.add(
        "approximated",
        "viewport-clip",
        root,
        "Some content lies outside the SVG's visible area, which browsers clip but Kynimo draws; add_mask can clip the layer, or move or delete the overflowing shapes.",
      );
    }
  }

  private geometryOf(node: XNode): Geometry | null {
    const a = node.attrs;
    const L = (name: string, axis: Axis): number => this.length(node, a[name], axis) ?? 0;
    switch (node.tag) {
      case "path": {
        const d = a.d;
        if (d === undefined || d.trim() === "") return null;
        const parsed = parsePathData(d);
        if (parsed.error) {
          this.report.add(
            "approximated",
            "path-data-error",
            node,
            "The path data has a syntax error; everything before the error was kept (as browsers do) and the rest was dropped. Check the d attribute.",
          );
        }
        return { kind: "paths", contours: parsed.contours };
      }
      case "rect": {
        const width = L("width", "x");
        const height = L("height", "y");
        if (!(width > 0 && height > 0)) return null;
        const rxRaw = a.rx === "auto" ? undefined : this.length(node, a.rx, "x");
        const ryRaw = a.ry === "auto" ? undefined : this.length(node, a.ry, "y");
        let rx = Math.max(0, rxRaw ?? ryRaw ?? 0);
        let ry = Math.max(0, ryRaw ?? rxRaw ?? 0);
        rx = Math.min(rx, width / 2);
        ry = Math.min(ry, height / 2);
        const x = L("x", "x");
        const y = L("y", "y");
        if (Math.abs(rx - ry) < 1e-9) return { kind: "rect", x, y, width, height, radius: rx };
        return { kind: "paths", contours: [roundedRectContour(x, y, width, height, rx, ry)] };
      }
      case "circle": {
        const r = L("r", "r");
        if (!(r > 0)) return null;
        return { kind: "ellipse", cx: L("cx", "x"), cy: L("cy", "y"), rx: r, ry: r };
      }
      case "ellipse": {
        const rxRaw = a.rx === "auto" ? undefined : this.length(node, a.rx, "x");
        const ryRaw = a.ry === "auto" ? undefined : this.length(node, a.ry, "y");
        const rx = rxRaw ?? ryRaw ?? 0;
        const ry = ryRaw ?? rxRaw ?? 0;
        if (!(rx > 0 && ry > 0)) return null;
        return { kind: "ellipse", cx: L("cx", "x"), cy: L("cy", "y"), rx, ry };
      }
      case "line": {
        const x1 = L("x1", "x");
        const y1 = L("y1", "y");
        const x2 = L("x2", "x");
        const y2 = L("y2", "y");
        return {
          kind: "paths",
          contours: [
            {
              closed: false,
              vertices: [
                { point: [x1, y1], inTangent: [0, 0], outTangent: [0, 0] },
                { point: [x2, y2], inTangent: [0, 0], outTangent: [0, 0] },
              ],
            },
          ],
        };
      }
      default: {
        // polyline, polygon
        const raw = a.points ?? "";
        const numbers = [...raw.matchAll(new RegExp(NUMBER_SOURCE, "g"))].map((m) => Number(m[0]));
        const leftover = raw.replace(new RegExp(NUMBER_SOURCE, "g"), "").replace(/[\s,]/g, "");
        if (
          leftover !== "" ||
          numbers.length % 2 !== 0 ||
          numbers.some((n) => !Number.isFinite(n))
        ) {
          this.report.add(
            "approximated",
            "path-data-error",
            node,
            "The points list is not an even list of numbers; the incomplete or invalid part was dropped. Check the points attribute.",
          );
        }
        const vertices: Contour["vertices"] = [];
        for (let i = 0; i + 1 < numbers.length; i += 2) {
          const x = numbers[i];
          const y = numbers[i + 1];
          if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y))
            break;
          vertices.push({ point: [x, y], inTangent: [0, 0], outTangent: [0, 0] });
        }
        if (vertices.length < 2) return null;
        return { kind: "paths", contours: [{ closed: node.tag === "polygon", vertices }] };
      }
    }
  }

  // ---------------------------------------------------------------- paints

  private resolvePaint(
    node: XNode,
    raw: string,
    inh: Inherited,
    bbox: Bbox | null,
    bake: Matrix | null,
  ): Paint | null {
    const value = raw.trim();
    const current = currentColorOf(inh);
    if (/^url\(/i.test(value)) {
      const u = parseUrlPaint(value);
      const ref = u.ref;
      const fallbackRaw = u.rest;
      const fallback = fallbackRaw === "" ? undefined : parseColor(fallbackRaw, current);
      const fallbackPaint = (): Paint | null =>
        fallback === undefined || fallback === "none"
          ? null
          : { type: "solid", color: constant(fallback) };
      const target = ref.startsWith("#") ? this.doc.ids.get(ref.slice(1)) : undefined;
      if (
        target !== undefined &&
        (target.tag === "linearGradient" || target.tag === "radialGradient")
      ) {
        return buildGradient(target, {
          ids: this.doc.ids,
          viewport: this.viewport,
          report: this.report,
          element: node,
          currentColor: current,
          bbox,
          bake,
        });
      }
      if (target !== undefined && target.tag === "pattern") {
        this.report.add(
          "dropped",
          "pattern",
          node,
          "Pattern paints are not supported, so the shape uses its fallback color or no paint; replace the pattern with shapes.",
        );
        return fallbackPaint();
      }
      const paint = fallbackPaint();
      if (paint === null) {
        this.report.add(
          "dropped",
          "missing-reference",
          node,
          `A paint references "${ref.slice(0, 60)}", which is not a gradient in this SVG, so it was treated as none.`,
        );
      }
      return paint;
    }
    const color = parseColor(value, current);
    if (color === undefined) {
      this.report.add(
        "dropped",
        "invalid-color",
        node,
        `The color "${value.slice(0, 60)}" is not a color Kynimo understands, so it was treated as none; use #rrggbb, rgb(), hsl() or a CSS color name.`,
      );
      return null;
    }
    if (color === "none") return null;
    return { type: "solid", color: constant(color) };
  }

  private strokeItem(
    node: XNode,
    inh: Inherited,
    paint: Paint,
    decl: Record<string, string>,
    bake: Matrix | null,
  ): Item<"stroke"> | null {
    let factor = 1;
    if (bake !== null) {
      factor = Math.sqrt(Math.abs(determinant(bake)));
      if (!isSimilarity(bake) && !isIdentity(bake)) {
        this.report.add(
          "approximated",
          "non-uniform-stroke",
          node,
          "A stroke on a shape with a baked non-uniform or skewed transform was given a uniform width (scaled by the square root of the transform's determinant), so it no longer varies around the shape.",
        );
      }
    }
    if (decl["vector-effect"] === "non-scaling-stroke") {
      this.report.add(
        "approximated",
        "vector-effect",
        node,
        "vector-effect: non-scaling-stroke is ignored, so the stroke width scales with the layer; adjust the stroke width after scaling.",
      );
    }
    const widthRaw = inh["stroke-width"];
    let width = widthRaw === undefined ? 1 : (this.length(node, widthRaw, "r") ?? 1);
    if (width < 0) width = 1;
    width *= factor;
    if (!(width > 0)) return null;

    const capRaw = inh["stroke-linecap"]?.trim();
    const cap = capRaw === "round" || capRaw === "square" ? capRaw : "butt";
    const joinRaw = inh["stroke-linejoin"]?.trim();
    let join: "miter" | "round" | "bevel" = "miter";
    if (joinRaw === "round" || joinRaw === "bevel") join = joinRaw;
    else if (joinRaw === "miter-clip" || joinRaw === "arcs") {
      this.report.add(
        "approximated",
        "line-join",
        node,
        `stroke-linejoin: ${joinRaw} is drawn as a plain miter join.`,
      );
    }
    const limitRaw = inh["stroke-miterlimit"];
    const limit = limitRaw === undefined ? undefined : parseNumber(limitRaw);
    const miterLimit = limit !== undefined && limit >= 1 ? limit : 4;

    let dashes: number[] = [];
    const dashRaw = inh["stroke-dasharray"]?.trim();
    if (dashRaw !== undefined && dashRaw !== "" && dashRaw !== "none") {
      const parts = dashRaw.split(/[\s,]+/).filter((s) => s !== "");
      const values = parts.map((p) => this.length(node, p, "r"));
      if (values.some((v) => v === undefined || v < 0)) {
        this.report.add(
          "approximated",
          "dash-invalid",
          node,
          "A stroke-dasharray with a negative or invalid value was ignored, so the stroke is solid; use positive dash lengths.",
        );
      } else {
        let list = values as number[];
        if (list.length % 2 === 1) list = [...list, ...list];
        if (list.reduce((s, v) => s + v, 0) > 0) {
          if (list.length > 16) {
            this.report.add(
              "approximated",
              "dash-count",
              node,
              `A stroke-dasharray has ${list.length} values; only the first 16 were kept. Use a shorter dash pattern.`,
            );
            list = list.slice(0, 16);
          }
          dashes = list.map((v) => round6(v * factor));
        }
      }
    }
    const offsetRaw = inh["stroke-dashoffset"];
    const offset =
      (offsetRaw === undefined ? 0 : (this.length(node, offsetRaw, "r") ?? 0)) * factor;

    return {
      type: "stroke",
      id: this.newId("stroke"),
      name: "Stroke",
      paint,
      opacity: constant(round6(parseOpacity(inh["stroke-opacity"]) ?? 1)),
      width: constant(round6(width)),
      cap,
      join,
      miterLimit: round6(miterLimit),
      dashes,
      dashOffset: constant(round6(offset)),
    };
  }

  // ---------------------------------------------------------------- output helpers

  /** Wraps item lists longer than the schema allows in plain groups, keeping the order. */
  private chunk(items: ShapeItem[]): ShapeItem[] {
    let current = items;
    while (current.length > MAX_SHAPE_ITEMS) {
      const next: ShapeItem[] = [];
      for (let i = 0; i < current.length; i += MAX_SHAPE_ITEMS) {
        next.push({
          type: "group",
          id: this.newId("group"),
          name: "Group",
          transform: transformValues(decompose(IDENTITY), 1),
          items: current.slice(i, i + MAX_SHAPE_ITEMS),
        });
      }
      current = next;
    }
    return current;
  }

  private checkDepth(contents: ShapeItem[]): void {
    const stack: { item: ShapeItem; depth: number }[] = contents.map((item) => ({
      item,
      depth: 1,
    }));
    while (stack.length > 0) {
      const top = stack.pop();
      if (top === undefined || top.item.type !== "group") continue;
      if (top.depth > MAX_GROUP_DEPTH) {
        throw new SvgImportError(
          "limit",
          `The SVG nests groups more than ${MAX_GROUP_DEPTH} levels deep after conversion; the limit is ${MAX_GROUP_DEPTH} — flatten the groups`,
        );
      }
      for (const child of top.item.items) stack.push({ item: child, depth: top.depth + 1 });
    }
  }

  private summarize(contents: ShapeItem[]): SvgImportResult["report"]["summary"] {
    const summary = {
      elements: this.doc.elementCount,
      groups: 0,
      paths: 0,
      fills: 0,
      strokes: 0,
      vertices: 0,
    };
    const stack: ShapeItem[] = [...contents];
    while (stack.length > 0) {
      const item = stack.pop();
      if (item === undefined) continue;
      switch (item.type) {
        case "group":
          summary.groups++;
          for (const child of item.items) stack.push(child);
          break;
        case "path":
          summary.paths++;
          if ("value" in item.path) summary.vertices += item.path.value.vertices.length;
          break;
        case "rect":
        case "ellipse":
          summary.paths++;
          break;
        case "fill":
          summary.fills++;
          break;
        case "stroke":
          summary.strokes++;
          break;
        default:
      }
    }
    return summary;
  }
}

/** A contour that draws a dot under round or square caps: every point and tangent coincides. */
function isZeroLength(c: Contour): boolean {
  const first = c.vertices[0];
  if (first === undefined || (c.vertices.length < 2 && !c.closed)) return false;
  return c.vertices.every(
    (v) =>
      v.point[0] === first.point[0] &&
      v.point[1] === first.point[1] &&
      v.inTangent[0] === 0 &&
      v.inTangent[1] === 0 &&
      v.outTangent[0] === 0 &&
      v.outTangent[1] === 0,
  );
}

function transformValues(
  dec: ReturnType<typeof decompose>,
  opacity: number,
): GroupItem["transform"] {
  const d = dec ?? {
    position: [0, 0] as [number, number],
    rotation: 0,
    skew: 0,
    scale: [1, 1] as [number, number],
  };
  return {
    anchorPoint: constant([0, 0]),
    position: constant([round6(d.position[0]), round6(d.position[1])]),
    scale: constant([round6(d.scale[0]), round6(d.scale[1])]),
    rotation: constant(round6(d.rotation)),
    skew: constant(round6(d.skew)),
    opacity: constant(round6(opacity)),
  };
}
