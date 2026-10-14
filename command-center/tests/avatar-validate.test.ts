import { describe, expect, it } from "vitest";
import { avatarJpeg, jpeg, png, webp } from "./helpers/image-bytes";
import { canonicalizeAvatarJpeg, validateAvatarJpeg } from "../lib/avatar-validate";

const code = (b: Uint8Array) => {
  const r = validateAvatarJpeg(b);
  return r.ok ? "ok" : r.code;
};

describe("validateAvatarJpeg: exactly the shape a browser's canvas encoder writes", () => {
  it("accepts the ordinary file: JFIF, tables, baseline frame, one scan, EOI", () => {
    expect(validateAvatarJpeg(avatarJpeg())).toEqual({ ok: true, width: 256, height: 256 });
  });

  it("accepts the variations real encoders produce", () => {
    for (const o of [
      { icc: true }, // a colour profile (Display P3 canvases)
      { jfif: false }, // an encoder that writes no JFIF
      { dht: 4 },
      { dht: 0 },
      { dri: true },
      { components: 1 as const }, // greyscale
      { width: 64, height: 64 },
      { width: 512, height: 512 },
      { width: 256, height: 240 }, // square-ish
      { entropy: [0x01, 0xff, 0x00, 0xff, 0xd0, 0x02, 0xff, 0xd7, 0x03] }, // stuffing and every restart marker kind
    ]) {
      expect(code(avatarJpeg(o)), JSON.stringify(o)).toBe("ok");
    }
  });

  it("refuses metadata: EXIF, XMP, comments and any other APPn", () => {
    for (const o of [{ exif: true }, { xmp: true }, { com: true }, { appn: 0xed }, { appn: 0xee }, { appn: 0xe1 }]) {
      expect(code(avatarJpeg(o)), JSON.stringify(o)).toBe("not_jpeg");
    }
  });

  it("accepts legal 0xFF fill bytes in the scan, before an RSTn marker and before EOI, and nowhere illegal", () => {
    for (const entropy of [
      [0x01, 0xff, 0xff, 0xff, 0xd0, 0x02], // fill before RST0
      [0x01, 0xff, 0xff, 0xd7, 0x02, 0xff, 0xd3, 0x04],
      [0x01, 0x02, 0xff], // fill that runs into the final EOI (FF FF D9)
      [0x01, 0x02, 0xff, 0xff, 0xff], // longer run into EOI
    ]) {
      expect(code(avatarJpeg({ entropy })), JSON.stringify(entropy)).toBe("ok");
    }
    for (const entropy of [
      [0x01, 0xff, 0xff, 0x00, 0x02], // a stuffed zero is only legal straight after the first FF
      [0x01, 0xff, 0xff, 0xe1, 0x00, 0x05], // fill then an APP1 hidden in the data
      [0x01, 0xff, 0xff, 0xd8, 0x02], // fill then SOI
      [0x01, 0xff, 0xff, 0xd9, 0x02], // an early EOI
      [0x01, 0xff, 0xff, 0xc0, 0x00, 0x11],
    ]) {
      expect(code(avatarJpeg({ entropy })), JSON.stringify(entropy)).toBe("not_jpeg");
    }
    // in the header, fill bytes are still refused
    const withFill = avatarJpeg();
    const at = withFill.findIndex((v, i) => i > 2 && v === 0xff && withFill[i + 1] === 0xdb);
    const bad = new Uint8Array([...withFill.slice(0, at), 0xff, ...withFill.slice(at)]);
    expect(code(bad)).toBe("not_jpeg");
  });

  it("bounds the channels the structure leaves open: ICC size, numbering and signature, JFIF thumbnail, table count", () => {
    expect(code(avatarJpeg({ icc: { total: 16 * 1024 } }))).toBe("ok"); // exactly the cap
    expect(code(avatarJpeg({ icc: { total: 16 * 1024 + 1 } }))).toBe("not_jpeg"); // one over
    expect(code(avatarJpeg({ icc: { total: 12 * 1024, pieces: 2 } }))).toBe("ok"); // a real Display-P3 sized profile, in pieces
    expect(code(avatarJpeg({ icc: { total: 20 * 1024, pieces: 2 } }))).toBe("not_jpeg"); // over the 16 KB cap
    expect(code(avatarJpeg({ icc: { total: 130 * 1024, pieces: 3 } }))).toBe("not_jpeg");
    expect(code(avatarJpeg({ icc: { acsp: false } }))).toBe("not_jpeg"); // not an ICC profile
    expect(code(avatarJpeg({ icc: { sizeField: false } }))).toBe("not_jpeg");
    expect(code(avatarJpeg({ icc: { total: 100 } }))).toBe("not_jpeg"); // shorter than the 128-byte header
    expect(code(avatarJpeg({ icc: { total: 4000, pieces: 2, seq: [2, 1] } }))).toBe("not_jpeg");
    expect(code(avatarJpeg({ icc: { total: 4000, pieces: 2, count: 3 } }))).toBe("not_jpeg");
    expect(code(avatarJpeg({ icc: { total: 4000, pieces: 2, seq: [1, 1] } }))).toBe("not_jpeg");
    expect(code(avatarJpeg({ icc: { total: 536, pieces: 1 } }))).toBe("ok"); // what Chromium writes
    expect(code(avatarJpeg({ jfifThumbnail: true }))).toBe("not_jpeg");
    expect(code(avatarJpeg({ dqt: 4 }))).toBe("ok");
    expect(code(avatarJpeg({ dqt: 5 }))).toBe("not_jpeg");
  });

  it("the scan must name the frame's components, each once", () => {
    expect(code(avatarJpeg({ scanIds: [1, 2, 3] }))).toBe("ok");
    expect(code(avatarJpeg({ scanIds: [3, 2, 1] }))).toBe("ok"); // order is the encoder's business
    expect(code(avatarJpeg({ scanIds: [1, 2, 9] }))).toBe("not_jpeg");
    expect(code(avatarJpeg({ scanIds: [1, 1, 2] }))).toBe("not_jpeg");
  });

  it("refuses a second payload: bytes after EOI, a missing EOI, a second scan, a stray marker in the data", () => {
    expect(code(avatarJpeg({ trailing: [0] }))).toBe("not_jpeg");
    expect(code(avatarJpeg({ trailing: [0x50, 0x4b, 0x03, 0x04] }))).toBe("not_jpeg"); // a zip glued on
    expect(code(avatarJpeg({ noEoi: true }))).toBe("not_jpeg");
    expect(code(avatarJpeg({ twoScans: true }))).toBe("not_jpeg");
    expect(code(avatarJpeg({ entropy: [0x12, 0xff, 0xe1, 0x00, 0x05, 0x78] }))).toBe("not_jpeg"); // an APP1 hidden after the scan starts
    expect(code(avatarJpeg({ entropy: [] }))).toBe("not_jpeg"); // an empty scan
  });

  it("refuses frames other than baseline and structure out of order", () => {
    expect(code(avatarJpeg({ sof: 0xc2 }))).toBe("not_jpeg"); // progressive
    expect(code(avatarJpeg({ sof: 0xc9 }))).toBe("not_jpeg"); // arithmetic
    expect(code(avatarJpeg({ noDqt: true }))).toBe("not_jpeg");
    expect(code(avatarJpeg({ dht: 5 }))).toBe("not_jpeg");
  });

  it("refuses other formats and non-images, whatever they claim", () => {
    const text = new TextEncoder();
    for (const b of [
      new Uint8Array(),
      png(256, 256),
      webp(256, 256),
      jpeg(256, 256), // header only: no scan, no EOI
      text.encode("<html><script>alert(1)</script></html>"),
      text.encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      new Uint8Array([0xff, 0xd8]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    ]) {
      expect(code(b)).toBe("not_jpeg");
    }
  });

  it("refuses lengths that lie: a segment past the end, a frame whose length does not match its components", () => {
    const good = avatarJpeg();
    const cut = good.slice(0, 40);
    expect(code(cut)).toBe("not_jpeg");
    const lying = good.slice();
    // the SOF0 length field (offset: after SOI, JFIF (18), DQT (69), FFC0): make it claim 3 more bytes
    const at = lying.findIndex((v, i) => v === 0xff && lying[i + 1] === 0xc0);
    lying[at + 3] += 3;
    expect(code(lying)).toBe("not_jpeg");
    const wrongPrecision = good.slice();
    wrongPrecision[at + 4] = 12;
    expect(code(wrongPrecision)).toBe("not_jpeg");
  });

  it("sides outside 64..512 or far from square are bad_dimensions; bigger than 256 KB is too_large", () => {
    for (const [w, h] of [[32, 32], [63, 64], [513, 513], [1024, 1024], [256, 128], [512, 400], [65535, 65535]]) {
      expect(code(avatarJpeg({ width: w, height: h })), `${w}x${h}`).toBe("bad_dimensions");
    }
    const big = avatarJpeg({ entropy: new Array(262_144).fill(0x11) });
    expect(code(big)).toBe("too_large");
  });
});

describe("canonicalizeAvatarJpeg: what the browser does to an encoder's output before uploading", () => {
  it("drops EXIF, XMP, comments and other APPn and keeps the picture bytes untouched", () => {
    const dirty = avatarJpeg({ exif: true, xmp: true, com: true, appn: 0xed });
    expect(code(dirty)).toBe("not_jpeg");
    const clean = canonicalizeAvatarJpeg(dirty)!;
    expect(validateAvatarJpeg(clean)).toEqual({ ok: true, width: 256, height: 256 });
    expect(Array.from(clean)).toEqual(Array.from(avatarJpeg()));
    expect(new TextDecoder("latin1").decode(clean)).not.toMatch(/GPSLatitude|xmpmeta|hello|Photoshop/);
  });

  it("drops what would fail the bounds (a JFIF thumbnail, a bad or oversize ICC profile) and keeps a good one", () => {
    for (const o of [{ jfifThumbnail: true }, { icc: { acsp: false } }, { icc: { total: 20 * 1024, pieces: 2 } }, { icc: { total: 4000, pieces: 2, seq: [2, 1] } }]) {
      const dirty = avatarJpeg(o);
      expect(code(dirty), JSON.stringify(o)).toBe("not_jpeg");
      const clean = canonicalizeAvatarJpeg(dirty)!;
      expect(code(clean), JSON.stringify(o)).toBe("ok");
    }
    const good = avatarJpeg({ icc: { total: 6000, pieces: 2 } });
    expect(Array.from(canonicalizeAvatarJpeg(good)!)).toEqual(Array.from(good));
  });

  it("keeps JFIF and an ICC profile, and leaves a clean file as it was", () => {
    const withIcc = avatarJpeg({ icc: true });
    expect(Array.from(canonicalizeAvatarJpeg(withIcc)!)).toEqual(Array.from(withIcc));
    const plain = avatarJpeg();
    expect(Array.from(canonicalizeAvatarJpeg(plain)!)).toEqual(Array.from(plain));
  });

  it("does not make an unsafe file safe: bytes after EOI and progressive frames still fail validation", () => {
    expect(code(canonicalizeAvatarJpeg(avatarJpeg({ trailing: [1, 2, 3] }))!)).toBe("not_jpeg");
    expect(code(canonicalizeAvatarJpeg(avatarJpeg({ sof: 0xc2, exif: true }))!)).toBe("not_jpeg");
  });

  it("is null for something that is not a JPEG header", () => {
    expect(canonicalizeAvatarJpeg(new Uint8Array())).toBeNull();
    expect(canonicalizeAvatarJpeg(png(10, 10))).toBeNull();
    expect(canonicalizeAvatarJpeg(webp(10, 10))).toBeNull();
  });
});
