#!/usr/bin/env node
/**
 * After `next build`: no file under .next/static/media/ (the clips, posters and fonts anyone can download from /) carries a
 * vendor's name or a vendor's job id, except inside the one thing we are bound to keep: a maker's signed implicit AI label.
 *
 * Why the exemption: docs/AI_DISCLOSURE.md "Vendor watermarks and provenance" (owner decision 2026-11-12, and our letters to the
 * makers of 2026-11-11) says invisible provenance is always kept, never stripped or replaced, and the owner confirmed it for the
 * site's samples. MiniMax's files carry such a label: a format-level `AIGC` tag in the TC260 shape, which names the maker
 * ("ContentProducer"), gives its job id ("ProduceID", 32 hex) and holds its SM2 signatures ("ReservedCode1": {"SecurityData":
 * {"Type":"TC260PG",…}}). tools/export_showcase.py keeps it in every copy. Anything else that names a vendor in a media file
 * (another tag, an EXIF Make, an XMP packet, a tampered or look-alike AIGC value) is not provenance we have to keep, and fails.
 *
 * The exemption is exact (isSignedImplicitLabel): an `AIGC` key, its value within AIGC_GAP bytes (8 in a WebM SimpleTag, 51 in
 * an MP4 keys/ilst pair, measured), a JSON object with exactly LABEL_KEYS, every value a string, and ReservedCode1 a JSON object
 * of exactly the signature block's shape with SecurityData.Type "TC260PG". Only that value's bytes are skipped; the rest of the
 * file is scanned as if it were not there. A maker that changes the shape fails the build loudly: read the new shape, then
 * decide, never widen this quietly.
 *
 * Every file is read byte for byte as latin1 text, for:
 *   1. a vendor display name: the provider map in lib/server/provider-names.ts (read the same way scripts/vendor-bundle-check.mjs
 *      reads it) and every model display_name in schemas/model_registry.json. Case-sensitive. A name of six characters or more is
 *      matched anywhere: a compressed stream reproduces six given bytes about once in 2.8e14 positions. A shorter one ("Luma",
 *      "Kling") would turn up by chance in a few hundred MB of video, so it counts only inside a run of at least SHORT_CONTEXT
 *      printable characters, which is how a tag value is written (JSON, XMP, key=value);
 *   2. the implicit label's own keys (VENDOR_LABEL_KEYS) outside an exempted value;
 *   3. any run of 32 hex digits in the AIGC_WINDOW bytes after an "AIGC" that is not the exempted value.
 *
 * Controls, so a pass is not a scan of the wrong thing: in memory, before the scan, a planted vendor tag must be caught on every
 * count, a tampered label must be caught, and an exact one must pass; and the build must have more than 0 media files.
 *
 * Exit 1 on a leak, 2 when the check could not run (no build, no media, or a source no longer in the shape read here: a pass
 * then would mean nothing). Run from command-center/ after `next build`: `node scripts/media-bundle-check.mjs`. Prints file
 * names and what matched, never the matched bytes.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MEDIA = path.join(ROOT, ".next", "static", "media");
const PROVIDERS = path.join(ROOT, "lib", "server", "provider-names.ts");
const REGISTRY = path.join(ROOT, "..", "schemas", "model_registry.json");

/** The TC260 implicit label's keys, exactly (measured on the 54 labelled WebMs, 2026-11-28). */
export const LABEL_KEYS = ["Label", "ContentProducer", "ProduceID", "ReservedCode1", "ContentPropagator", "PropagateID", "ReservedCode2"];
/** Provenance-looking keys that fail anywhere outside an exempted value. */
export const VENDOR_LABEL_KEYS = ["ProduceID", "ContentPropagator", "PropagateID", "ReservedCode1", "ReservedCode2", "TC260", "SecurityData"];
/** Below this length a name is matched only inside a printable run (see 1. above). */
export const SHORT_NAME = 6;
/** The shortest printable run a short name counts in: the name and at least a key's worth of text around it. */
export const SHORT_CONTEXT = 12;
/** How far after the "AIGC" key its value may start. */
export const AIGC_GAP = 64;
/** How far after "AIGC" a 32-hex id is looked for. */
export const AIGC_WINDOW = 4096;

const fail2 = (msg) => {
  console.error(`media-bundle-check: ${msg}`);
  process.exit(2);
};

const PRINTABLE_RUN = /[\x20-\x7e]{8,}/g;
const HEX32 = /[0-9a-fA-F]{32}/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exactKeys = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const isStr = (v) => typeof v === "string";

/**
 * One entry of the signature block, in the shapes measured on all 54 labelled WebMs (2026-11-28; PubSD held three, Bindings one):
 * {Type, AlgID, TBSData, Signature} or {Type, AlgID, TBSData, KeyValue}, with TBSData {Type} or {Type, BType}, every value a
 * string.
 */
function isSecurityEntry(e) {
  const body = exactKeys(e, ["Type", "AlgID", "TBSData", "Signature"]) || exactKeys(e, ["Type", "AlgID", "TBSData", "KeyValue"]);
  const tbs = exactKeys(e?.TBSData, ["Type"]) || exactKeys(e?.TBSData, ["Type", "BType"]);
  return body && tbs && Object.entries(e).every(([k, v]) => k === "TBSData" || isStr(v)) && Object.values(e.TBSData).every(isStr);
}

/** Whether a parsed AIGC value is exactly a maker's signed TC260 implicit label (the module comment, "the exemption"). */
export function isSignedImplicitLabel(v) {
  if (!exactKeys(v, LABEL_KEYS) || !LABEL_KEYS.every((k) => isStr(v[k]))) return false;
  let rc;
  try {
    rc = JSON.parse(v.ReservedCode1);
  } catch {
    return false;
  }
  if (!exactKeys(rc, ["SecurityData"])) return false;
  const sd = rc.SecurityData;
  return exactKeys(sd, ["Type", "Version", "PubSD", "Bindings"]) && sd.Type === "TC260PG" && Number.isInteger(sd.Version)
    && Array.isArray(sd.PubSD) && sd.PubSD.length > 0 && sd.PubSD.every(isSecurityEntry)
    && Array.isArray(sd.Bindings) && sd.Bindings.length > 0 && sd.Bindings.every(isSecurityEntry);
}

/**
 * The [start, end) ranges of exempted values: after each "AIGC", the printable run that starts with "{" within AIGC_GAP, cut at
 * the longest prefix that parses as JSON, kept only when it is exactly a signed implicit label.
 */
export function exemptRanges(text) {
  const out = [];
  for (let i = text.indexOf("AIGC"); i !== -1; i = text.indexOf("AIGC", i + 4)) {
    const start = text.indexOf("{", i + 4);
    if (start === -1 || start - (i + 4) > AIGC_GAP) continue;
    const run = text.slice(start, start + (1 << 20)).match(/^[\x20-\x7e]+/)?.[0] ?? "";
    for (let end = run.lastIndexOf("}"); end > 0; end = run.lastIndexOf("}", end - 1)) {
      let v;
      try {
        v = JSON.parse(run.slice(0, end + 1));
      } catch {
        continue;
      }
      if (isSignedImplicitLabel(v)) out.push([start, start + end + 1]);
      break;
    }
  }
  return out;
}

/** The vendor names to look for: the provider map's display names and the registry's model names. */
function readNames() {
  if (!existsSync(PROVIDERS)) fail2("lib/server/provider-names.ts not found — run from command-center/.");
  const src = readFileSync(PROVIDERS, "utf8");
  const block = src.match(/const PROVIDER_NAMES[^=]*=\s*\{([\s\S]*?)\};/);
  if (!block) fail2("PROVIDER_NAMES is no longer an object literal in lib/server/provider-names.ts — update readNames().");
  const providers = [...block[1].matchAll(/^\s*["']?([a-z0-9_-]+)["']?:\s*"([^"]+)",?\s*$/gm)].map((m) => m[2]);
  if (providers.length < 8) fail2(`read only ${providers.length} PROVIDER_NAMES entries — its shape changed.`);
  if (!existsSync(REGISTRY)) fail2("schemas/model_registry.json not found — run from command-center/ in the repository.");
  let models;
  try {
    models = JSON.parse(readFileSync(REGISTRY, "utf8")).models;
  } catch {
    fail2("schemas/model_registry.json is not JSON.");
  }
  const display = (Array.isArray(models) ? models : []).map((m) => m?.display_name).filter((n) => typeof n === "string" && n.length >= 3);
  if (display.length < 10) fail2(`read only ${display.length} model display names from schemas/model_registry.json — its shape changed.`);
  return [...new Set([...providers, ...display])];
}

/** One pattern per name or key, each with what it is (printed instead of the match). */
export function patterns(names) {
  return [...names.map((n) => ({ label: `vendor name "${n}"`, text: n })), ...VENDOR_LABEL_KEYS.map((k) => ({ label: `provenance key ${k}`, text: k }))].map(
    (p) => ({ ...p, short: p.text.length < SHORT_NAME }),
  );
}

/** What is wrong with one file's bytes (read as latin1): the labels, and how many values were exempted. */
export function findLeaks(raw, list) {
  const ranges = exemptRanges(raw);
  // The exempted values become spaces: same length, so every other offset is unchanged, and nothing in them can match.
  let text = raw;
  for (const [a, b] of ranges) text = text.slice(0, a) + " ".repeat(b - a) + text.slice(b);
  const hits = new Set();
  let runs = null;
  for (const p of list) {
    if (!text.includes(p.text)) continue;
    if (!p.short) {
      hits.add(p.label);
      continue;
    }
    runs ??= text.match(/[\x20-\x7e]+/g) ?? [];
    if (runs.some((r) => r.length >= SHORT_CONTEXT && r.includes(p.text))) hits.add(p.label);
  }
  for (let i = text.indexOf("AIGC"); i !== -1; i = text.indexOf("AIGC", i + 4)) {
    if ((text.slice(i, i + 4 + AIGC_WINDOW).match(PRINTABLE_RUN) ?? []).some((r) => HEX32.test(r))) {
      hits.add("a 32-hex id in an AIGC value that is not a signed implicit label");
      break;
    }
  }
  return { hits: [...hits], exempted: ranges.length };
}

/** A label in the measured shape, with stand-in values (the self-test's and the tests' sample). */
export function sampleLabel(producer, overrides = {}) {
  const sig = { Type: "x", AlgID: "y", TBSData: { Type: "z" }, Signature: "0f".repeat(32) };
  const pub = [sig, { ...sig, TBSData: { Type: "z", BType: "w" } }, { Type: "x", AlgID: "y", TBSData: { Type: "z" }, KeyValue: "0f".repeat(32) }];
  return {
    Label: "1",
    ContentProducer: producer,
    ProduceID: "0f".repeat(16),
    ReservedCode1: JSON.stringify({ SecurityData: { Type: "TC260PG", Version: 1, PubSD: pub, Bindings: [sig] } }),
    ContentPropagator: producer,
    PropagateID: "",
    ReservedCode2: "",
    ...overrides,
  };
}

function filesUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

function main() {
  if (!existsSync(MEDIA)) fail2(".next/static/media not found — run `next build` first.");
  const list = patterns(readNames());

  // Self-test: an exact label passes; the same vendor name outside it and a tampered label (an extra key, the wrong Type) are
  // caught. A broken pattern fails here, before a clean scan can be read as a clean build.
  const vendor = list.find((p) => p.text === "MiniMax") ?? list[0];
  const tag = (v) => `\x1a\x45\xdf\xa3\x00AIGC\x44\x87\x80${JSON.stringify(v)}\x00\xff`;
  const exact = findLeaks(tag(sampleLabel(vendor.text)), list);
  if (exact.hits.length || exact.exempted !== 1) fail2(`self-test: an exact signed label is not exempted (${exact.hits.join(", ")}).`);
  if (!findLeaks(`${tag(sampleLabel(vendor.text))}\x00title=${vendor.text}\x00`, list).hits.includes(vendor.label)) {
    fail2("self-test: a vendor name outside the label is not caught.");
  }
  const extra = findLeaks(tag({ ...sampleLabel(vendor.text), Extra: "" }), list).hits;
  const wrongType = findLeaks(tag(sampleLabel(vendor.text, { ReservedCode1: JSON.stringify({ SecurityData: { Type: "X", Version: 1, PubSD: [], Bindings: [] } }) })), list).hits;
  for (const [name, hits] of [["an extra key", extra], ["the wrong Type", wrongType]]) {
    if (!hits.includes(vendor.label) || !hits.includes("provenance key ProduceID")) fail2(`self-test: a label with ${name} is not caught.`);
  }

  const files = filesUnder(MEDIA);
  if (files.length === 0) fail2(".next/static/media is empty — the build's media are no longer there, so this reads nothing.");
  let exempted = 0;
  const leaks = [];
  for (const f of files) {
    const r = findLeaks(readFileSync(f).toString("latin1"), list);
    if (r.exempted) exempted++;
    if (r.hits.length) leaks.push(`  ${path.relative(ROOT, f)}: ${r.hits.join(", ")}`);
  }
  if (leaks.length) {
    console.error(`media-bundle-check: ${leaks.length} of ${files.length} files under .next/static/media name a vendor outside a signed implicit label:`);
    console.error(leaks.join("\n"));
    console.error('Only a maker\'s signed TC260 AIGC label is kept (docs/AI_DISCLOSURE.md "Vendor watermarks and provenance"); find what wrote the rest.');
    process.exit(1);
  }
  console.log(`media-bundle-check: ${files.length} files under .next/static/media; ${exempted} carry a maker's signed implicit label (kept, docs/AI_DISCLOSURE.md); none names a vendor anywhere else.`);
}

main();
