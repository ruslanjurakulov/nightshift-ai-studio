#!/usr/bin/env node
/**
 * Builds command-center/lib/dev/brand-logos-art.ts from the vendors' own SVG
 * files kept, unmodified, under command-center/brand/third-party/ (what each
 * file is, where it came from and what its owner allows is in
 * docs/design/BRAND_LOGOS.md and command-center/lib/dev/brand-logos.ts).
 *
 * What this script does to an SVG, and nothing else:
 *  - drops the XML prolog, comments, <title>, and width/height on the root;
 *  - turns a `<style>.cls{fill:#xxx}</style>` + class="cls" pair into a plain
 *    `fill="#xxx"` on the element (an inline <style> would leak its class names
 *    into the whole page, and two vendors both write `.st0`);
 *  - prefixes every id (and the url(#id) / href="#id" that point at it) with the
 *    symbol's own name, so many logos can share one page's sprite;
 *  - narrows the viewBox to the artwork's own bounding box. That is the same
 *    pixels, not scaled or stretched; the vendor's clear space is given back as
 *    padding by the tile the logo sits in, the same on every logo.
 * It never recolours, redraws, rotates, outlines or adds an effect.
 *
 *   node tools/brand/build_brand_logos.mjs
 *
 * Needs Playwright (command-center/node_modules or the global npm root) only to
 * measure the bounding boxes; the generated file is committed.
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const APP = path.join(REPO, "command-center");
const SRC = path.join(APP, "brand", "third-party");

/** symbol id → file under brand/third-party. `-light` is the mark for a light page, `-dark` for a dark one. */
const FILES = {
  "cursor-light": "cursor/CUBE_2D_LIGHT.svg",
  "cursor-dark": "cursor/CUBE_2D_DARK.svg",
  "windsurf-light": "windsurf/windsurf-black-symbol.svg",
  "windsurf-dark": "windsurf/windsurf-white-symbol.svg",
  "vscode-any": "vscode/vscode.svg",
  "zed-light": "zed/zed-logomark-black.svg",
  "zed-dark": "zed/zed-logomark-white.svg",
  "warp-light": "warp/Warp-Glyph-Black.svg",
  "warp-dark": "warp/Warp-Glyph-White.svg",
  "cline-light": "cline/BOT_LIGHT.svg",
  "cline-dark": "cline/BOT_DARK.svg",
  "openai-light": "openai/OAI_OpenAI-Blossom_Black.svg",
  "openai-dark": "openai/OAI_OpenAI-Blossom_White.svg",
  "openclaw-any": "openclaw/favicon.svg",
  "roo-any": "roo/icon.svg",
  "claude-any": "anthropic/ClaudeIcon-Rounded.svg",
  "claude-spark-any": "anthropic/ClaudeSpark-Clay.svg",
};

/**
 * Marks a vendor offers only as a picture. They go into the sprite as a data: URI
 * inside the page (no request to any other origin; the CSP's img-src already allows
 * data:). Hermes' icon is the vendor's 48 px PNG byte for byte; Gemini CLI's is the
 * vendor's 1645 px PNG scaled down to 128 px and re-encoded as WebP (a smaller file
 * of the same picture, not cropped or recoloured).
 */
const RASTER = {
  "hermes-any": { file: "hermes/icon.png", size: 48, scale: false },
  "gemini-any": { file: "gemini-cli/icon.png", size: 128, scale: true },
};

function loadPlaywright() {
  const roots = [APP, REPO];
  try {
    roots.push(execSync("npm root -g", { encoding: "utf8" }).trim());
  } catch {
    /* local roots only */
  }
  for (const root of roots) {
    try {
      return createRequire(path.join(root, "noop.js"))("playwright");
    } catch {
      /* next */
    }
  }
  throw new Error("Playwright not found");
}

function clean(name, raw) {
  let s = raw.replace(/<\?xml[^>]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<title>[\s\S]*?<\/title>/g, "");
  // class → fill, from a <style> block
  const rules = {};
  s = s.replace(/<style[^>]*>([\s\S]*?)<\/style>/g, (_, css) => {
    for (const m of css.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
      const fill = /fill\s*:\s*([^;}\s]+)/.exec(m[2]);
      if (fill) rules[m[1]] = fill[1];
    }
    return "";
  });
  s = s.replace(/<defs>\s*<\/defs>/g, "");
  s = s.replace(/\sclass="([\w-]+)"/g, (_, c) => (rules[c] ? ` fill="${rules[c]}"` : ""));
  const root = /<svg\b([^>]*)>/.exec(s);
  if (!root) throw new Error(`${name}: no <svg>`);
  const vb = /viewBox="([^"]+)"/.exec(root[1]);
  if (!vb) throw new Error(`${name}: no viewBox`);
  let inner = s.slice(root.index + root[0].length, s.lastIndexOf("</svg>")).trim();
  // ids: unique per symbol
  const ids = [...inner.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  for (const id of ids) {
    const to = `nl-${name}-${id}`;
    inner = inner.split(`id="${id}"`).join(`id="${to}"`).split(`url(#${id})`).join(`url(#${to})`).split(`href="#${id}"`).join(`href="#${to}"`);
  }
  inner = inner.replace(/\s+/g, " ").replace(/> </g, "><");
  return { viewBox: vb[1], inner };
}

const art = {};
for (const [name, file] of Object.entries(FILES)) art[name] = clean(name, readFileSync(path.join(SRC, file), "utf8"));

// Bounding boxes of the artwork itself.
const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<body></body>");
for (const [name, r] of Object.entries(RASTER)) {
  const bytes = readFileSync(path.join(SRC, r.file));
  const png = `data:image/png;base64,${bytes.toString("base64")}`;
  const href = r.scale
    ? await page.evaluate(
        ({ png, size }) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              const c = document.createElement("canvas");
              c.width = size;
              c.height = size;
              const ctx = c.getContext("2d");
              ctx.imageSmoothingQuality = "high";
              ctx.drawImage(img, 0, 0, size, size);
              resolve(c.toDataURL("image/webp", 0.92));
            };
            img.onerror = reject;
            img.src = png;
          }),
        { png, size: r.size },
      )
    : png;
  art[name] = { viewBox: `0 0 ${r.size} ${r.size}`, inner: `<image href="${href}" width="${r.size}" height="${r.size}"/>`, raster: true };
}
for (const [name, a] of Object.entries(art)) {
  if (a.raster) continue;
  const box = await page.evaluate(
    ({ vb, inner }) => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", vb);
      svg.setAttribute("width", "800");
      svg.setAttribute("height", "800");
      svg.innerHTML = inner;
      document.body.appendChild(svg);
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      while (svg.firstChild) g.appendChild(svg.firstChild);
      svg.appendChild(g);
      const b = g.getBBox();
      svg.remove();
      return [b.x, b.y, b.width, b.height];
    },
    { vb: a.viewBox, inner: a.inner },
  );
  const [x, y, w, h] = box.map((n) => Math.round(n * 100) / 100);
  a.viewBox = `${x} ${y} ${w} ${h}`;
}
await browser.close();

const lines = [
  "// Generated by tools/brand/build_brand_logos.mjs from the vendors' own SVG files in",
  "// command-center/brand/third-party/ (unmodified there); do not edit. Marks belong to their owners:",
  "// docs/design/BRAND_LOGOS.md says where each came from and what its owner allows.",
  "export const BRAND_ART: Record<string, { viewBox: string; markup: string }> = {",
];
for (const [name, a] of Object.entries(art)) lines.push(`  ${JSON.stringify(name)}: { viewBox: ${JSON.stringify(a.viewBox)}, markup: ${JSON.stringify(a.inner)} },`);
lines.push("};", "");
writeFileSync(path.join(APP, "lib", "dev", "brand-logos-art.ts"), lines.join("\n"));
console.log("wrote", Object.keys(art).length, "marks,", lines.join("\n").length, "bytes");
