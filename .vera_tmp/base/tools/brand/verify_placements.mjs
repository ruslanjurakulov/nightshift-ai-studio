#!/usr/bin/env node
/**
 * Numeric proof that every placed logo is the owner's picture.
 *
 * Opens each page in real Chromium at 2x device pixels, finds every rendered
 * mark (an <svg> with the 1254 viewBox: the UI's BrandMark), screenshots just
 * that element, and compares it with the owner's image scaled to the same pixel
 * size (inside the tile's rounded corners; the original is a square). Writes
 * a JSON report and a side-by-side sheet: original | placement | |difference| x8.
 *
 *   node tools/brand/verify_placements.mjs --base http://localhost:3417 --out /tmp/proof \
 *        [--pages /,/login,/signup,/pricing] [--app /night-owl/home]
 *
 * Needs the app running (built against tools/visual-qa/fake-supabase.mjs for the
 * signed-in shell) and Playwright (global install) with Chromium at
 * /opt/pw-browsers/chromium. Nothing is installed or fetched.
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const APP = path.join(REPO, "command-center");
const ORIGINAL = path.join(APP, "brand/logo/source/owner-supplied-N-1254.png");
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const BASE = arg("base", "http://localhost:3000").replace(/\/$/, "");
const OUT = path.resolve(arg("out", "/tmp/brand-proof"));
const PAGES = arg("pages", "/,/login,/signup,/pricing").split(",");
const APP_PAGES = arg("app", "/night-owl/home").split(",").filter(Boolean);
mkdirSync(OUT, { recursive: true });

const rq = createRequire(path.join(APP, "package.json"));
const sharp = rq("sharp");
const { chromium } = createRequire(path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "noop.js"))("playwright");
const { sessionCookie } = await import(path.join(REPO, "tools/visual-qa/fake-supabase.mjs"));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const rows = [];
const tiles = [];

async function mask(px) {
  // Inside the rounded corners, inset 2 device px so the anti-aliased rim (which blends with
  // whatever page colour is behind the tile) is not counted against the artwork.
  const r = Math.max(0, px * 0.2266 - 2);
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}"><rect width="${px}" height="${px}" fill="#000"/><rect x="2" y="2" width="${px - 4}" height="${px - 4}" rx="${r}" fill="#fff"/></svg>`)).greyscale().raw().toBuffer();
}

async function run(pagePath, signed, width, theme) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
  if (signed) {
    const c = sessionCookie();
    await ctx.addCookies([{ name: c.name, value: c.value, url: BASE }]);
  }
  await ctx.addCookies([{ name: "chronos_theme", value: theme, url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(BASE + pagePath, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const handles = await page.$$('svg[viewBox="0 0 1254 1254"]');
  let n = 0;
  for (const h of handles) {
    if (!(await h.isVisible())) continue;
    await h.scrollIntoViewIfNeeded();
    let box = await h.boundingBox();
    // A mark laid out at a fractional CSS position is drawn with soft edges; that is the
    // browser's pixel grid, not the artwork. Nudge it onto whole device pixels for the
    // measurement only (the page itself is not changed).
    const fx = (box.x * 2) % 1, fy = (box.y * 2) % 1;
    if (fx || fy) {
      await h.evaluate((el, d) => (el.style.transform = `translate(${-d[0] / 2}px, ${-d[1] / 2}px)`), [fx, fy]);
      box = await h.boundingBox();
    }
    const label = await h.evaluate((el) => {
      const a = el.closest("header,footer,aside,nav,main,form,div[class*=card]");
      return (a ? a.tagName.toLowerCase() : "page") + (el.closest("a")?.getAttribute("href") ? `>a[${el.closest("a").getAttribute("href")}]` : "");
    });
    const png = await h.screenshot({ type: "png" });
    const w = Math.round(box.width * 2);
    const shot = await sharp(png).resize(w, w).removeAlpha().raw().toBuffer();
    const ref = await sharp(ORIGINAL).resize(w, w, { kernel: "lanczos3" }).removeAlpha().raw().toBuffer();
    const m = await mask(w);
    let sum = 0, cnt = 0;
    for (let i = 0; i < m.length; i++) {
      if (m[i] < 250) continue;
      for (let c = 0; c < 3; c++) {
        sum += Math.abs(shot[i * 3 + c] - ref[i * 3 + c]);
        cnt++;
      }
    }
    const mae = sum / cnt;
    rows.push({ page: pagePath, width, theme, css_px: Math.round(box.width * 10) / 10, device_px: w, where: label, mae: Math.round(mae * 100) / 100, overflow_px: overflow });
    if (theme === "dark" || width === 1280) tiles.push({ name: `${slug(pagePath)} ${width} ${theme} ${label} ${Math.round(box.width)}px`, png, w, ref });
    n++;
  }
  await ctx.close();
  if (!n) rows.push({ page: pagePath, width, theme, note: "no mark found", overflow_px: overflow });
}
const slug = (s) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";

for (const w of [1280, 360]) for (const t of ["light", "dark"]) {
  for (const p of PAGES) await run(p, false, w, t);
  for (const p of APP_PAGES) await run(p, true, w, t);
}
await browser.close();

writeFileSync(path.join(OUT, "placements.json"), JSON.stringify(rows, null, 2));
const ok = rows.filter((r) => r.mae !== undefined);
const worst = Math.max(...ok.map((r) => r.mae));
console.log(`placements measured: ${ok.length}; mean MAE ${(ok.reduce((a, r) => a + r.mae, 0) / ok.length).toFixed(2)}/255; worst ${worst}`);
console.table(ok.map((r) => ({ page: r.page, w: r.width, theme: r.theme, css: r.css_px, where: r.where, MAE: r.mae })));

// Side-by-side sheet (one tile per distinct placement, shown at 3x nearest so edges are visible).
const seen = new Set();
const cells = [];
for (const t of tiles) {
  const key = `${t.name}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const scale = Math.max(1, Math.round(160 / t.w));
  const grid = async (buf, raw) => {
    const img = raw ? sharp(buf, { raw: { width: t.w, height: t.w, channels: 3 } }) : sharp(buf).resize(t.w, t.w);
    return img.resize(t.w * scale, t.w * scale, { kernel: "nearest" }).png().toBuffer();
  };
  const shot = await grid(t.png, false);
  const ref = await grid(t.ref, true);
  const a = await sharp(t.png).resize(t.w, t.w).removeAlpha().raw().toBuffer();
  const diff = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) diff[i] = Math.min(255, Math.abs(a[i] - t.ref[i]) * 8);
  const d = await grid(diff, true);
  cells.push({ name: t.name, w: t.w * scale, ref, shot, d });
}
const W = 160 * 3 + 80, rowsH = cells.map((c) => c.w + 26);
const sheetH = rowsH.reduce((a, b) => a + b, 0) + 10;
const comps = [];
let y = 0;
for (const c of cells) {
  const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${c.w * 3 + 40}" height="22"><text x="4" y="15" font-family="sans-serif" font-size="12" fill="#ddd">${c.name.replace(/&/g, "&amp;")}   (original | placement | diff x8)</text></svg>`);
  comps.push({ input: label, left: 0, top: y });
  comps.push({ input: c.ref, left: 0, top: y + 24 }, { input: c.shot, left: c.w + 20, top: y + 24 }, { input: c.d, left: 2 * (c.w + 20), top: y + 24 });
  y += c.w + 30;
}
const sheetW = Math.max(...cells.map((c) => c.w * 3 + 40));
await sharp({ create: { width: sheetW, height: y + 10, channels: 3, background: "#14181f" } }).composite(comps).png().toFile(path.join(OUT, "placements-side-by-side.png"));
console.log("wrote", path.join(OUT, "placements.json"), "and placements-side-by-side.png");
