import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The owner supplied one picture and asked for the logo to look exactly like it.
 * The square icons are that picture: same margins, same colours, nothing cropped.
 * Each is compared with the supplied image scaled to the icon's size.
 */
const ROOT = process.cwd();
const sharp = createRequire(join(ROOT, "package.json"))("sharp");
const ORIGINAL = join(ROOT, "brand/logo/source/owner-supplied-N-1254.png");

async function mae(icon: string, size: number): Promise<number> {
  const a = await sharp(ORIGINAL).resize(size, size, { kernel: "lanczos3" }).removeAlpha().raw().toBuffer();
  const b = await sharp(join(ROOT, icon)).resize(size, size).flatten({ background: "#030303" }).removeAlpha().raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

describe("square icons are the owner's picture", () => {
  it("apple-icon.png (180)", async () => expect(await mae("app/apple-icon.png", 180)).toBeLessThan(1.2));
  it("icon.png (512)", async () => expect(await mae("app/icon.png", 512)).toBeLessThan(1.2));
  it("maskable 512", async () => expect(await mae("brand/logo/png/nightshift-maskable-512.png", 512)).toBeLessThan(1.2));
  it("maskable 192", async () => expect(await mae("brand/logo/png/nightshift-maskable-192.png", 192)).toBeLessThan(1.2));
  it("apple-icon.png has no transparency", async () => {
    const meta = await sharp(join(ROOT, "app/apple-icon.png")).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([180, 180, false]);
  });
  it("favicon.ico holds 16, 32 and 48 px images", () => {
    const ico = readFileSync(join(ROOT, "app/favicon.ico"));
    const n = ico.readUInt16LE(4);
    expect(Array.from({ length: n }, (_, k) => ico[6 + 16 * k])).toEqual([16, 32, 48]);
  });
});
