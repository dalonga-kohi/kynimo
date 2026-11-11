import { XMLParser, XMLValidator } from "fast-xml-parser";
import { formatCount, SVG_LIMITS, SvgImportError } from "./types.js";

export interface XNode {
  /** Local tag name: an `svg:` prefix is dropped, other prefixes (`inkscape:`) stay. */
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Concatenated direct text. */
  text: string;
  parent: XNode | null;
  /** 1-based position among siblings with the same tag. */
  index: number;
}

export interface ParsedSvg {
  root: XNode;
  elementCount: number;
  /** First element per id, in document order. */
  ids: Map<string, XNode>;
  /** Every element in document order, root first. */
  all: XNode[];
}

/** UTF-8 byte length without allocating, and without Node globals. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  // Only the five XML built-ins and numeric references. DOCTYPE entities are rejected up front.
  processEntities: true,
  // An object (not `true`) keeps the table to the five XML built-ins while enabling numeric
  // character references like &#65;. The typings only declare a boolean, hence the cast.
  htmlEntities: { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as unknown as boolean,
  removeNSPrefix: false,
  allowBooleanAttributes: true,
  // The parser's own nesting guard; keeps its recursion-free stack bounded at our limit.
  maxNestedTags: SVG_LIMITS.xmlDepth,
});

const MAX_LABEL_PART = 60;
const clip = (s: string): string =>
  s.length > MAX_LABEL_PART ? `${s.slice(0, MAX_LABEL_PART)}…` : s;

/**
 * Label for the report: `tag#id`, else the tag with its 1-based index path (`g[2] > path[1]`).
 * Ids and tags are cut at 60 characters; the index path is at most 256 parts deep.
 */
export function labelOf(node: XNode): string {
  const id = node.attrs.id;
  if (id !== undefined && id !== "") return `${clip(node.tag)}#${clip(id)}`;
  if (node.parent === null) return clip(node.tag);
  const parts: string[] = [];
  for (let n: XNode | null = node; n !== null && n.parent !== null; n = n.parent) {
    parts.push(`${clip(n.tag)}[${n.index}]`);
  }
  return parts.reverse().join(" > ");
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** Validates and parses SVG text into a plain tree. Throws `SvgImportError`. */
export function parseSvg(source: string): ParsedSvg {
  const bytes = utf8Length(source);
  if (bytes > SVG_LIMITS.sourceBytes) {
    throw new SvgImportError(
      "too-large",
      `SVG is ${formatCount(bytes)} bytes; the limit is ${formatCount(SVG_LIMITS.sourceBytes)} — simplify it or split it into several files`,
    );
  }
  if (source.trim() === "")
    throw new SvgImportError("not-svg", "The input is empty; pass SVG markup");
  // Deliberately also matches "<!ENTITY" inside comments and CDATA: a false positive is the safe default.
  if (/<!ENTITY/i.test(source)) {
    throw new SvgImportError(
      "entities",
      "The SVG declares XML entities in its DOCTYPE, which is not supported; remove the <!ENTITY …> declarations",
    );
  }
  const valid = XMLValidator.validate(source);
  if (valid !== true) {
    throw new SvgImportError(
      "malformed",
      `The SVG is not well-formed XML (line ${valid.err.line}): ${valid.err.msg}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parser.parse(source);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/nested/i.test(message)) {
      throw new SvgImportError(
        "limit",
        `SVG elements nest deeper than the limit of ${SVG_LIMITS.xmlDepth} levels — flatten the groups`,
      );
    }
    throw new SvgImportError("malformed", `The SVG could not be parsed: ${message}`);
  }
  if (!Array.isArray(parsed)) throw new SvgImportError("not-svg", "The input has no root element");

  const tagOf = (entry: Record<string, unknown>): string | undefined =>
    Object.keys(entry).find((k) => k !== ":@");
  const strip = (tag: string): string => (tag.startsWith("svg:") ? tag.slice(4) : tag);
  const make = (entry: Record<string, unknown>, tag: string, parent: XNode | null): XNode => {
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    const raw = asRecord(entry[":@"]);
    if (raw !== undefined) {
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith("@_")) attrs[k.slice(2)] = String(v);
      }
    }
    const local = strip(tag);
    let index = 1;
    if (parent !== null) {
      for (const sibling of parent.children) if (sibling.tag === local) index++;
    }
    return { tag: local, attrs, children: [], text: "", parent, index };
  };

  let rootEntry: Record<string, unknown> | undefined;
  let rootTag = "";
  for (const e of parsed) {
    const rec = asRecord(e);
    const t = rec === undefined ? undefined : tagOf(rec);
    if (rec !== undefined && t !== undefined && !t.startsWith("?") && !t.startsWith("#")) {
      rootEntry = rec;
      rootTag = t;
      break;
    }
  }
  if (rootEntry === undefined || strip(rootTag) !== "svg") {
    throw new SvgImportError(
      "not-svg",
      `The input is not an SVG document (its root element is ${rootEntry === undefined ? "missing" : `<${rootTag}>`}); pass markup that starts with <svg>`,
    );
  }

  const root = make(rootEntry, rootTag, null);
  let count = 1;
  const ids = new Map<string, XNode>();
  const all: XNode[] = [root];
  const rootId = root.attrs.id;
  if (rootId !== undefined) ids.set(rootId, root);
  const rootChildren = rootEntry[rootTag];
  const stack: { entries: unknown[]; i: number; node: XNode }[] = [
    { entries: Array.isArray(rootChildren) ? rootChildren : [], i: 0, node: root },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    if (frame.i >= frame.entries.length) {
      stack.pop();
      continue;
    }
    const rec = asRecord(frame.entries[frame.i++]);
    if (rec === undefined) continue;
    const key = tagOf(rec);
    if (key === undefined) continue;
    if (key === "#text") {
      frame.node.text += String(rec[key] ?? "");
      continue;
    }
    if (key.startsWith("?") || key.startsWith("!") || key.startsWith("#")) continue;
    count++;
    if (count > SVG_LIMITS.elements) {
      throw new SvgImportError(
        "limit",
        `SVG has more than ${formatCount(SVG_LIMITS.elements)} elements; the limit is ${formatCount(SVG_LIMITS.elements)} — simplify or split it`,
      );
    }
    if (stack.length >= SVG_LIMITS.xmlDepth) {
      throw new SvgImportError(
        "limit",
        `SVG elements nest deeper than the limit of ${SVG_LIMITS.xmlDepth} levels — flatten the groups`,
      );
    }
    const child = make(rec, key, frame.node);
    frame.node.children.push(child);
    all.push(child);
    const id = child.attrs.id;
    if (id !== undefined && id !== "" && !ids.has(id)) ids.set(id, child);
    const inner = rec[key];
    stack.push({ entries: Array.isArray(inner) ? inner : [], i: 0, node: child });
  }
  return { root, elementCount: count, ids, all };
}
