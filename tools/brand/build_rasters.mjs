#!/usr/bin/env node
/**
 * Rasterise the Nightshift mark's SVG masters into the PNG / ICO files the app
 * and the brand kit ship. The SVGs are the single source of truth; run
 * `python3 tools/brand/build_logo.py` first when the artwork changes.
 *
 *   node tools/brand/build_rasters.mjs
 *
 * Uses sharp from command-center/node_modules (a dependency of Next.js); no
 * network. favicon.ico is a 16/32/48 PNG-in-ICO container written here.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = path.join(REPO, "command-center", "app");
const LOGO = path.join(REPO, "command-center", "brand", "logo");
const PNG = path.join(LOGO, "png");
const require = createRequire(path.join(REPO, "command-center", "package.json"));
const sharp = require("sharp");

mkdirSync(PNG, { recursive: true });

async function png(svgFile, size, out, { flatten } = {}) {
  let img = sharp(readFileSync(svgFile), { density: Math.max(72, Math.ceil((size / 512) * 288)) }).resize(size, size);
  if (flatten) img = img.flatten({ background: flatten });
  const buf = await img.png({ compressionLevel: 9 }).toBuffer();
  if (out) writeFileSync(out, buf);
  return buf;
}

// Brand kit: rounded app-icon tile, square (maskable / iOS) tile, white mark on transparent.
for (const s of [1024, 512, 256, 180, 64, 32, 16]) {
  await png(path.join(LOGO, "nightshift-app-icon.svg"), s, path.join(PNG, `nightshift-app-icon-${s}.png`));
}
for (const s of [512, 192]) {
  await png(path.join(LOGO, "nightshift-maskable.svg"), s, path.join(PNG, `nightshift-maskable-${s}.png`), { flatten: "#030303" });
}
const markSvg = readFileSync(path.join(LOGO, "nightshift-mark.svg"));
writeFileSync(
  path.join(PNG, "nightshift-mark-1024.png"),
  await sharp(markSvg, { density: 576 }).resize({ width: 1024 }).png({ compressionLevel: 9 }).toBuffer(),
);

// Next.js file-convention icons.
// icon.png and apple-icon.png are the owner's picture itself: the square tile, same framing.
await png(path.join(LOGO, "nightshift-maskable.svg"), 512, path.join(APP, "icon.png"));
await png(path.join(LOGO, "nightshift-maskable.svg"), 180, path.join(APP, "apple-icon.png"), { flatten: "#030303" });

// favicon.ico: PNG-in-ICO at 16, 32, 48 (the tab composition).
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map((s) => png(path.join(APP, "icon.svg"), s)));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = images.map((buf, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(sizes[i], 0);
  e.writeUInt8(sizes[i], 1);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(buf.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += buf.length;
  return e;
});
writeFileSync(path.join(APP, "favicon.ico"), Buffer.concat([header, ...dir, ...images]));
console.log("rasters written");
