// Renders build/icon.svg (and the 16 px hinted design) with the repo's pinned Playwright
// Chromium into build/icon.ico (16, 24, 32, 48, 64, 128, 256) and build/icon.png (256).
// Run: pnpm --filter @kynimo/desktop icon. The outputs are committed.
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIco } from "./ico.mjs";

const build = fileURLToPath(new URL("../build/", import.meta.url));
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const MARK = "M0 0H2V24H0Z M7 0H12L7 5Z M8 12L12 8V16Z M7 19L12 24H7Z M20 0H24V24H20L14 18V6Z";
const MARK_16 = "M0 0H1V12H0Z M4 0H6L4 2Z M4 6L6 4V8Z M4 10L6 12H4Z M10 0H12V12H10L7 9V3Z";

/** The 16 px design is drawn on its own grid; every other size scales the 32 px design. */
function svg(size) {
  const small = size === 16;
  const base = small ? 16 : 32;
  const rx = small ? 3 : 7;
  const inset = small ? 2 : 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${base} ${base}"><rect width="${base}" height="${base}" rx="${rx}" fill="#F5C842"/><path transform="translate(${inset} ${inset})" fill="#14110A" d="${small ? MARK_16 : MARK}"/></svg>`;
}

const root = fileURLToPath(new URL("../../..", import.meta.url));
const requireMcp = createRequire(join(root, "apps", "desktop", "package.json"));
const requireCapture = createRequire(requireMcp.resolve("@kynimo/mcp"));
const requirePlaywright = createRequire(requireCapture.resolve("@kynimo/capture"));
const { chromium } = requirePlaywright("playwright");

const browser = await chromium.launch();
try {
  const images = [];
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<!doctype html><body style="margin:0;background:transparent">${svg(size)}</body>`,
    );
    const png = await page.screenshot({ omitBackground: true, type: "png" });
    await page.close();
    images.push({ size, png });
  }
  await writeFile(join(build, "icon.ico"), writeIco(images));
  await writeFile(join(build, "icon.png"), images.at(-1).png);
  process.stdout.write(`Wrote icon.ico (${SIZES.join(", ")} px) and icon.png (256 px)\n`);
} finally {
  await browser.close();
}
