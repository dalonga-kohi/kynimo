const NAMED_SOURCE =
  "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32";

const NAMED = new Map<string, string>();
{
  const parts = NAMED_SOURCE.split(" ");
  for (let i = 0; i + 1 < parts.length; i += 2) NAMED.set(parts[i] ?? "", `#${parts[i + 1]}`);
}

/** Number of named CSS colors known (without `transparent`). */
export const NAMED_COLOR_COUNT = NAMED.size;

const hex2 = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");

const rgba = (r: number, g: number, b: number, a: number): string => {
  const alpha = Math.max(0, Math.min(1, a));
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha >= 1 ? "" : hex2(alpha * 255)}`;
};

const FLOAT = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";

/** `12`, `50%`: a component as a fraction of `range` when a percentage. */
function component(s: string, range: number): number | undefined {
  const m = new RegExp(`^(${FLOAT})(%?)$`).exec(s);
  if (m === null) return undefined;
  const v = Number(m[1]);
  return m[2] === "%" ? (v / 100) * range : v;
}

function alphaOf(s: string | undefined): number | undefined {
  if (s === undefined) return 1;
  const v = component(s, 1);
  return v === undefined ? undefined : Math.max(0, Math.min(1, v));
}

function hueOf(s: string): number | undefined {
  const m = new RegExp(`^(${FLOAT})(deg|rad|grad|turn)?$`).exec(s);
  if (m === null) return undefined;
  const v = Number(m[1]);
  switch (m[2]) {
    case "rad":
      return (v * 180) / Math.PI;
    case "grad":
      return v * 0.9;
    case "turn":
      return v * 360;
    default:
      return v;
  }
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = Math.max(0, Math.min(1, s));
  const lig = Math.max(0, Math.min(1, l));
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const channel = (t0: number): number => {
    const t = ((t0 % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255];
}

/**
 * Parses a CSS color to lowercase `#rrggbb` / `#rrggbbaa`. `"none"` for `none`; `undefined` when
 * the value is not a color. `currentColor` resolves to `current` (itself already a hex color).
 */
export function parseColor(input: string, current = "#000000"): string | "none" | undefined {
  const s = input.trim().toLowerCase();
  if (s === "none") return "none";
  if (s === "currentcolor") return current;
  if (s === "transparent") return "#00000000";
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return undefined;
    if (h.length === 3 || h.length === 4) {
      return `#${[...h].map((c) => c + c).join("")}`;
    }
    if (h.length === 6 || h.length === 8) return `#${h}`;
    return undefined;
  }
  const fn = /^(rgba?|hsla?)\(\s*(.*?)\s*\)$/.exec(s);
  if (fn !== null) {
    const name = fn[1] ?? "";
    const body = fn[2] ?? "";
    let parts: string[];
    let alpha: string | undefined;
    if (body.includes("/")) {
      const [colorPart, alphaPart, ...rest] = body.split("/");
      if (rest.length > 0 || colorPart === undefined || alphaPart === undefined) return undefined;
      parts = colorPart
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);
      alpha = alphaPart.trim();
      if (parts.length !== 3) return undefined;
    } else {
      parts = body.split(/[\s,]+/).filter(Boolean);
      if (parts.length === 4) alpha = parts[3];
      else if (parts.length !== 3) return undefined;
      parts = parts.slice(0, 3);
    }
    const a = alphaOf(alpha);
    if (a === undefined) return undefined;
    if (name.startsWith("rgb")) {
      const rgb = parts.map((p) => component(p, 255));
      const [r, g, b] = rgb;
      if (r === undefined || g === undefined || b === undefined) return undefined;
      return rgba(r, g, b, a);
    }
    const h = hueOf(parts[0] ?? "");
    const sat = component(parts[1] ?? "", 1);
    const lig = component(parts[2] ?? "", 1);
    if (h === undefined || sat === undefined || lig === undefined) return undefined;
    if (!(parts[1] ?? "").endsWith("%") || !(parts[2] ?? "").endsWith("%")) return undefined;
    const [r, g, b] = hslToRgb(h, sat, lig);
    return rgba(r, g, b, a);
  }
  return NAMED.get(s);
}

/** Multiplies the alpha of a `#rrggbb[aa]` color by `opacity` (0..1). */
export function withOpacity(color: string, opacity: number): string {
  if (opacity >= 1) return color;
  const r = Number.parseInt(color.slice(1, 3), 16);
  const g = Number.parseInt(color.slice(3, 5), 16);
  const b = Number.parseInt(color.slice(5, 7), 16);
  const a = color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) / 255 : 1;
  return rgba(r, g, b, a * Math.max(0, opacity));
}
