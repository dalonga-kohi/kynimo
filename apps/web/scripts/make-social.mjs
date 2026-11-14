// Renders the share images with the repo's pinned Playwright Chromium and the site's own fonts:
//   src/app/opengraph-image.png   1200 x 630, the link preview on X, Slack, LinkedIn and so on
//   design/social/x-header.png    1500 x 500, the X profile header
// Run: pnpm --filter @kynimo/web social
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const root = join(web, "..", "..");
const requireWeb = createRequire(join(web, "package.json"));
const requireRenderer = createRequire(join(root, "packages", "renderer", "package.json"));
const { chromium } = requireRenderer("playwright");

const font = (pkg, file) =>
  pathToFileURL(join(dirname(requireWeb.resolve(`${pkg}/package.json`)), "files", file)).href;
const sans = font("@fontsource-variable/mona-sans", "mona-sans-latin-wdth-normal.woff2");
const mono = font("@fontsource-variable/geist-mono", "geist-mono-latin-wght-normal.woff2");

const MARK =
  "M0 0H5V120H0Z M11 0H21V120H11Z M47 0H74L47 27Z M51 60L74 37V83Z M47 93L74 120H47Z M111 0H132V120H111L82 91V29Z";
const mark = (cls) =>
  `<svg class="${cls}" viewBox="0 0 132 120" fill="currentColor"><path d="${MARK}"/></svg>`;

const LAYERS = [
  ["background", "solid"],
  ["mark", "shape"],
  ["title", "text"],
  ["rule", "shape"],
  ["caption", "text"],
];

/** The page's exploded layer stack, fully open: the same transforms as `.stack-frame`. */
const stack = LAYERS.map(
  ([id, kind], i) => `<div class="plane" data-layer="${id}" style="--i:${i}">
    ${id === "mark" ? mark("plane-mark") : ""}
    ${id === "title" ? '<p class="plane-title">Every frame, on purpose.</p>' : ""}
    ${id === "rule" ? '<span class="plane-rule"></span>' : ""}
    ${id === "caption" ? '<p class="plane-caption">Made over MCP</p>' : ""}
    <span class="plane-tag"><b>${id}</b> ${kind}</span>
  </div>`,
).join("");

const page = ({ width, height, layout }) => `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face { font-family: "Mona Sans"; src: url("${sans}") format("woff2-variations");
    font-weight: 200 900; font-stretch: 75% 125%; }
  @font-face { font-family: "Geist Mono"; src: url("${mono}") format("woff2-variations");
    font-weight: 100 900; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${width}px; height: ${height}px; }
  body { position: relative; overflow: hidden; background: #0c0b0a; color: #ede8df;
    font-family: "Mona Sans", sans-serif; -webkit-font-smoothing: antialiased; }
  /* The page's dither field, as a dot screen that fades away from the stack. */
  .field { position: absolute; inset: 0;
    background-image: radial-gradient(circle, #7a6327 1.1px, transparent 1.6px);
    background-size: 8px 8px;
    mask-image: radial-gradient(ellipse 46% 78% at var(--fx) 50%, #000 0%, rgb(0 0 0 / 0.45) 45%, transparent 100%); }
  .copy { position: absolute; left: var(--pad); top: 0; bottom: 0; width: var(--copy-w);
    display: flex; flex-direction: column; justify-content: center; }
  .lockup { position: absolute; left: var(--pad); top: var(--pad); display: flex; align-items: center;
    gap: 14px; font-weight: 800; font-stretch: 125%; font-size: 30px; letter-spacing: -0.02em; }
  .lockup svg { height: 30px; width: auto; color: #f5c842; }
  h1 { font-weight: 800; font-stretch: 125%; font-size: var(--h1); line-height: 0.96;
    letter-spacing: -0.035em; }
  .sub { margin-top: 26px; max-width: 30ch; color: #a39c90; font-size: var(--sub); line-height: 1.35;
    font-weight: 450; }
  .url { position: absolute; left: var(--pad); bottom: var(--pad); font-family: "Geist Mono", monospace;
    font-size: 22px; color: #a39c90; }
  .url b { font-weight: 500; color: #f5c842; }
  .stage { position: absolute; right: var(--stage-r); top: var(--stage-t); width: var(--stage-w);
    perspective: 1600px; }
  .frame { position: relative; width: 100%; aspect-ratio: 16 / 9; container-type: inline-size;
    transform-style: preserve-3d;
    transform: translateY(14%) rotateX(54deg) rotateZ(-34deg) scale(0.86); }
  .plane { position: absolute; inset: 0; border-radius: 8px;
    transform: translateZ(calc(var(--i) * 7.5cqw));
    border: 1.5px solid rgb(245 200 66 / 0.6); background: rgb(245 200 66 / 0.035); }
  .plane[data-layer="background"] { background: #0c0b0a; border-color: #3d3832;
    box-shadow: 0 40px 80px -30px rgb(0 0 0 / 0.9); }
  .plane-mark { position: absolute; left: 8.33%; top: 12.2%; height: 19.3%; width: auto; color: #f5c842; }
  .plane-title { position: absolute; left: 8.33%; top: 37%; width: 84%; font-weight: 800;
    font-stretch: 125%; font-size: 7.3cqw; line-height: 1.06; letter-spacing: -0.01em; }
  .plane-rule { position: absolute; left: 8.33%; top: 73%; width: 11.5%; height: 1.1%; background: #f5c842; }
  .plane-caption { position: absolute; left: 8.33%; top: 87%; font-size: 1.9cqw; font-weight: 500; color: #a39c90; }
  .plane-tag { position: absolute; right: 0; bottom: 100%; padding-bottom: 6px;
    font-family: "Geist Mono", monospace; font-size: 2.6cqw; white-space: nowrap; }
  .plane-tag b { font-weight: 500; color: #f5c842; }
  .plane[data-layer="background"] .plane-tag { right: auto; left: 0; }
  ${layout}
</style>
<div class="field"></div>
<div class="lockup">${mark("")}<span>Kynimo</span></div>
<div class="copy">
  <h1>Motion graphics<br>for your AI agent.</h1>
  <p class="sub">The desktop motion engine your agent drives over MCP. Layers and keyframes, not pixels.</p>
</div>
<div class="url"><b>kynimo.site</b> · Windows beta</div>
<div class="stage"><div class="frame">${stack}</div></div>`;

const IMAGES = [
  {
    out: join(web, "src", "app", "opengraph-image.png"),
    width: 1200,
    height: 630,
    layout: `:root { --pad: 64px; --copy-w: 640px; --h1: 68px; --sub: 25px; --fx: 76%;
      --stage-w: 500px; --stage-r: 28px; --stage-t: 170px; }
      .copy { padding-top: 10px; }`,
  },
  {
    // X crops the header's top and bottom on some screens and covers the lower left with the
    // avatar, so the copy sits in the middle band and to the right of it.
    out: join(root, "design", "social", "x-header.png"),
    width: 1500,
    height: 500,
    layout: `:root { --pad: 56px; --copy-w: 700px; --h1: 60px; --sub: 23px; --fx: 78%;
      --stage-w: 470px; --stage-r: 120px; --stage-t: 96px; }
      .copy { left: 300px; }
      .lockup { left: 300px; top: 60px; }
      .copy { padding-top: 34px; }
      .url { left: auto; right: 56px; bottom: 60px; }`,
  },
];

const browser = await chromium.launch();
try {
  for (const image of IMAGES) {
    const tab = await browser.newPage({
      viewport: { width: image.width, height: image.height },
      deviceScaleFactor: 1,
    });
    // A file: page may load file: fonts; setContent's about:blank origin may not.
    await tab.goto(pathToFileURL(join(web, "package.json")).href);
    await tab.setContent(page(image));
    await tab.evaluate(() => document.fonts.ready);
    await mkdir(dirname(image.out), { recursive: true });
    await tab.screenshot({ path: image.out, type: "png" });
    await tab.close();
    process.stdout.write(`Wrote ${image.out}\n`);
  }
} finally {
  await browser.close();
}
