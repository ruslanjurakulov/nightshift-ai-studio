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

export interface AvatarJpegOpts {
  width?: number;
  height?: number;
  components?: 1 | 3;
  /** JFIF APP0 right after SOI (default true). */
  jfif?: boolean;
  /** an ICC profile piece (APP2) */
  icc?: boolean;
  /** EXIF (APP1) with a GPS-looking payload */
  exif?: boolean;
  xmp?: boolean;
  com?: boolean;
  /** another APPn, e.g. 0xed (Photoshop) */
  appn?: number;
  /** the frame marker: 0xc0 baseline (default), 0xc2 progressive */
  sof?: number;
  dht?: number;
  dri?: boolean;
  /** entropy-coded bytes (default: a few plain bytes with a stuffed FF00 and an RST0) */
  entropy?: number[];
  /** bytes after EOI */
  trailing?: number[];
  noEoi?: boolean;
  noDqt?: boolean;
  twoScans?: boolean;
}

const seg = (marker: number, payload: number[]) => [0xff, marker, ...be16(payload.length + 2), ...payload];

/** A complete JPEG of the shape the browsers' canvas encoders write: a header, one baseline scan, EOI. Not decodable (the entropy bytes are filler); the validator reads structure, not pixels. */
export function avatarJpeg(o: AvatarJpegOpts = {}): Uint8Array {
  const w = o.width ?? 256;
  const h = o.height ?? 256;
  const n = o.components ?? 3;
  const out: number[] = [0xff, 0xd8];
  if (o.jfif !== false) out.push(...seg(0xe0, [...txt("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  if (o.icc) out.push(...seg(0xe2, [...txt("ICC_PROFILE"), 0, 1, 1, ...new Array(40).fill(7)]));
  if (o.exif) out.push(...seg(0xe1, [...txt("Exif"), 0, 0, 0x4d, 0x4d, 0, 42, ...txt("GPSLatitude")]));
  if (o.xmp) out.push(...seg(0xe1, [...txt("http://ns.adobe.com/xap/1.0/"), 0, ...txt("<x:xmpmeta/>")]));
  if (o.com) out.push(...seg(0xfe, txt("hello")));
  if (o.appn !== undefined) out.push(...seg(o.appn, txt("Photoshop 3.0")));
  if (!o.noDqt) out.push(...seg(0xdb, [0, ...new Array(64).fill(8)]));
  const comps = n === 3 ? [1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1] : [1, 0x11, 0];
  out.push(...seg(o.sof ?? 0xc0, [8, ...be16(h), ...be16(w), n, ...comps]));
  for (let i = 0; i < (o.dht ?? 1); i++) out.push(...seg(0xc4, [i, ...new Array(16).fill(0), 1]));
  if (o.dri) out.push(...seg(0xdd, [0, 4]));
  const sosComps = n === 3 ? [1, 0, 2, 0x11, 3, 0x11] : [1, 0];
  const sos = () => {
    out.push(...seg(0xda, [n, ...sosComps, 0, 63, 0]));
    for (const v of o.entropy ?? [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]) out.push(v); // not spread: the oversize case is 256 KB
  };
  sos();
  if (o.twoScans) sos();
  if (!o.noEoi) out.push(0xff, 0xd9);
  out.push(...(o.trailing ?? []));
  return new Uint8Array(out);
}
