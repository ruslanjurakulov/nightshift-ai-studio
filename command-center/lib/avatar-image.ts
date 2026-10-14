import {
  AVATAR_INPUT_MAX_BYTES,
  AVATAR_INPUT_MAX_PIXELS,
  AVATAR_INPUT_MAX_SIDE,
  AVATAR_INPUT_TYPES,
  AVATAR_MAX_BYTES,
  AVATAR_MIME,
  AVATAR_SIZE,
  type AvatarErrorCode,
} from "@/lib/avatar";
import { canonicalizeAvatarJpeg, validateAvatarJpeg } from "@/lib/avatar-validate";
import { readImageHeader, type ImageHeader } from "@/lib/image-header";

/**
 * Turn a photo the person picked into the 256x256 JPEG the server stores.
 * (JPEG, because Safari's canvas cannot encode WebP: it hands back a PNG.)
 *
 * Browser side, and the order is the point:
 *   1. size: more than 5 MB is refused before it is read;
 *   2. sniff: the first bytes must be PNG, JPEG or WebP (file.type is only the
 *      name the operating system guessed and is never trusted);
 *   3. pixel-bomb guard: the declared width and height are read from the file's
 *      own header bytes and refused above 8192 a side or 50 megapixels (a 48 MP
 *      phone photo passes). A decoder allocates width x height x 4 bytes before
 *      it shows a pixel, so a 3 KB file declaring 60000x60000 would otherwise
 *      take the tab down. Only then does anything decode;
 *   4. the picture is decoded through an <img> (the same pipeline as the crop
 *      preview, so the camera's EXIF rotation is applied to both alike), the
 *      chosen square is drawn onto a 256x256 canvas over white (JPEG has no
 *      transparency) and encoded as JPEG. Re-encoding from pixels is what drops
 *      EXIF (GPS included), colour profiles and anything else hidden in the
 *      original; any segment an encoder adds on its own is removed again by
 *      canonicalizeAvatarJpeg, and the result must pass the same validator the
 *      server runs.
 */

export class AvatarInputError extends Error {
  constructor(readonly code: AvatarErrorCode) {
    super(code);
    this.name = "AvatarInputError";
  }
}

/** A square in the picture's own pixels (after the camera's rotation has been applied, as the browser shows it). */
export interface AvatarCrop {
  x: number;
  y: number;
  size: number;
}

export interface AvatarInspection {
  format: ImageHeader["format"];
  width: number;
  height: number;
}

/**
 * Steps 1-3: what the file is and how large it declares itself, or an
 * AvatarInputError. Reads the file's bytes (never more than 5 MB), decodes nothing.
 */
export async function inspectAvatarFile(file: Blob): Promise<AvatarInspection> {
  if (file.size === 0) throw new AvatarInputError("unreadable");
  if (file.size > AVATAR_INPUT_MAX_BYTES) throw new AvatarInputError("too_large");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new AvatarInputError("unreadable");
  }
  return inspectAvatarBytes(bytes);
}

/** The header checks on bytes already in memory (the pure half of inspectAvatarFile; tested directly). */
export function inspectAvatarBytes(bytes: Uint8Array): AvatarInspection {
  const header = readImageHeader(bytes);
  if (!header) throw new AvatarInputError(looksLikeAnImage(bytes) ? "unreadable" : "unsupported");
  if (!(AVATAR_INPUT_TYPES as readonly string[]).includes(`image/${header.format}`)) throw new AvatarInputError("unsupported");
  // A moving picture is not a photo, and its later frames would be decoded too.
  if (header.animated) throw new AvatarInputError("unsupported");
  const { width, height } = header;
  if (width > AVATAR_INPUT_MAX_SIDE || height > AVATAR_INPUT_MAX_SIDE || width * height > AVATAR_INPUT_MAX_PIXELS) {
    throw new AvatarInputError("image_too_large");
  }
  return { format: header.format, width, height };
}

/** Right magic bytes but a header that does not parse (truncated, a zero side) reads "unreadable"; anything else "unsupported". */
function looksLikeAnImage(b: Uint8Array): boolean {
  const png = b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpeg = b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const webp = b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  return png || jpeg || webp;
}

/** A square no larger than the picture, inside it. */
export function clampCrop(crop: AvatarCrop, width: number, height: number): AvatarCrop {
  const size = Math.max(1, Math.min(Number.isFinite(crop.size) ? crop.size : 1, width, height));
  const x = Math.max(0, Math.min(Number.isFinite(crop.x) ? crop.x : 0, width - size));
  const y = Math.max(0, Math.min(Number.isFinite(crop.y) ? crop.y : 0, height - size));
  return { x, y, size };
}

/** Quality steps: the first is the one that is normally kept (a 256x256 photo is 15-30 KB). */
const QUALITIES = [0.85, 0.75, 0.65, 0.5, 0.35];

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, AVATAR_MIME, quality));
}

/** Decode through an <img>: it applies the EXIF rotation exactly as the crop preview does. */
async function decodeImage(file: Blob): Promise<{ img: HTMLImageElement; release: () => void }> {
  const url = URL.createObjectURL(file);
  const release = () => URL.revokeObjectURL(url);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch {
    release();
    throw new AvatarInputError("unreadable");
  }
  if (!img.naturalWidth || !img.naturalHeight) {
    release();
    throw new AvatarInputError("unreadable");
  }
  return { img, release };
}

/** A picture the page has already decoded and is showing: complete, with a size. */
function isDecoded(img: HTMLImageElement | null | undefined): img is HTMLImageElement {
  return !!img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
}

/**
 * `shown` is the crop preview's own <img> for this same file, when the page has one that has finished loading: it is
 * drawn from directly instead of decoding the file a second time. A second concurrent decode of a 48 MP photo
 * (8064 x 6048, about 195 MB of pixels held twice) fails in Chromium with an EncodingError, and the preview is the
 * very pipeline whose EXIF rotation the crop was chosen against. Without it (not loaded yet) the file is decoded here.
 */
export async function prepareAvatar(file: Blob, crop: AvatarCrop, shown?: HTMLImageElement | null): Promise<Blob> {
  await inspectAvatarFile(file);

  const { img, release } = isDecoded(shown) ? { img: shown, release: () => {} } : await decodeImage(file);
  try {
    // naturalWidth/Height are what the person saw (rotation applied); a rotated JPEG swaps its sides.
    const c = clampCrop(crop, img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new AvatarInputError("encode_failed");
    // JPEG has no alpha: a transparent PNG would turn black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, c.x, c.y, c.size, c.size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

    for (const q of QUALITIES) {
      const blob = await toBlob(canvas, q);
      if (!blob || blob.type !== AVATAR_MIME) throw new AvatarInputError("encode_failed");
      const clean = canonicalizeAvatarJpeg(new Uint8Array(await blob.arrayBuffer()));
      if (!clean) throw new AvatarInputError("encode_failed");
      if (clean.length > AVATAR_MAX_BYTES) continue;
      // The server runs this same check: find out here, not by a refused upload.
      if (!validateAvatarJpeg(clean).ok) throw new AvatarInputError("encode_failed");
      return new Blob([clean], { type: AVATAR_MIME });
    }
    throw new AvatarInputError("too_large");
  } finally {
    release();
  }
}
