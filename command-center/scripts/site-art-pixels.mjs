/**
 * Pixel check for the drawn art (jsdom cannot see colour): screenshot the /mcp card's picture in the light and the dark
 * theme at phone and desktop width, read the pixels back through a canvas, and fail when it is the black rectangle the
 * art became when its `--nx-stage*` colours were defined only on `.nx` (a `.st` page never had them).
 *
 *   node scripts/site-art-pixels.mjs http://localhost:3000
 *
 * Playwright is not a dependency of the app: this loads whatever the machine has (PLAYWRIGHT_MODULE, default the
 * global install) and PLAYWRIGHT_CHROMIUM for the browser binary, when it is not the one Playwright ships.
 */
import { createRequire } from "node:module";

const BASE = process.argv[2] ?? "http://localhost:3000";
const { chromium } = createRequire(process.env.PLAYWRIGHT_MODULE ?? "/opt/node22/lib/node_modules/x.js")("playwright");
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
let failed = 0;

for (const scheme of ["light", "dark"]) {
  for (const width of [390, 1280]) {
    const phone = width < 600;
    const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: scheme, isMobile: phone, hasTouch: phone });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/mcp`, { waitUntil: "load" });
    const art = page.locator(".nx-demo .nx-result-art").first();
    await art.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    const png = (await art.screenshot()).toString("base64");
    // Sample on a grid: how much of the picture is lit (not near-black), and is there the lit amber of the drawing.
    const s = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0, lit = 0, amber = 0, dark = 0;
      for (let y = 0; y < c.height; y += 3) {
        for (let x = 0; x < c.width; x += 3) {
          const i = (y * c.width + x) * 4;
          const r = d[i], gr = d[i + 1], bl = d[i + 2];
          n++;
          if (Math.max(r, gr, bl) > 40) lit++;
          if (r > 200 && gr > 120 && gr < 210 && bl < 120) amber++;
          if (Math.max(r, gr, bl) < 40) dark++;
        }
      }
      return { n, lit: lit / n, amber: amber / n, dark: dark / n };
    }, png);
    // The drawing: a dark stage with a glow, six nodes, hairlines. It is mostly dark by design, so "not black" means
    // a lit share (the glow and the strokes) and amber pixels, which the broken one had none of (all 0.00).
    const ok = s.lit > 0.03 && s.amber > 0.001;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} /mcp art ${scheme} ${width}: lit ${(s.lit * 100).toFixed(1)}%, amber ${(s.amber * 100).toFixed(2)}%, near-black ${(s.dark * 100).toFixed(1)}%`);
    await ctx.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
