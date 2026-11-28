import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Breach, PR #996: attacks on scripts/media-bundle-check.mjs, the guard that no file anyone can download from the site names a
 * vendor or carries a vendor job id, except a maker's own signed TC260 `AIGC` label (docs/AI_DISCLOSURE.md "Vendor watermarks
 * and provenance"). Each case is a stand-in build laid out the way the muxers write, run through the real script. A case that
 * describes a hole pins the SAFE outcome (exit 1, or "not a pass") and so fails until the script is fixed; the "held" cases pin
 * what already works, and two of them pin real bytes the fix must not start flagging.
 *
 * Every id and signature below is a stand-in, never a real one.
 */

const CC = process.cwd();
const SCRIPT = path.join(CC, "scripts", "media-bundle-check.mjs");
type Label = Record<string, unknown>;

const head = "\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01";
// The TagString's EBML size is the value's real length, as a muxer writes it (Forge, fix round: the check binds a label to
// exactly its own tag value now, so a stand-in size of 0 no longer reads as "the value that follows").
const ebmlSize = (n: number) => {
  let len = 1;
  while (n >= 2 ** (7 * len) - 1) len++;
  const out = Buffer.alloc(len);
  out.writeUIntBE(n + 2 ** (7 * len), 0, len);
  return out.toString("latin1");
};
const webm = (value: string, tail = "") => Buffer.from(`${head}\x67\xc8\x45\xa3\x84AIGC\x44\x87${ebmlSize(value.length)}${value}\x00\xff\xfe${tail}`, "latin1");
// The signature block as all 54 measured labels carry it (Forge, fix round: the stand-in had a PubKey entry with AlgID .301 and
// TBSData {Type:"Hash"}, and a DS entry as its Binding; the real ones are .501 / {Type:""} and a Hash entry with .401).
const sig = { Type: "DS", AlgID: "1.2.156.10197.1.501", TBSData: { Type: "LabelMataData" }, Signature: "0f".repeat(64) };
const pub = [sig, { ...sig, TBSData: { Type: "Binding", BType: "0" } }, { Type: "PubKey", AlgID: "1.2.156.10197.1.501", TBSData: { Type: "" }, KeyValue: "0f".repeat(33) }];
const hashBinding = { Type: "Hash", AlgID: "1.2.156.10197.1.401", TBSData: { Type: "" }, Signature: "0f".repeat(32) };
const security = (entries: unknown[] = pub, bindings: unknown[] = [hashBinding]) =>
  JSON.stringify({ SecurityData: { Type: "TC260PG", Version: 1, PubSD: entries, Bindings: bindings } });
const label = (overrides: Label = {}): Label => ({
  Label: "1",
  ContentProducer: "MiniMax",
  ProduceID: "0f".repeat(16),
  ReservedCode1: security(),
  ContentPropagator: "MiniMax",
  PropagateID: "",
  ReservedCode2: "",
  ...overrides,
});
const exact = JSON.stringify(label());
const utf16le = (s: string) => Buffer.from(s, "utf16le").toString("latin1");
// A stand-in vendor job id in each shape vendors use: 32 hex (MiniMax-style) and a UUID (Runway/Luma-style).
const HEX_ID = "9a3c51e07b2d48f6a1c0e5d7b3f9420c";
const UUID_ID = "9a3c51e0-7b2d-48f6-a1c0-e5d7b3f9420c";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

type Layout = { media?: Record<string, Uint8Array> | null; pub?: Record<string, Uint8Array>; sources?: Record<string, Uint8Array>; timeout?: number };

function run(layout: Layout): { status: number | null; out: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-breach-"));
  roots.push(root);
  const cc = path.join(root, "cc");
  mkdirSync(path.join(cc, "lib", "server"), { recursive: true });
  mkdirSync(path.join(root, "schemas"), { recursive: true });
  cpSync(path.join(CC, "..", "schemas", "model_registry.json"), path.join(root, "schemas", "model_registry.json"));
  cpSync(path.join(CC, "lib", "server", "provider-names.ts"), path.join(cc, "lib", "server", "provider-names.ts"));
  const put = (dir: string, files: Record<string, Uint8Array>) => {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), body);
    }
  };
  if (layout.media !== null) {
    mkdirSync(path.join(cc, ".next", "static", "media"), { recursive: true });
    put(path.join(cc, ".next", "static", "media"), layout.media ?? {});
  }
  if (layout.pub) put(path.join(cc, "public"), layout.pub);
  if (layout.sources) put(path.join(cc, "components", "site", "showcase"), layout.sources);
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: cc, encoding: "utf8", timeout: layout.timeout ?? 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const scan = (media: Record<string, Uint8Array>) => run({ media });

describe("breach: a shape-valid label is a free carrier for any vendor's name or id (the exemption is not bound to the maker)", () => {
  it("a forged label whose maker is another vendor (ContentProducer 'Kling') is not exempted", () => {
    // The 54 real labels are all MiniMax/MiniMax; a 'Kling' label on the site is Kling's identity in public media.
    expect(scan({ "clip.1.webm": webm(JSON.stringify(label({ ContentProducer: "Kling", ContentPropagator: "Kling" }))) }).status).toBe(1);
  });

  it("a MiniMax label carrying another vendor's name in Label, PropagateID or ReservedCode2 is not exempted", () => {
    for (const o of [{ Label: "Runway Gen-4.5" }, { PropagateID: "Luma Ray 3.2" }, { ReservedCode2: "Seedance 2.0 export" }]) {
      expect(scan({ "clip.1.webm": webm(JSON.stringify(label(o))) }).status, Object.keys(o)[0]).toBe(1);
    }
  });

  it("a MiniMax label whose signature block carries a vendor name or a second job id is not exempted", () => {
    const named = [{ ...sig, Signature: "Kling AI 3.0 task export" }];
    const id = [{ ...sig, AlgID: HEX_ID }];
    for (const entries of [named, id]) expect(scan({ "clip.1.webm": webm(JSON.stringify(label({ ReservedCode1: security(pub, entries) }))) }).status).toBe(1);
  });

  it("duplicate JSON keys hide a vendor name in the raw bytes while the parsed label reads MiniMax", () => {
    const raw = exact.replace('"ContentProducer":"MiniMax"', '"ContentProducer":"Runway Gen-4.5","ContentProducer":"MiniMax"');
    expect(raw).toContain("Runway");
    expect(scan({ "clip.1.webm": webm(raw) }).status).toBe(1);
  });

  it("a second, different label in the same file (a second job id) is not exempted", () => {
    const second = JSON.stringify(label({ ProduceID: HEX_ID }));
    const file = Buffer.concat([webm(exact), Buffer.from(`\x67\xc8\x45\xa3\x84AIGC\x44\x87\x80${second}\x00`, "latin1")]);
    expect(scan({ "clip.1.webm": file }).status).toBe(1);
  });

  it("a label in a poster is not exempted: export_showcase.py writes posters with Pillow, which carry no label", () => {
    const poster = Buffer.from(`RIFF\x00\x00\x00\x00WEBPXMP \x00\x10\x00\x00AIGC\x00${exact}\x00`, "latin1");
    expect(scan({ "poster.1.webp": poster }).status).toBe(1);
  });
});

describe("breach: a vendor name or job id outside any label that the scan does not see", () => {
  it("a name in another case ('KLING', 'minimax') in a tag value", () => {
    for (const v of ["title=KLING AI 3.0 export", "encoder=minimax-video-01"]) {
      expect(scan({ "clip.1.webm": webm(exact, `\x00${v}\x00`) }).status, v).toBe(1);
    }
  });

  it("a vendor or product name that is not itself a provider or model display name (Hailuo, Seedance, Vidu, BytePlus, Kuaishou)", () => {
    for (const v of ["comment=Hailuo export", "comment=Seedance render", "comment=Vidu Q3 render", "comment=BytePlus ModelArk", "comment=Kuaishou Kling"]) {
      expect(scan({ "clip.1.webm": webm(exact, `\x00${v}\x00`) }).status, v).toBe(1);
    }
  });

  it("a short name that is a whole tag value: an MP4 ilst artist 'Luma', a poster's EXIF Make 'Kling'", () => {
    const ilst = Buffer.from(`\x00\x00\x00\x18ftypisom\x00\x00\x02\x00ilst\x00\x00\x00\x1c\xa9ART\x00\x00\x00\x14data\x00\x00\x00\x01\x00\x00\x00\x00Luma\x00\x00\x00\x08mdat`, "latin1");
    const exif = Buffer.from("RIFF\x00\x00\x00\x00WEBPEXIF\x20\x00\x00\x00MM\x00\x2a\x00\x00\x00\x08\x00\x01\x01\x0f\x00\x02\x00\x00\x00\x06\x00\x00\x00\x1aKling\x00", "latin1");
    expect(scan({ "clip.1.mp4": ilst }).status).toBe(1);
    expect(scan({ "poster.1.webp": exif }).status).toBe(1);
  });

  it("a vendor job id in a tag far from any AIGC key, as 32 hex and as a UUID, and printed in no part", () => {
    const pad = "\xff".repeat(8192);
    for (const v of [`comment=task ${HEX_ID}`, `comment=task ${UUID_ID}`]) {
      const r1 = scan({ "clip.1.webm": webm(exact, `${pad}\x00${v}\x00`) });
      const r2 = scan({ "clip.2.mp4": Buffer.from(`\x00\x00\x00\x18ftypisom\x00${v}\x00mdat`, "latin1") });
      for (const r of [r1, r2]) {
        expect(r.status, v).toBe(1);
        expect(r.out).not.toContain(HEX_ID.slice(0, 8));
      }
    }
  });

  it("a name in UTF-16 (an EXIF XPComment, a 3GPP udta string)", () => {
    const xp = Buffer.from(`RIFF\x00\x00\x00\x00WEBPEXIF\x40\x00\x00\x00II*\x00\x9c\x9c${utf16le("Made with Kling AI")}\x00\x00`, "latin1");
    const be = Buffer.from(`\x00\x00\x00\x18ftypisom\x00\x00\x00\x30titl\xfe\xff${Buffer.from(utf16le("MiniMax H3 export"), "latin1").swap16().toString("latin1")}\x00\x00`, "latin1");
    expect(scan({ "poster.1.webp": xp }).status).toBe(1);
    expect(scan({ "clip.1.mp4": be }).status).toBe(1);
  });

  it("a name the scan cannot read because the bytes are encoded: JSON \\u escapes, base64 in an SVG, a compressed PNG zTXt", () => {
    const json = Buffer.from('{"model":"\\u004bling 3.0","by":"\\u004diniMax"}', "latin1");
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><metadata>${Buffer.from("generator: Runway Gen-4.5").toString("base64")}</metadata></svg>`, "latin1");
    const z = deflateSync(Buffer.from("Kling AI 3.0 render"));
    const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\x00zTXtSoftware\x00\x00", "latin1"), z]);
    for (const [name, body] of [["data.1.json", json], ["mark.1.svg", svg], ["poster.1.png", png]] as const) {
      expect(scan({ [name]: body }).status, name).toBe(1);
    }
  });

  it("public/ is served from / as well, and a vendor tag there is a leak", () => {
    const leak = Buffer.from("\x00\x00\x00\x18ftypisom\x00title=MiniMax H3 export\x00mdat", "latin1");
    expect(run({ media: { "clip.1.webm": webm(exact) }, pub: { "showcase/coffee-pour.mp4": leak } }).status).toBe(1);
  });
});

describe("breach: a run that read nothing that matters, or never ends, is not a pass", () => {
  it("a build whose media no longer hold the labelled showcase clips (only an unrelated file) does not exit 0", () => {
    const r = run({ media: { "font.1.woff2": Buffer.from("wOF2\x00\x01", "latin1") }, sources: { "job-1/clip-sm.webm": webm(exact) } });
    expect(r.status).not.toBe(0);
  });

  it("a hostile AIGC value (a long printable run full of '}') is scanned in bounded time, not quadratically", () => {
    const value = `{"a":"${"}".repeat(256 * 1024)}`;
    const r = run({ media: { "clip.1.webm": webm(value) }, timeout: 15_000 });
    expect(r.status, "killed by the timeout: the exemption parse is O(n^2) in the run length").not.toBeNull();
  }, 30_000);
});

describe("held: what the scan already gets right (and what the fix must keep)", () => {
  it("a name straddling a 1 MiB boundary in a large file is caught (the file is read whole, no chunk seams)", () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0xff);
    big.write("\x00title=MiniMax H3\x00", 1024 * 1024 - 10, "latin1");
    expect(scan({ "clip.1.webm": Buffer.concat([webm(exact), big]) }).status).toBe(1);
  });

  it("8 MiB of pseudo-random video bytes pass", () => {
    const chunks: Buffer[] = [];
    let h: Buffer = Buffer.from("breach-seed");
    for (let i = 0; i < 8 * 1024 * 1024 / 32; i++) chunks.push((h = createHash("sha256").update(h).digest()));
    expect(scan({ "clip.1.webm": Buffer.concat(chunks) }).status).toBe(0);
  });

  it("real bytes a fix must not flag: a flat poster's run of 38 hex digits, and 'xAI' by chance inside a 12-char printable run", () => {
    // Both measured on this build's 284 files: poster.ce4785bf.webp (VP8 of a flat area) and clip.f0170db0d1adbef1.mp4.
    const poster = Buffer.from(`RIFF\x00\x00\x00\x00WEBPVP8 \x99\x99\x82\\\xc3${"3".repeat(37)}6\xa7\xfe\x7f""""`, "latin1");
    const clip = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x91Bl}qgu.HxAIN\x92\x00mdat", "latin1");
    expect(scan({ "poster.1.webp": poster, "clip.1.mp4": clip }).status).toBe(0);
  });

  it("the exact MiniMax label still passes in a WebM, and no build still exits 2", () => {
    expect(scan({ "clip.1.webm": webm(exact) }).status).toBe(0);
    expect(run({ media: null }).status).toBe(2);
  });
});
