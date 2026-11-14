// Renders build/installer-sidebar.html (164x314) and build/installer-header.html (150x57) with
// the repo's pinned Playwright Chromium (fonts from the app's fontsource files, so offline) and
// writes the 24-bit BMPs the NSIS installer uses. Run: pnpm --filter @kynimo/desktop installer-art.
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeBmp } from "./bmp.mjs";

const build = fileURLToPath(new URL("../build/", import.meta.url));
const IMAGES = [
  ["installer-sidebar", 164, 314],
  ["installer-header", 150, 57],
];

const root = fileURLToPath(new URL("../../..", import.meta.url));
const requireMcp = createRequire(join(root, "apps", "desktop", "package.json"));
const requireCapture = createRequire(requireMcp.resolve("@kynimo/mcp"));
const requirePlaywright = createRequire(requireCapture.resolve("@kynimo/capture"));
const { chromium } = requirePlaywright("playwright");

const browser = await chromium.launch();
try {
  for (const [name, width, height] of IMAGES) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(join(build, `${name}.html`)).href);
    await page.evaluate(() => document.fonts.ready);
    const png = await page.screenshot({ type: "png" });
    // Chromium decodes the PNG back to pixels, so no image library is needed.
    const rgba = await page.evaluate(
      async ([data, w, h]) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = new OffscreenCanvas(w, h);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return Array.from(context.getImageData(0, 0, w, h).data);
      },
      [png.toString("base64"), width, height],
    );
    await writeFile(join(build, `${name}.bmp`), writeBmp(width, height, Uint8Array.from(rgba)));
    await page.close();
  }
  process.stdout.write("Wrote installer-sidebar.bmp and installer-header.bmp\n");
} finally {
  await browser.close();
}
