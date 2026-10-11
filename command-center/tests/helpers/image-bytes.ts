/**
 * Hand-built image headers for the avatar tests: just enough bytes for the
 * header parsers (and the route's validator) to read, and nothing a decoder
 * would accept. That is the point — the guard must answer from the header
 * alone, so a "60000 x 60000" file here is a few dozen bytes.
 */

const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const txt = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));

export function png(width: number, height: number, opts: { ihdrFirst?: boolean } = {}): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [...be32(13), ...txt(opts.ihdrFirst === false ? "tEXt" : "IHDR"), ...be32(width), ...be32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0];
  return new Uint8Array([...sig, ...ihdr]);
}

export function jpeg(width: number, height: number, opts: { app?: number; sof?: number; noSof?: boolean } = {}): Uint8Array {
  const out = [0xff, 0xd8];
  // an APPn segment first (EXIF etc.), as a camera file has
  const app = opts.app ?? 16;
  out.push(0xff, 0xe1, ...be16(app + 2), ...new Array(app).fill(0x41));
  if (!opts.noSof) out.push(0xff, opts.sof ?? 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  out.push(0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0);
  return new Uint8Array(out);
}

type WebpKind = "lossy" | "lossless" | "extended";
export interface WebpOpts {
  kind?: WebpKind;
  /** VP8X animation flag + ANIM chunk. */
  animated?: boolean;
  /** extra chunks to append (EXIF, XMP, ...). */
  extra?: string[];
  /** bytes appended after the RIFF container. */
  trailing?: number;
  /** a lie in the RIFF size field */
  riffSizeDelta?: number;
  /** VP8X canvas differs from the bitstream by this much. */
  canvasDelta?: number;
}

function chunk(id: string, data: number[]): number[] {
  const pad = data.length % 2 ? [0] : [];
  return [...txt(id), ...le32(data.length), ...data, ...pad];
}

export function webp(width: number, height: number, o: WebpOpts = {}): Uint8Array {
  const kind = o.kind ?? "lossy";
  const w14 = width & 0x3fff;
  const h14 = height & 0x3fff;
  const lossy = chunk("VP8 ", [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, w14 & 255, w14 >> 8, h14 & 255, h14 >> 8, 0, 0, 0, 0]);
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const lossless = chunk("VP8L", [0x2f, ...le32(bits >>> 0), 0, 0]);
  const image = kind === "lossless" ? lossless : lossy;
  const body: number[] = [];
  if (kind === "extended" || o.animated || o.extra?.length) {
    const cw = width - 1 + (o.canvasDelta ?? 0);
    const ch = height - 1;
    const flags = o.animated ? 0x02 : 0;
    body.push(...chunk("VP8X", [flags, 0, 0, 0, cw & 255, (cw >> 8) & 255, (cw >> 16) & 255, ch & 255, (ch >> 8) & 255, (ch >> 16) & 255]));
  }
  if (o.animated) body.push(...chunk("ANIM", [0, 0, 0, 0, 0, 0]));
  body.push(...(kind === "extended" && !o.animated ? lossless : image));
  for (const id of o.extra ?? []) body.push(...chunk(id, [1, 2, 3, 4]));
  const riff = 4 + body.length + (o.riffSizeDelta ?? 0);
  return new Uint8Array([...txt("RIFF"), ...le32(riff), ...txt("WEBP"), ...body, ...new Array(o.trailing ?? 0).fill(0x55)]);
}
