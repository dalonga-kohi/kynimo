import { type ShapeItem, ShapeLayerSchema } from "@kynimo/scene";
import { expect } from "vitest";
import { importSvg, type SvgImportResult } from "./index.js";

const contentsSchema = ShapeLayerSchema.shape.contents;

/** Imports, asserts the contents are a valid shape layer, and checks ids are unique. */
export function importValid(source: string): SvgImportResult {
  const result = importSvg(source);
  const parsed = contentsSchema.safeParse(result.contents);
  expect(
    parsed.success,
    parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)),
  ).toBe(true);
  const ids = flatten(result.contents).map((i) => i.id);
  expect(new Set(ids).size).toBe(ids.length);
  return result;
}

/** Every item in the tree, parents before children. */
export function flatten(items: ShapeItem[]): ShapeItem[] {
  const out: ShapeItem[] = [];
  const stack = [...items].reverse();
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) continue;
    out.push(item);
    if (item.type === "group") for (const c of [...item.items].reverse()) stack.push(c);
  }
  return out;
}

export function entry(result: SvgImportResult, feature: string) {
  return result.report.entries.find((e) => e.feature === feature);
}

export const svg = (body: string, attrs = 'viewBox="0 0 100 100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`;

/** A 24×24 icon: a ring (evenodd hole) and a dot. */
export const ICON = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <title>Record</title>
  <path id="ring" fill-rule="evenodd" fill="#1a1a1a" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12z"/>
  <circle cx="12" cy="12" r="3" fill="red"/>
</svg>`;

/** A logo with a gradient mark, nested groups, a <use> and a stroke. */
export const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100" width="400" height="200">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ff7a18"/>
      <stop offset="100%" stop-color="#af002d" stop-opacity=".8"/>
    </linearGradient>
    <radialGradient id="glow" cx="50" cy="50" r="40" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="white"/>
      <stop offset="1" stop-color="white" stop-opacity="0"/>
    </radialGradient>
    <g id="dot"><circle r="4" fill="url(#glow)"/></g>
  </defs>
  <g id="mark" transform="translate(20 10)">
    <rect x="0" y="0" width="60" height="60" rx="12" fill="url(#sky)" stroke="#222" stroke-width="2"/>
    <g transform="scale(0.5) translate(20 20)">
      <path d="M0 40 L30 0 L60 40 Z" fill="white"/>
    </g>
  </g>
  <use xlink:href="#dot" x="150" y="50"/>
  <polyline points="100,90 120,80 140,90" fill="none" stroke="#555" stroke-dasharray="4 2" stroke-linecap="round"/>
</svg>`;

/** An Inkscape-style export: editor metadata, a <style> sheet, and transforms. */
export const INKSCAPE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:svg="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="210mm" height="297mm" viewBox="0 0 210 297" version="1.1" id="svg8">
  <defs id="defs2"><style>.cls-1{fill:#ff0000}</style></defs>
  <sodipodi:namedview id="base" pagecolor="#ffffff" inkscape:zoom="0.7"/>
  <metadata id="metadata5"><rdf:RDF><cc:Work rdf:about=""><dc:title>Poster</dc:title></cc:Work></rdf:RDF></metadata>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1" transform="translate(-10,-20)">
    <path class="cls-1" style="fill:#336699;fill-opacity:1;stroke:#000000;stroke-width:0.264583px;stroke-linejoin:miter" d="m 50,50 h 100 v 60 H 50 z" id="path10" transform="rotate(-10)"/>
    <ellipse style="opacity:0.8;fill:none;stroke:#cc0000;stroke-width:1.5" id="ellipse12" cx="105" cy="148.5" rx="40" ry="25" clip-path="url(#clip1)"/>
    <text id="text14" x="20" y="30"><tspan>Hello</tspan></text>
  </g>
</svg>`;
