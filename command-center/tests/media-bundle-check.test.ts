import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * scripts/media-bundle-check.mjs on stand-in builds. A maker's signed implicit label (MiniMax's TC260 `AIGC` tag) is kept on the
 * site's clips (docs/AI_DISCLOSURE.md "Vendor watermarks and provenance"), so exactly that tag, in its own tag value, on its own
 * job's file, is exempt; the same vendor name or a job id anywhere else, or in a forged, moved or tampered tag, still fails. The
 * attacks themselves are in tests/security-media-bundle-breach.test.ts.
 */

const CC = process.cwd();
const SCRIPT = path.join(CC, "scripts", "media-bundle-check.mjs");
type Label = Record<string, unknown>;

const be32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b.toString("latin1");
};
const box = (type: string, body: string) => be32(8 + body.length) + type + body;
const ebmlSize = (n: number) => {
  let len = 1;
  while (n >= 2 ** (7 * len) - 1) len++;
  const out = Buffer.alloc(len);
  out.writeUIntBE(n + 2 ** (7 * len), 0, len);
  return out.toString("latin1");
};
const head = "\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01";
// A WebM SimpleTag: TagName "AIGC", then TagString with its real size.
const webm = (value: string, tail = "") => Buffer.from(`${head}\x67\xc8\x45\xa3\x84AIGC\x44\x87${ebmlSize(value.length)}${value}\x67\xc8${tail}`, "latin1");
// An MP4 the way ffmpeg writes use_metadata_tags: moov/udta/meta (a full box) holding hdlr, keys (every key) and ilst (the values
// by key index, each in one `data` box of type 1).
const mp4 = (tags: [string, string][]) => {
  const keys = box("keys", "\x00\x00\x00\x00" + be32(tags.length) + tags.map(([k]) => box("mdta", k)).join(""));
  const ilst = box("ilst", tags.map(([, v], i) => be32(8 + 16 + v.length) + be32(i + 1) + box("data", be32(1) + be32(0) + v)).join(""));
  const meta = box("meta", "\x00\x00\x00\x00" + box("hdlr", "\x00".repeat(8) + "mdta" + "\x00".repeat(13)) + keys + ilst);
  return Buffer.from(box("ftyp", "isom\x00\x00\x02\x00isomiso2") + box("moov", box("udta", meta)) + box("mdat", "\x00".repeat(16)), "latin1");
};
const ffTags = (aigc: string): [string, string][] => [["major_brand", "isom"], ["minor_version", "512"], ["compatible_brands", "isomiso2avc1mp41"], ["AIGC", aigc], ["encoder", "Lavf60.16.100"]];
// The measured shape (54 labelled WebMs, 2026-11-28) with stand-in values: never a real id or signature.
const SM2 = "1.2.156.10197.1.501";
const security = (type = "TC260PG") =>
  JSON.stringify({
    SecurityData: {
      Type: type,
      Version: 1,
      PubSD: [
        { Type: "DS", AlgID: SM2, TBSData: { Type: "LabelMataData" }, Signature: "0f".repeat(64) },
        { Type: "DS", AlgID: SM2, TBSData: { Type: "Binding", BType: "0" }, Signature: "0f".repeat(64) },
        { Type: "PubKey", AlgID: SM2, TBSData: { Type: "" }, KeyValue: "0f".repeat(33) },
      ],
      Bindings: [{ Type: "Hash", AlgID: "1.2.156.10197.1.401", TBSData: { Type: "" }, Signature: "0f".repeat(32) }],
    },
  });
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

type Layout = { media?: Record<string, Buffer | { link: string }> | null; providers?: string; repo?: boolean; args?: string[]; ci?: boolean };

/** A stand-in command-center. `repo` links the real showcase sources and data file in, so the job binding applies. */
function run({ media = {}, providers, repo = false, args = [], ci = false }: Layout): { status: number; out: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-check-"));
  roots.push(root);
  const cc = path.join(root, "cc");
  mkdirSync(path.join(cc, "lib", "server"), { recursive: true });
  mkdirSync(path.join(root, "schemas"), { recursive: true });
  cpSync(path.join(CC, "..", "schemas", "model_registry.json"), path.join(root, "schemas", "model_registry.json"));
  if (providers !== undefined) writeFileSync(path.join(cc, "lib", "server", "provider-names.ts"), providers);
  else cpSync(path.join(CC, "lib", "server", "provider-names.ts"), path.join(cc, "lib", "server", "provider-names.ts"));
  if (repo) {
    mkdirSync(path.join(cc, "lib", "site"), { recursive: true });
    mkdirSync(path.join(cc, "components", "site"), { recursive: true });
    cpSync(path.join(CC, "lib", "site", "showcase.json"), path.join(cc, "lib", "site", "showcase.json"));
    symlinkSync(path.join(CC, "components", "site", "showcase"), path.join(cc, "components", "site", "showcase"));
  }
  if (media) {
    const dir = path.join(cc, ".next", "static", "media");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(media)) {
      if (Buffer.isBuffer(body)) writeFileSync(path.join(dir, name), body);
      else symlinkSync(body.link, path.join(dir, name));
    }
  }
  // CI is cleared unless a case sets it: a stand-in build without showcase sources is refused when CI is set.
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: cc, encoding: "utf8", env: { ...process.env, CI: ci ? "true" : "" } });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe("media-bundle-check: the signed implicit label is kept, nothing else that names a vendor is", () => {
  it("passes a build without any tag", () => {
    expect(run({ media: { "clip.1.webm": webm('{"x":"y"}'), "clip.2.mp4": mp4([["encoder", "Lavf60.16.100"]]) } }).status).toBe(0);
  });

  it("passes an exact, real-shaped label in a WebM and in an MP4 (its value 142 bytes past its key, as in the real files)", () => {
    const r = run({ media: { "clip.1.webm": webm(exact), "clip.2.mp4": mp4(ffTags(exact)) } });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("2 carry a maker's signed implicit label");
    expect(r.out).toContain("NOT bound to a job");
  });

  it("in the repository: every rendition of every labelled sample is exempt and bound to its job, and nothing else is", () => {
    // Every clip of every job, linked into the stand-in build (the bundler copies them byte for byte).
    const dir = path.join(CC, "components", "site", "showcase");
    const media: Record<string, { link: string }> = {};
    const labelled = new Set<string>();
    for (const job of readdirSync(dir)) {
      for (const name of ["clip.mp4", "clip.webm", "clip-sm.mp4", "clip-sm.webm"]) {
        const f = path.join(dir, job, name);
        if (!existsSync(f)) continue;
        const built = `${job.slice(0, 8)}.${name}`;
        media[built] = { link: f };
        // A labelled WebM makes all four of its job's renditions expected: a lost full-size MP4 label must fail here.
        if (name.endsWith(".webm") && readFileSync(f).includes("ProduceID")) for (const n of ["clip.mp4", "clip.webm", "clip-sm.mp4", "clip-sm.webm"]) labelled.add(`${job.slice(0, 8)}.${n}`);
      }
    }
    expect(labelled.size).toBeGreaterThan(0);
    const r = run({ media, repo: true, args: ["--report-exempt"] });
    expect(r.status, r.out).toBe(0);
    const exempt = new Set([...r.out.matchAll(/^exempt: \.next\/static\/media\/(.+)$/gm)].map((m) => m[1]));
    expect([...exempt].sort()).toEqual([...labelled].sort());
    expect(r.out).toContain(`${labelled.size} carry a maker's signed implicit label`);
    expect(r.out).toContain("bound to their jobs");
  }, 60_000);

  it("in the repository: a real labelled clip under a name the build gave it, but not a showcase file's bytes, is not exempt", () => {
    const dir = path.join(CC, "components", "site", "showcase");
    const job = readdirSync(dir).find((j) => existsSync(path.join(dir, j, "clip-sm.webm")) && readFileSync(path.join(dir, j, "clip-sm.webm")).includes("ProduceID"));
    expect(job).toBeTruthy();
    const altered = Buffer.concat([readFileSync(path.join(dir, job as string, "clip-sm.webm")), Buffer.from("\x00", "latin1")]);
    expect(run({ media: { "x.webm": altered }, repo: true }).status).toBe(1);
  }, 60_000);

  it("fails the same vendor name outside the label, in the same file and in a poster's EXIF", () => {
    expect(run({ media: { "clip.1.webm": webm(exact, "\x00\x00title=MiniMax H3 export\x00") } }).status).toBe(1);
    expect(run({ media: { "clip.1.webm": webm(exact), "poster.2.webp": Buffer.from("RIFF\x00\x00\x00\x00WEBPEXIF\x10\x00\x00\x00MM\x00*MiniMax\x00", "latin1") } }).status).toBe(1);
  });

  it("fails a tampered label: an extra key, a missing key, the wrong Type, a value that is not a string, a reordered key", () => {
    const { Label: l, ...rest } = label();
    const bad: Label[] = [
      { ...label(), Note: "" },
      Object.fromEntries(Object.entries(label()).filter(([k]) => k !== "PropagateID")),
      label({ ReservedCode1: security("TC260XX") }),
      label({ Label: 1 }),
      { ...rest, Label: l },
    ];
    for (const v of bad) expect(run({ media: { "clip.1.webm": webm(JSON.stringify(v)) } }).status, JSON.stringify(Object.keys(v))).toBe(1);
  });

  it("Lens's forged label: another maker with free text in a shape-valid label is not exempt", () => {
    const forged = label({ ContentProducer: "Kling", ContentPropagator: "Kling", ReservedCode2: "made with Kling 3.0, task 7" });
    expect(run({ media: { "clip.1.webm": webm(JSON.stringify(forged)) } }).status).toBe(1);
  });

  it("Lens's cross-key repro: a label 900 bytes after an AIGC key, behind another key (XMP), is not that key's value", () => {
    const file = Buffer.from(`${head}AIGC${"\xff".repeat(900)}XMP\x00${exact}\x00`, "latin1");
    expect(run({ media: { "clip.1.webm": file } }).status).toBe(1);
  });

  it("Lens's false positive: an earlier '{' in another tag does not hide the real label from the exemption", () => {
    const tags: [string, string][] = [["comment", '{"x":1}'], ...ffTags(exact)];
    expect(run({ media: { "clip.1.mp4": mp4(tags) } }).status).toBe(0);
  });

  it("fails a provenance key or a 32-hex id under AIGC in any other shape, and prints no part of the id", () => {
    const id = "9a3c51e07b2d48f6a1c0e5d7b3f9420c";
    const r = run({ media: { "clip.1.webm": webm(`{"Label":"AI-generated","Id":"${id}"}`) } });
    expect(r.status).toBe(1);
    expect(r.out).not.toContain(id.slice(0, 8));
    for (const key of ["ProduceID", "ContentPropagator", "SecurityData", "TC260"]) {
      expect(run({ media: { "clip.1.webm": webm(`{"Label":"1","${key}":"x"}`) } }).status, key).toBe(1);
    }
  });

  it("a name of any length in a parsed tag value fails, and the real tags our muxers write do not", () => {
    for (const v of ["Veo 3", "Wan 2.7 render", "made by xai", "GPT"]) expect(run({ media: { "clip.1.mp4": mp4([["comment", v]]) } }).status, v).toBe(1);
    expect(run({ media: { "clip.1.mp4": mp4([["Luma", "x"]]) } }).status, "an mdta key").toBe(1);
    // Words that only contain a name are not it: "Lavf", "isomiso2avc1mp41", "VideoHandler", "Advent", "veoh".
    expect(run({ media: { "clip.1.mp4": mp4([["encoder", "Lavf60.16.100"], ["compatible_brands", "isomiso2avc1mp41"], ["handler", "VideoHandler"], ["comment", "Advent veoh"]]) } }).status).toBe(0);
  });

  it("a short name only inside text: 'Luma' in binary noise is not a tag, 'Luma' in a tag value is", () => {
    expect(run({ media: { "font.1.woff2": Buffer.from("\x00\x8f\x13Luma\x91\x01", "latin1") } }).status).toBe(0);
    expect(run({ media: { "clip.1.webm": webm('{"ContentProducer":"Luma"}') } }).status).toBe(1);
  });
});

describe("media-bundle-check: exits 2 when it could not run", () => {
  it("with no build, or an empty media folder", () => {
    expect(run({ media: null }).status).toBe(2);
    expect(run({ media: {} }).status).toBe(2);
  });

  it("when the provider map is no longer the object literal it reads", () => {
    expect(run({ media: { "clip.1.webm": webm(exact) }, providers: 'import "server-only";\nexport const PROVIDER_NAMES = new Map();\n' }).status).toBe(2);
  });

  it("in CI, when the showcase sources are not there to bind a label to its job (the unbound fallback never runs in CI)", () => {
    expect(run({ media: { "clip.1.webm": webm(exact) }, ci: true }).status).toBe(2);
    expect(run({ media: { "clip.1.webm": webm(exact) } }).status).toBe(0);
  });

  it("in the repository, when a labelled sample is missing from the build", () => {
    expect(run({ media: { "font.1.woff2": Buffer.from("wOF2", "latin1") }, repo: true }).status).toBe(2);
  }, 60_000);
});
