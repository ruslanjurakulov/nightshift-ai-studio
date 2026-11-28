import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * scripts/media-bundle-check.mjs on stand-in builds. A maker's signed implicit label (MiniMax's TC260 `AIGC` tag) is kept on the
 * site's clips (docs/AI_DISCLOSURE.md "Vendor watermarks and provenance"), so exactly that tag is exempt; the same vendor name or
 * a job id anywhere else in a media file, or in a tampered tag, still fails. Each case lays out a `.next/static/media` in the
 * shapes the muxers really write and runs the real script.
 */

const CC = process.cwd();
const SCRIPT = path.join(CC, "scripts", "media-bundle-check.mjs");
type Label = Record<string, unknown>;
// Binary around the tag, as in a real WebM: the EBML head, a SimpleTag's TagName and TagString ids.
const head = "\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01";
const webm = (value: string) => Buffer.from(`${head}\x67\xc8\x45\xa3\x84AIGC\x44\x87\x80${value}\x00\xff\xfe`, "latin1");
// An MP4 with use_metadata_tags: every key in moov/meta/keys first, then the values in ilst in key order, so the AIGC value sits
// past the other keys and the values before it (142 bytes on in the site's real MP4s).
const mdta = (k: string) => `\x00\x00\x00${String.fromCharCode(8 + k.length)}mdta${k}`;
const item = (n: number, v: string) => `\x00\x00\x00\x00\x00\x00\x00${String.fromCharCode(n)}\x00\x00\x00\x00data\x00\x00\x00\x01\x00\x00\x00\x00${v}`;
const mp4 = (value: string) =>
  Buffer.from(
    `\x00\x00\x00\x18ftypisom\x00\x00\x02\x00moovudtameta\x00\x00\x00\x00keys\x00\x00\x00\x05${mdta("major_brand")}${mdta("minor_version")}${mdta("compatible_brands")}${mdta("AIGC")}${mdta("encoder")}ilst${item(1, "isom")}${item(2, "512")}${item(3, "isomiso2avc1mp41")}${item(4, value)}${item(5, "Lavf60.16.100")}\x00\x00mdat`,
    "latin1",
  );
// The measured shape (54 labelled WebMs, 2026-11-28) with stand-in values: never a real id or signature.
const sig = { Type: "x", AlgID: "y", TBSData: { Type: "z" }, Signature: "0f".repeat(32) };
const pub = [sig, { ...sig, TBSData: { Type: "z", BType: "w" } }, { Type: "x", AlgID: "y", TBSData: { Type: "z" }, KeyValue: "0f".repeat(32) }];
const security = (type = "TC260PG", entries: unknown[] = pub) => JSON.stringify({ SecurityData: { Type: type, Version: 1, PubSD: entries, Bindings: [sig] } });
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

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function run(media: Record<string, Buffer> | null, opts: { providers?: string } = {}): { status: number; out: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-check-"));
  roots.push(root);
  const cc = path.join(root, "cc");
  mkdirSync(path.join(cc, "lib", "server"), { recursive: true });
  mkdirSync(path.join(root, "schemas"), { recursive: true });
  cpSync(path.join(CC, "..", "schemas", "model_registry.json"), path.join(root, "schemas", "model_registry.json"));
  if (opts.providers !== undefined) writeFileSync(path.join(cc, "lib", "server", "provider-names.ts"), opts.providers);
  else cpSync(path.join(CC, "lib", "server", "provider-names.ts"), path.join(cc, "lib", "server", "provider-names.ts"));
  if (media) {
    const dir = path.join(cc, ".next", "static", "media");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(media)) writeFileSync(path.join(dir, name), body);
  }
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: cc, encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe("media-bundle-check: the signed implicit label is kept, nothing else that names a vendor is", () => {
  it("passes a build without any tag", () => {
    expect(run({ "clip.1.webm": webm('{"x":"y"}'), "clip.2.mp4": Buffer.from("ftypisom\x00\x00mdat", "latin1") }).status).toBe(0);
  });

  it("passes an exact, real-shaped label in a WebM and in an MP4", () => {
    const r = run({ "clip.1.webm": webm(exact), "clip.2.mp4": mp4(exact) });
    expect(r.status).toBe(0);
    expect(r.out).toContain("2 carry a maker's signed implicit label");
  });

  it("passes the repository's own showcase clips, which carry the real labels, in the WebMs and the MP4s", () => {
    const dir = path.join(CC, "components", "site", "showcase");
    const media: Record<string, Buffer> = {};
    for (const job of readdirSync(dir)) {
      for (const name of ["clip-sm.webm", "clip-sm.mp4"]) {
        const f = path.join(dir, job, name);
        if (existsSync(f)) media[`${job.slice(0, 8)}.${name}`] = readFileSync(f);
      }
    }
    expect(Object.keys(media).length).toBeGreaterThan(0);
    const r = run(media);
    expect(r.status).toBe(0);
    // Every labelled clip-sm.webm and its clip-sm.mp4 (the MP4's value sits further from its key than a WebM's).
    const webms = Object.entries(media).filter(([name, b]) => name.endsWith(".webm") && b.includes("ProduceID")).length;
    expect(webms).toBeGreaterThan(0);
    expect(r.out).toContain(`; ${webms * 2} carry a maker's signed implicit label`);
  });

  it("fails the same vendor name outside the label, in the same file and in a poster's EXIF", () => {
    expect(run({ "clip.1.webm": Buffer.concat([webm(exact), Buffer.from("\x00\x00title=MiniMax H3 export\x00", "latin1")]) }).status).toBe(1);
    expect(run({ "clip.1.webm": webm(exact), "poster.2.webp": Buffer.from("RIFF\x00\x00\x00\x00WEBPEXIF\x10\x00\x00\x00MM\x00*MiniMax\x00", "latin1") }).status).toBe(1);
  });

  it("fails a tampered label: an extra key, a missing key, the wrong Type, a value that is not a string", () => {
    const bad: Label[] = [
      { ...label(), Note: "" },
      Object.fromEntries(Object.entries(label()).filter(([k]) => k !== "PropagateID")),
      label({ ReservedCode1: security("TC260XX") }),
      label({ Label: 1 }),
      // A signature entry with a field the measured shapes never had.
      label({ ReservedCode1: security("TC260PG", [{ ...sig, Comment: "x" }]) }),
    ];
    for (const v of bad) expect(run({ "clip.1.webm": webm(JSON.stringify(v)) }).status, JSON.stringify(Object.keys(v))).toBe(1);
  });

  it("fails a label moved away from its AIGC key: the exemption is the tag, not the text", () => {
    expect(run({ "clip.1.webm": Buffer.from(`${head}AIGC\x00${"\xff".repeat(2048)}${exact}\x00`, "latin1") }).status).toBe(1);
  });

  it("fails a provenance key or a 32-hex id under AIGC in any other shape, and prints no part of the id", () => {
    const id = "0123456789abcdef".repeat(2);
    const r = run({ "clip.1.webm": webm(`{"Label":"AI-generated","Id":"${id}"}`) });
    expect(r.status).toBe(1);
    expect(r.out).not.toContain(id.slice(0, 8));
    for (const key of ["ProduceID", "ContentPropagator", "SecurityData", "TC260"]) {
      expect(run({ "clip.1.webm": webm(`{"Label":"1","${key}":"x"}`) }).status, key).toBe(1);
    }
  });

  it("a short name only inside text: 'Luma' in binary noise is not a tag, 'Luma' in a tag value is", () => {
    expect(run({ "font.1.woff2": Buffer.from("\x00\x8f\x13Luma\x91\x00", "latin1") }).status).toBe(0);
    expect(run({ "clip.1.webm": webm('{"ContentProducer":"Luma"}') }).status).toBe(1);
  });
});

describe("media-bundle-check: exits 2 when it could not run", () => {
  it("with no build, or an empty media folder", () => {
    expect(run(null).status).toBe(2);
    expect(run({}).status).toBe(2);
  });

  it("when the provider map is no longer the object literal it reads", () => {
    expect(run({ "clip.1.webm": webm(exact) }, { providers: 'import "server-only";\nexport const PROVIDER_NAMES = new Map();\n' }).status).toBe(2);
  });
});
