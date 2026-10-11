// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { jpeg, png, webp } from "./helpers/image-bytes";
import { parseJpeg, parsePng, parseWebp, readImageHeader } from "../lib/image-header";
import { AvatarInputError, clampCrop, inspectAvatarBytes, inspectAvatarFile, prepareAvatar } from "../lib/avatar-image";

// jsdom's Blob has no arrayBuffer(); every browser the app supports does.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(this);
    });
  };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AvatarInputError ? e.code : `other:${String(e)}`;
  }
  return "no error";
};

describe("header parsers read the declared size without decoding", () => {
  it("PNG: IHDR width and height", () => {
    expect(readImageHeader(png(640, 480))).toEqual({ format: "png", width: 640, height: 480, animated: false });
  });
  it("JPEG: the first SOF, after an EXIF-sized APP segment; SOF2 (progressive) too", () => {
    expect(readImageHeader(jpeg(3024, 4032, { app: 2000 }))).toMatchObject({ format: "jpeg", width: 3024, height: 4032 });
    expect(parseJpeg(jpeg(800, 600, { sof: 0xc2 }))).toMatchObject({ width: 800, height: 600 });
  });
  it("WebP: lossy, lossless and extended all give the same size", () => {
    for (const kind of ["lossy", "lossless", "extended"] as const) {
      expect(readImageHeader(webp(256, 200, { kind }))).toMatchObject({ format: "webp", width: 256, height: 200, animated: false });
    }
  });
  it("WebP: the animation flag and ANIM chunk are reported", () => {
    expect(parseWebp(webp(100, 100, { animated: true }))?.animated).toBe(true);
  });

  it("reads huge declared dimensions as numbers (the guard refuses them; the parser does not decode)", () => {
    expect(parsePng(png(60000, 60000))).toMatchObject({ width: 60000, height: 60000 });
    expect(parseJpeg(jpeg(65535, 65535))).toMatchObject({ width: 65535, height: 65535 });
    expect(parseWebp(webp(16383, 16383, { kind: "lossless" }))).toMatchObject({ width: 16383, height: 16383 });
  });

  it("answers null for wrong magic, truncation and zero sides, and never throws", () => {
    const cases: Uint8Array[] = [
      new Uint8Array(),
      new Uint8Array([0x89, 0x50]),
      png(10, 10).slice(0, 20), // truncated IHDR
      png(0, 10),
      png(10, 0),
      png(10, 10, { ihdrFirst: false }),
      jpeg(10, 10, { noSof: true }),
      jpeg(0, 10),
      jpeg(10, 10).slice(0, 5),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00]), // segment length past the end
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]), // length < 2
      webp(100, 100).slice(0, 25),
      new Uint8Array(40).fill(0x52), // not RIFF....WEBP
      new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>"),
      new TextEncoder().encode("GIF89a\x01\x00\x01\x00"),
    ];
    for (const bytes of cases) expect(() => readImageHeader(bytes), String(bytes.slice(0, 8))).not.toThrow();
    expect(readImageHeader(new Uint8Array(40).fill(0x52))).toBeNull();
    expect(readImageHeader(png(10, 0))).toBeNull();
    expect(readImageHeader(jpeg(10, 10, { noSof: true }))).toBeNull();
    expect(readImageHeader(webp(100, 100).slice(0, 25))).toBeNull();
    expect(parseWebp(webp(100, 100, { riffSizeDelta: 400 }))).toBeNull();
  });

  it("a WebP whose canvas disagrees with its bitstream is not readable", () => {
    expect(parseWebp(webp(100, 100, { kind: "extended", canvasDelta: 50 }))).toBeNull();
  });
});

describe("pixel-bomb guard (before any decode)", () => {
  it("accepts an ordinary photo", () => {
    expect(inspectAvatarBytes(jpeg(4032, 3024))).toEqual({ format: "jpeg", width: 4032, height: 3024 });
    expect(inspectAvatarBytes(png(512, 512)).format).toBe("png");
    expect(inspectAvatarBytes(webp(800, 800)).format).toBe("webp");
  });

  it("refuses more than 8192 a side", () => {
    expect(code(() => inspectAvatarBytes(png(8193, 100)))).toBe("image_too_large");
    expect(code(() => inspectAvatarBytes(jpeg(100, 8193)))).toBe("image_too_large");
    expect(inspectAvatarBytes(png(8192, 100)).width).toBe(8192);
  });

  it("refuses more than 40 megapixels even when each side is allowed", () => {
    expect(code(() => inspectAvatarBytes(png(8000, 5001)))).toBe("image_too_large");
    expect(inspectAvatarBytes(png(8000, 5000)).height).toBe(5000);
  });

  it("refuses a few-byte file that declares 60000 x 60000, for every format", () => {
    for (const bytes of [png(60000, 60000), jpeg(65535, 65535), webp(16383, 16383, { kind: "lossless" })]) {
      expect(bytes.length).toBeLessThan(200);
      expect(code(() => inspectAvatarBytes(bytes))).toBe("image_too_large");
    }
  });

  it("refuses unreadable headers and unsupported formats with different codes", () => {
    expect(code(() => inspectAvatarBytes(png(10, 10).slice(0, 20)))).toBe("unreadable");
    expect(code(() => inspectAvatarBytes(jpeg(10, 10, { noSof: true })))).toBe("unreadable");
    expect(code(() => inspectAvatarBytes(new TextEncoder().encode("<svg/>")))).toBe("unsupported");
    expect(code(() => inspectAvatarBytes(new TextEncoder().encode("GIF89a\x01\x00\x01\x00")))).toBe("unsupported");
    expect(code(() => inspectAvatarBytes(new Uint8Array(0)))).toBe("unsupported");
  });

  it("refuses an animated WebP (later frames would be decoded too)", () => {
    expect(code(() => inspectAvatarBytes(webp(100, 100, { animated: true })))).toBe("unsupported");
  });

  it("does not trust file.type: the bytes decide, and nothing decodes on a refusal", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    const lying = new File([png(60000, 60000)], "cat.jpg", { type: "image/jpeg" });
    await expect(inspectAvatarFile(lying)).rejects.toMatchObject({ code: "image_too_large" });
    const html = new File([new TextEncoder().encode("<html><script>alert(1)</script>")], "x.png", { type: "image/png" });
    await expect(inspectAvatarFile(html)).rejects.toMatchObject({ code: "unsupported" });
    await expect(prepareAvatar(lying, { x: 0, y: 0, size: 10 })).rejects.toMatchObject({ code: "image_too_large" });
    expect(decode).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("refuses an input over 5 MB before reading it, and an empty file", async () => {
    const big = { size: 5 * 1024 * 1024 + 1, arrayBuffer: vi.fn() } as unknown as Blob;
    await expect(inspectAvatarFile(big)).rejects.toMatchObject({ code: "too_large" });
    expect((big as unknown as { arrayBuffer: ReturnType<typeof vi.fn> }).arrayBuffer).not.toHaveBeenCalled();
    await expect(inspectAvatarFile(new Blob([]))).rejects.toMatchObject({ code: "unreadable" });
  });
});

describe("clampCrop", () => {
  it("keeps a square inside the picture", () => {
    expect(clampCrop({ x: -50, y: 900, size: 5000 }, 400, 300)).toEqual({ x: 0, y: 0, size: 300 });
    expect(clampCrop({ x: 390, y: 290, size: 100 }, 400, 300)).toEqual({ x: 300, y: 200, size: 100 });
    expect(clampCrop({ x: Number.NaN, y: Number.NaN, size: Number.NaN }, 400, 300)).toEqual({ x: 0, y: 0, size: 1 });
  });
});

describe("prepareAvatar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function setup(opts: { types?: string[]; sizes?: number[]; ctx?: boolean } = {}) {
    const draw = vi.fn();
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 800, height: 600, close })));
    const types = [...(opts.types ?? ["image/webp"])];
    const sizes = [...(opts.sizes ?? [20_000])];
    const qualities: number[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() =>
      opts.ctx === false ? null : { drawImage: draw, imageSmoothingEnabled: false, imageSmoothingQuality: "low" }) as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(((cb: BlobCallback, type?: string, q?: number) => {
      qualities.push(q ?? -1);
      expect(type).toBe("image/webp");
      const t = types.length > 1 ? types.shift()! : types[0];
      const n = sizes.length > 1 ? sizes.shift()! : sizes[0];
      cb(new Blob([new Uint8Array(n)], { type: t }));
    }) as never);
    return { draw, close, qualities };
  }
  const photo = () => new File([jpeg(800, 600)], "p.jpg", { type: "image/jpeg" });

  it("draws the chosen square onto a 256x256 canvas and returns the WebP blob", async () => {
    const { draw, close, qualities } = setup();
    const blob = await prepareAvatar(photo(), { x: 100, y: 50, size: 400 });
    expect(blob.type).toBe("image/webp");
    expect(draw).toHaveBeenCalledWith(expect.anything(), 100, 50, 400, 400, 0, 0, 256, 256);
    expect(qualities).toEqual([0.85]);
    expect(close).toHaveBeenCalled();
  });

  it("clamps a crop that sticks out of the picture", async () => {
    const { draw } = setup();
    await prepareAvatar(photo(), { x: 700, y: 500, size: 900 });
    expect(draw).toHaveBeenCalledWith(expect.anything(), 200, 0, 600, 600, 0, 0, 256, 256);
  });

  it("steps the quality down until the blob fits 256 KB", async () => {
    const { qualities } = setup({ sizes: [300_000, 270_000, 100_000] });
    const blob = await prepareAvatar(photo(), { x: 0, y: 0, size: 600 });
    expect(blob.size).toBe(100_000);
    expect(qualities).toEqual([0.85, 0.75, 0.65]);
  });

  it("gives up with too_large when no quality fits", async () => {
    setup({ sizes: [300_000] });
    await expect(prepareAvatar(photo(), { x: 0, y: 0, size: 600 })).rejects.toMatchObject({ code: "too_large" });
  });

  it("never returns a PNG: a browser that cannot encode WebP is reported, not uploaded", async () => {
    setup({ types: ["image/png"] });
    await expect(prepareAvatar(photo(), { x: 0, y: 0, size: 600 })).rejects.toMatchObject({ code: "encode_unsupported" });
  });

  it("reports a missing canvas context and an undecodable picture with fixed codes", async () => {
    setup({ ctx: false });
    await expect(prepareAvatar(photo(), { x: 0, y: 0, size: 600 })).rejects.toMatchObject({ code: "encode_unsupported" });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => Promise.reject(new Error("The source image could not be decoded"))));
    await expect(prepareAvatar(photo(), { x: 0, y: 0, size: 600 })).rejects.toMatchObject({ code: "unreadable" });
  });
});
