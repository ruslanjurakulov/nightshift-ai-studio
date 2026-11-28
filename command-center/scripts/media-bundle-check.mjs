#!/usr/bin/env node
/**
 * After `next build`: no file anyone can download from the site's media (.next/static/media/, and command-center/public/, served
 * from / as it is) names a vendor or carries a vendor job id, except inside the one thing we are bound to keep: a maker's signed
 * implicit AI label.
 *
 * Why the exemption: docs/AI_DISCLOSURE.md "Vendor watermarks and provenance" (owner decision 2026-11-12, and our letters to the
 * makers of 2026-11-11) says invisible provenance is always kept, never stripped or replaced, and the owner confirmed it for the
 * site's samples. MiniMax's files carry such a label: a format-level `AIGC` tag in the TC260 shape, which names the maker, gives
 * its job id (ProduceID) and holds its SM2 signatures. tools/export_showcase.py keeps it in every clip.
 *
 * The exemption is as narrow as the 54 labels measured on 2026-11-28, so it cannot carry anything else (Breach, PR #996):
 *   - only in a .mp4 or .webm, at most one label per file, and bound to its own tag value: in a WebM the TagString right after
 *     the TagName "AIGC", exactly as long as its EBML size says; in an MP4 the ilst item whose index is the key "AIGC" in
 *     moov/(udta/)meta/keys, exactly its `data` payload. Not "some JSON near the word AIGC";
 *   - the bytes are canonical JSON (JSON.stringify(JSON.parse(raw)) === raw, for the label and for ReservedCode1), so a duplicate
 *     key cannot hide a second value in the raw bytes;
 *   - the shape is LABEL_TEMPLATE exactly, key order included: the maker one of MAKERS (MiniMax only) and the propagator the
 *     same, Label "1", ProduceID 32 lowercase hex, PropagateID and ReservedCode2 empty, and a signature block of exactly the
 *     measured entries (types, OIDs and hex lengths). A maker that changes it fails the build loudly: read the new shape, then
 *     decide, never widen this quietly;
 *   - bound to its job: in the repository (components/site/showcase/ present) a built file is exempt only when its bytes are one
 *     of a showcase job's own files and lib/site/showcase.json says that job's provider is one of MAKER_PROVIDERS; and every
 *     labelled source clip must be in the build (exit 2 if one is missing: the scan would be reading the wrong files). In a
 *     stand-in build with no showcase sources (the tests) the binding cannot apply, and the summary says so.
 * Only that value's bytes are skipped (replaced by spaces); the rest of the file is scanned as if it were not there.
 *
 * Every file is read byte for byte as latin1 text, and as its UTF-16LE and UTF-16BE strings (an EXIF XPComment, a 3GPP udta
 * string), for:
 *   1. a vendor name (vendorNames): the provider map in lib/server/provider-names.ts (read the same way
 *      scripts/vendor-bundle-check.mjs reads it), the registry's display names and provider slugs, the brand word that starts each
 *      display name, and BRAND_WORDS. Six characters or more: case-insensitive, anywhere (a compressed stream reproduces six given
 *      letters in either case about once in 4e12 positions). Four or five: case-insensitive as a whole word inside a printable
 *      run of at least SHORT_CONTEXT characters (how a tag value is written), or case-sensitive as a whole NUL-terminated value
 *      (an EXIF Make, an MP4 ilst string). Three: case-sensitive as a whole word inside such a run only (as a bare value, three
 *      letters turn up by chance in a few hundred MB);
 *   2. the label's own keys (PROVENANCE_KEYS) outside an exempted value;
 *   3. every name at any length (three letters included), case-insensitive, as a whole word, in every tag key and value the
 *      container frames (structuralValues): a WebM SimpleTag, an MP4 ilst / keys / udta string;
 *   4. a vendor job id: a run of 32 hex digits or a UUID, with at least MIN_DISTINCT different digits (a flat poster's VP8 data
 *      holds runs like 38 times "3", which are not ids).
 * Under .next/static/media only the types the site imports (MEDIA_TYPES) may appear: anything else (JSON, SVG, PNG) can hold a
 * name in an encoding this scan does not read (\u escapes, base64, zlib), so it fails rather than pass unread. public/ is scanned
 * the same way, every file, with no exemption.
 *
 * Controls, so a pass is not a scan of the wrong thing: in memory, before the scan, an exact label must pass in both containers
 * and a forged, duplicated, moved or tampered one must be caught; and the build must have more than 0 media files.
 *
 * Exit 1 on a leak, 2 when the check could not run (no build, no media, a labelled source missing from the build, or a source no
 * longer in the shape read here: a pass then would mean nothing). Run from command-center/ after `next build`:
 * `node scripts/media-bundle-check.mjs [--report-exempt]`. Prints file names and what matched, never the matched bytes.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MEDIA = path.join(ROOT, ".next", "static", "media");
const PUBLIC = path.join(ROOT, "public");
const SHOWCASE = path.join(ROOT, "components", "site", "showcase");
const SHOWCASE_DATA = path.join(ROOT, "lib", "site", "showcase.json");
const PROVIDERS = path.join(ROOT, "lib", "server", "provider-names.ts");
const REGISTRY = path.join(ROOT, "..", "schemas", "model_registry.json");

/** The makers whose signed label is kept, as they write ContentProducer; and their provider slugs in lib/site/showcase.json. */
export const MAKERS = ["MiniMax"];
export const MAKER_PROVIDERS = ["minimax"];
/** What the bundler copies to static/media from our imports. Anything else there fails (see the module comment). */
export const MEDIA_TYPES = [".mp4", ".webm", ".webp", ".woff2"];
const LABELLED_TYPES = [".mp4", ".webm"];
/** Brand words that are no provider or model display name (product lines, parent companies), and the measured makers. */
export const BRAND_WORDS = ["Hailuo", "Seedance", "Seedream", "Vidu", "BytePlus", "Kuaishou", "Pika", "Veo", "Krea", "Recraft", "Lightricks", "xAI", "Grok"];
/** First words of display names that are ordinary words, not brands; slugs that are not vendor names. */
const NOT_BRANDS = new Set(["video", "nano", "grounded", "z", "meta", "unassigned-video-vendor"]);
/** Provenance-looking keys that fail anywhere outside an exempted value. */
export const PROVENANCE_KEYS = ["ProduceID", "ContentPropagator", "PropagateID", "ReservedCode1", "ReservedCode2", "SecurityData", "TC260"];
export const SHORT_CONTEXT = 12;
export const MIN_DISTINCT = 8;
/** A real label is ~1.1 KB; anything far larger is not one (and is not parsed). */
const MAX_LABEL = 16384;

const fail2 = (msg) => {
  console.error(`media-bundle-check: ${msg}`);
  process.exit(2);
};

// ── the label ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const SM2 = "1.2.156.10197.1.501";
const SM3 = "1.2.156.10197.1.401";
const hex = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
/** The signature block, exactly as all 54 measured labels carry it (values replaced by what they must match). */
const SECURITY_TEMPLATE = {
  SecurityData: {
    Type: "TC260PG",
    Version: 1,
    PubSD: [
      { Type: "DS", AlgID: SM2, TBSData: { Type: "LabelMataData" }, Signature: hex(128) },
      { Type: "DS", AlgID: SM2, TBSData: { Type: "Binding", BType: "0" }, Signature: hex(128) },
      { Type: "PubKey", AlgID: SM2, TBSData: { Type: "" }, KeyValue: hex(66) },
    ],
    Bindings: [{ Type: "Hash", AlgID: SM3, TBSData: { Type: "" }, Signature: hex(64) }],
  },
};
const CANONICAL_JSON = Symbol("canonical JSON of");
/** The label: the maker is filled in per MAKERS; ReservedCode1 is a string that must be canonical JSON of SECURITY_TEMPLATE. */
const labelTemplate = (maker) => ({
  Label: "1",
  ContentProducer: maker,
  ProduceID: hex(32),
  ReservedCode1: { [CANONICAL_JSON]: SECURITY_TEMPLATE },
  ContentPropagator: maker,
  PropagateID: "",
  ReservedCode2: "",
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Whether `raw` is canonical JSON (one parse, the same bytes back): no duplicate keys, no whitespace, no escapes it would not write. */
function canonical(raw) {
  try {
    const v = JSON.parse(raw);
    return JSON.stringify(v) === raw ? { v } : null;
  } catch {
    return null;
  }
}

function matches(v, t) {
  if (t instanceof RegExp) return typeof v === "string" && t.test(v);
  if (Array.isArray(t)) return Array.isArray(v) && v.length === t.length && t.every((x, i) => matches(v[i], x));
  if (isObj(t) && Object.hasOwn(t, CANONICAL_JSON)) {
    const c = typeof v === "string" ? canonical(v) : null;
    return !!c && matches(c.v, t[CANONICAL_JSON]);
  }
  if (isObj(t)) {
    const keys = Object.keys(t);
    return isObj(v) && Object.keys(v).length === keys.length && keys.every((k, i) => Object.keys(v)[i] === k && matches(v[k], t[k]));
  }
  return v === t;
}

/** Where a JSON object that starts at s[0] ends (exclusive), by one string-aware pass; -1 if it does not close. Linear. */
function jsonEnd(s) {
  if (s[0] !== "{") return -1;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Whether a tag value's exact bytes are a maker's signed implicit label. */
export function isSignedImplicitLabel(raw) {
  if (raw.length > MAX_LABEL || !/^[\x20-\x7e]+$/.test(raw) || jsonEnd(raw) !== raw.length) return false;
  const c = canonical(raw);
  return !!c && MAKERS.some((m) => matches(c.v, labelTemplate(m)));
}

// ── the label's place in its container ───────────────────────────────────────────────────────────────────────────────────────

/** An EBML variable-length integer at s[i]: its length and value, or null. */
function vint(s, i) {
  const first = s.charCodeAt(i);
  if (!(first > 0)) return null;
  const len = 9 - first.toString(2).length;
  if (len > 8 || i + len > s.length) return null;
  let value = first & ((1 << (8 - len)) - 1);
  for (let k = 1; k < len; k++) value = value * 256 + s.charCodeAt(i + k);
  return { len, value };
}

/** WebM: every SimpleTag value whose TagName is "AIGC" (TagName 0x45A3 size 4, then TagString 0x4487 and its size). */
function webmAigcValues(s) {
  const out = [];
  for (let i = s.indexOf("\x45\xa3\x84AIGC"); i !== -1; i = s.indexOf("\x45\xa3\x84AIGC", i + 1)) {
    const j = i + 7;
    if (s.slice(j, j + 2) !== "\x44\x87") {
      out.push(null);
      continue;
    }
    const n = vint(s, j + 2);
    out.push(n && n.value > 0 ? [j + 2 + n.len, j + 2 + n.len + n.value] : null);
  }
  return out;
}

const u32 = (s, i) => ((s.charCodeAt(i) << 24) >>> 0) + (s.charCodeAt(i + 1) << 16) + (s.charCodeAt(i + 2) << 8) + s.charCodeAt(i + 3);

/** The boxes in s[start, end): [type, bodyStart, end]. Stops at the first malformed box. */
function boxes(s, start, end) {
  const out = [];
  for (let i = start; i + 8 <= end; ) {
    let size = u32(s, i);
    let head = 8;
    if (size === 1) {
      if (i + 16 > end) break;
      size = u32(s, i + 8) * 2 ** 32 + u32(s, i + 12);
      head = 16;
    } else if (size === 0) size = end - i;
    if (size < head || i + size > end) break;
    out.push([s.slice(i + 4, i + 8), i + head, i + size]);
    i += size;
  }
  return out;
}

/** MP4: the `data` payload of every ilst item whose key in the same meta's keys box is mdta "AIGC" (moov/meta or moov/udta/meta). */
function mp4AigcValues(s) {
  const out = [];
  const moov = boxes(s, 0, s.length).filter((b) => b[0] === "moov");
  const metas = [];
  for (const [, a, b] of moov) {
    for (const child of boxes(s, a, b)) {
      if (child[0] === "meta") metas.push(child);
      if (child[0] === "udta") for (const m of boxes(s, child[1], child[2])) if (m[0] === "meta") metas.push(m);
    }
  }
  for (const [, a, b] of metas) {
    // QuickTime writes meta as a full box (4 bytes of version and flags before its children); try both.
    const kids = [a, a + 4].map((o) => boxes(s, o, b)).find((k) => k.some((x) => x[0] === "keys")) ?? [];
    const keys = kids.find((x) => x[0] === "keys");
    const ilst = kids.find((x) => x[0] === "ilst");
    if (!keys || !ilst) continue;
    const want = [];
    const count = u32(s, keys[1] + 4);
    for (let k = 0, p = keys[1] + 8; k < count && p + 8 <= keys[2]; k++) {
      const n = u32(s, p);
      if (n < 8 || p + n > keys[2]) break;
      if (s.slice(p + 4, p + 8) === "mdta" && s.slice(p + 8, p + n) === "AIGC") want.push(k + 1);
      p += n;
    }
    for (const idx of want) {
      const items = boxes(s, ilst[1], ilst[2]).filter((x) => u32(s, x[1] - 4) === idx);
      if (items.length !== 1) {
        out.push(null);
        continue;
      }
      const data = boxes(s, items[0][1], items[0][2]);
      // One `data` box, type 1 (UTF-8), locale 0: the value is the rest of it.
      const d = data.length === 1 && data[0][0] === "data" && u32(s, data[0][1]) === 1 && u32(s, data[0][1] + 4) === 0 ? data[0] : null;
      out.push(d ? [d[1] + 8, d[2]] : null);
    }
  }
  return out;
}

/**
 * Every tag key and value the container itself frames, as strings: a WebM SimpleTag's TagName and TagString (TagName 0x45A3, its
 * size and a printable name, then TagString 0x4487 and its size, optionally after a TagLanguage / TagDefault); an MP4's
 * moov/udta/meta keys (mdta names) and every `data` payload under an ilst, and the QuickTime udta strings (©xxx). Lenient about
 * the outer framing (a stand-in file need not have valid parent sizes), strict about the element itself. Breach, PR #996: a
 * short name in a short value ("Kling AI", a bare "Luma") is below what the loose scan can tell from chance; read as the tag value
 * it is, it is a name.
 */
export function structuralValues(s, ext) {
  const out = [];
  if (ext === ".webm") {
    for (let i = s.indexOf("\x45\xa3"); i !== -1; i = s.indexOf("\x45\xa3", i + 2)) {
      const n = vint(s, i + 2);
      if (!n || n.value < 1 || n.value > 256) continue;
      let p = i + 2 + n.len;
      const name = s.slice(p, p + n.value);
      if (name.length !== n.value || !/^[\x20-\x7e]+$/.test(name)) continue;
      out.push(name);
      p += n.value;
      // TagLanguage (0x447A) and TagDefault (0x4484) may sit between the name and the string.
      for (let k = 0; k < 2 && (s.slice(p, p + 2) === "\x44\x7a" || s.slice(p, p + 2) === "\x44\x84"); k++) {
        const m = vint(s, p + 2);
        if (!m) break;
        p += 2 + m.len + m.value;
      }
      if (s.slice(p, p + 2) !== "\x44\x87") continue;
      const m = vint(s, p + 2);
      if (m && m.value > 0) out.push(s.slice(p + 2 + m.len, p + 2 + m.len + m.value));
    }
  } else if (ext === ".mp4") {
    const walk = (a, b, depth, inIlst) => {
      if (depth > 6) return;
      for (const [type, start, end] of boxes(s, a, b)) {
        if (inIlst && type === "data") out.push(s.slice(start + 8, end));
        else if (type === "keys") {
          const count = u32(s, start + 4);
          for (let k = 0, q = start + 8; k < count && q + 8 <= end; k++) {
            const len = u32(s, q);
            if (len < 8 || q + len > end) break;
            out.push(s.slice(q + 8, q + len));
            q += len;
          }
        } else if (type === "meta") {
          walk(start, end, depth + 1, false);
          walk(start + 4, end, depth + 1, false);
        } else if (type === "ilst") walk(start, end, depth + 1, true);
        else if (inIlst && type !== "mdat" && type !== "free" && type !== "skip") walk(start, end, depth + 1, true);
        else if (type === "moov" || type === "udta" || type === "trak") walk(start, end, depth + 1, false);
        else if (type.charCodeAt(0) === 0xa9 && end - start > 4) out.push(s.slice(start + 4, end));
      }
    };
    walk(0, s.length, 0, false);
    // And every ilst by its fourcc, whatever its parents say: bounded by its own size when that is sane, else by the file.
    for (let i = s.indexOf("ilst"); i !== -1; i = s.indexOf("ilst", i + 4)) {
      const size = i >= 4 ? u32(s, i - 4) : 0;
      walk(i + 4, size >= 8 && i - 4 + size <= s.length ? i - 4 + size : s.length, 1, true);
    }
  }
  return out;
}

/** The byte range of the file's one signed label, or null (none, more than one AIGC value, or not exactly a label). */
export function labelRange(s, ext) {
  if (!LABELLED_TYPES.includes(ext)) return null;
  const values = ext === ".webm" ? webmAigcValues(s) : mp4AigcValues(s);
  if (values.length !== 1 || !values[0]) return null;
  const [a, b] = values[0];
  return isSignedImplicitLabel(s.slice(a, b)) ? [a, b] : null;
}

// ── what is looked for ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The vendor names: the provider map, the registry's display names, provider slugs and brand words, and BRAND_WORDS. */
function vendorNames() {
  if (!existsSync(PROVIDERS)) fail2("lib/server/provider-names.ts not found — run from command-center/.");
  const src = readFileSync(PROVIDERS, "utf8");
  const block = src.match(/const PROVIDER_NAMES[^=]*=\s*\{([\s\S]*?)\};/);
  if (!block) fail2("PROVIDER_NAMES is no longer an object literal in lib/server/provider-names.ts — update vendorNames().");
  const providers = [...block[1].matchAll(/^\s*["']?([a-z0-9_-]+)["']?:\s*"([^"]+)",?\s*$/gm)].map((m) => m[2]);
  if (providers.length < 8) fail2(`read only ${providers.length} PROVIDER_NAMES entries — its shape changed.`);
  if (!existsSync(REGISTRY)) fail2("schemas/model_registry.json not found — run from command-center/ in the repository.");
  let models;
  try {
    models = JSON.parse(readFileSync(REGISTRY, "utf8")).models;
  } catch {
    fail2("schemas/model_registry.json is not JSON.");
  }
  models = Array.isArray(models) ? models : [];
  const display = models.map((m) => m?.display_name).filter((n) => typeof n === "string" && n.length >= 3);
  const slugs = models.map((m) => m?.provider).filter((n) => typeof n === "string");
  if (display.length < 10 || slugs.length < 10) fail2(`read only ${display.length} display names and ${slugs.length} providers from schemas/model_registry.json — its shape changed.`);
  // "FLUX.2 Pro" -> "FLUX", "LTX-2.3" -> "LTX", "Qwen-Image" -> "Qwen".
  const brands = display.map((n) => n.split(/\s+/)[0].split(/[.-]/)[0]);
  return [...new Set([...providers, ...display, ...slugs, ...brands, ...BRAND_WORDS])].filter((n) => n.length >= 3 && !NOT_BRANDS.has(n.toLowerCase()));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** One matcher per name or key, each with what it is (printed instead of the match). */
export function patterns(names) {
  const word = (n, flags) => new RegExp(`(?<![A-Za-z0-9])${escape(n)}(?![A-Za-z0-9])`, flags);
  const out = names.map((n) => {
    const label = `vendor name "${n}"`;
    if (n.length >= 6) return { label, kind: "anywhere", lower: n.toLowerCase() };
    return { label, kind: "short", re: word(n, n.length >= 4 ? "i" : ""), whole: n.length >= 4 ? n : null };
  });
  for (const k of PROVENANCE_KEYS) {
    out.push(k.length >= 6 ? { label: `provenance key ${k}`, kind: "exact", text: k } : { label: `provenance key ${k}`, kind: "short", re: word(k, ""), whole: k });
  }
  // For a parsed tag value (structuralValues): every name at any length, three letters included, case-insensitive, as a whole
  // word. A tag value is text by construction, so the chance argument that limits the loose scan does not apply there.
  out.tagValue = new RegExp(`(?<![A-Za-z0-9])(?:${[...names].sort((a, b) => b.length - a.length).map(escape).join("|")})(?![A-Za-z0-9])`, "i");
  out.names = names;
  return out;
}

const HEX_RUN = /[0-9a-fA-F]{32,}/g;
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const distinct = (s) => new Set(s.toLowerCase().replace(/-/g, "")).size;

/** Whether some 32-digit window of a hex run is varied enough to be an id. */
function idLike(run) {
  for (let i = 0; i + 32 <= run.length; i++) if (distinct(run.slice(i, i + 32)) >= MIN_DISTINCT) return true;
  return false;
}

/** The text views of a file: the bytes as latin1, and the strings of its UTF-16LE and UTF-16BE runs (NUL-separated). */
function views(text) {
  const le = (text.match(/(?:[\x20-\x7e]\x00){4,}/g) ?? []).map((r) => r.replace(/\x00/g, ""));
  const be = (text.match(/(?:\x00[\x20-\x7e]){4,}/g) ?? []).map((r) => r.replace(/\x00/g, ""));
  return [text, `\x00${le.join("\x00")}\x00`, `\x00${be.join("\x00")}\x00`];
}

/** What is wrong with one view's text, added to `hits`. */
function scanText(text, list, hits) {
  const lower = text.toLowerCase();
  let runs = null;
  let values = null;
  for (const p of list) {
    if (p.kind === "anywhere") {
      if (lower.includes(p.lower)) hits.add(p.label);
    } else if (p.kind === "exact") {
      if (text.includes(p.text)) hits.add(p.label);
    } else {
      runs ??= text.match(/[\x20-\x7e]{12,}/g) ?? [];
      if (runs.some((r) => p.re.test(r))) hits.add(p.label);
      else if (p.whole) {
        // A whole value: a printable run that is exactly the name and ends at a NUL (an EXIF Make, an MP4 ilst string).
        values ??= new Set((text.match(/[\x20-\x7e]+(?=\x00)/g) ?? []).filter((r) => r.length <= 5));
        if (values.has(p.whole)) hits.add(p.label);
      }
    }
  }
  if ((text.match(HEX_RUN) ?? []).some(idLike)) hits.add("a 32-hex id");
  if ((text.match(UUID) ?? []).some((u) => distinct(u) >= MIN_DISTINCT)) hits.add("a UUID");
}

/**
 * What is wrong with one file (its bytes as latin1, its extension, and whether its label may be exempted): the labels, and
 * whether a label was exempted.
 */
export function findLeaks(raw, ext, list, allowLabel) {
  const range = allowLabel ? labelRange(raw, ext) : null;
  const text = range ? raw.slice(0, range[0]) + " ".repeat(range[1] - range[0]) + raw.slice(range[1]) : raw;
  const hits = new Set();
  for (const v of views(text)) scanText(v, list, hits);
  if (list.tagValue) {
    for (const value of structuralValues(text, ext)) {
      const m = value.match(list.tagValue);
      if (!m) continue;
      const name = list.names.find((n) => n.toLowerCase() === m[0].toLowerCase()) ?? m[0];
      hits.add(`vendor name "${name}" in a tag value`);
    }
  }
  return { hits: [...hits], exempted: !!range };
}

// ── the job binding ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * In the repository: sha256 -> the showcase file whose bytes they are, for files of jobs a kept maker made; and the labelled
 * source clips among them (each must be in the build). null when there are no showcase sources here (a stand-in build).
 */
function readBinding() {
  if (!existsSync(SHOWCASE)) {
    // The unbound fallback is for stand-in builds (the tests). In CI the repository is checked out, so its absence means the
    // scan is in the wrong place, and a pass would mean nothing.
    if (process.env.CI) fail2("components/site/showcase/ not found while CI is set — the label cannot be bound to its job; run from command-center/ in the repository.");
    return null;
  }
  if (!existsSync(SHOWCASE_DATA)) fail2("components/site/showcase/ is here but lib/site/showcase.json is not — a sample's maker cannot be read.");
  let entries;
  try {
    entries = JSON.parse(readFileSync(SHOWCASE_DATA, "utf8")).entries;
  } catch {
    fail2("lib/site/showcase.json is not JSON.");
  }
  if (!Array.isArray(entries) || entries.length === 0) fail2("lib/site/showcase.json has no entries — its shape changed.");
  const kept = new Set(entries.filter((e) => MAKER_PROVIDERS.includes(e?.provider)).map((e) => e.jobId));
  const byHash = new Map();
  const labelled = [];
  for (const job of readdirSync(SHOWCASE)) {
    if (!kept.has(job)) continue;
    const dir = path.join(SHOWCASE, job);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const ext = path.extname(name);
      if (!LABELLED_TYPES.includes(ext)) continue;
      const buf = readFileSync(path.join(dir, name));
      const h = sha(buf);
      byHash.set(h, `${job}/${name}`);
      if (labelRange(buf.toString("latin1"), ext)) labelled.push({ h, file: `${job}/${name}` });
    }
  }
  return { byHash, labelled };
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function filesUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/** The in-memory controls: an exact label passes in both containers; a forged, duplicated, moved or tampered one is caught. */
function selfTest(list) {
  const pubSig = "0f".repeat(64);
  const sample = (o = {}) => ({
    Label: "1",
    ContentProducer: "MiniMax",
    ProduceID: "0f".repeat(16),
    ReservedCode1: JSON.stringify({
      SecurityData: {
        Type: "TC260PG",
        Version: 1,
        PubSD: [
          { Type: "DS", AlgID: SM2, TBSData: { Type: "LabelMataData" }, Signature: pubSig },
          { Type: "DS", AlgID: SM2, TBSData: { Type: "Binding", BType: "0" }, Signature: pubSig },
          { Type: "PubKey", AlgID: SM2, TBSData: { Type: "" }, KeyValue: "0f".repeat(33) },
        ],
        Bindings: [{ Type: "Hash", AlgID: SM3, TBSData: { Type: "" }, Signature: "0f".repeat(32) }],
      },
    }),
    ContentPropagator: "MiniMax",
    PropagateID: "",
    ReservedCode2: "",
    ...o,
  });
  const size = (n) => String.fromCharCode(0x40 | (n >> 8), n & 0xff);
  const webm = (v) => `\x1a\x45\xdf\xa3\x45\xa3\x84AIGC\x44\x87${size(v.length)}${v}\x67\xc8`;
  const exact = JSON.stringify(sample());
  const ok = findLeaks(webm(exact), ".webm", list, true);
  if (ok.hits.length || !ok.exempted) fail2(`self-test: an exact signed label is not exempted (${ok.hits.join(", ")}).`);
  const bad = {
    "a forged maker": webm(JSON.stringify(sample({ ContentProducer: "Kling", ContentPropagator: "Kling" }))),
    "a duplicate key": webm(exact.replace('"ContentProducer":"MiniMax"', '"ContentProducer":"Runway","ContentProducer":"MiniMax"')),
    "an extra key": webm(JSON.stringify({ ...sample(), Note: "" })),
    "a name outside the label": `${webm(exact)}\x00title=MiniMax H3\x00`,
    "a label moved off its tag": `\x1a\x45\xdf\xa3AIGC${"\xff".repeat(900)}XMP\x00${exact}\x00`,
  };
  for (const [what, file] of Object.entries(bad)) {
    if (!findLeaks(file, ".webm", list, true).hits.length) fail2(`self-test: ${what} is not caught.`);
  }
}

function main() {
  const report = process.argv.includes("--report-exempt");
  if (!existsSync(MEDIA)) fail2(".next/static/media not found — run `next build` first.");
  const list = patterns(vendorNames());
  selfTest(list);
  const binding = readBinding();

  const media = filesUnder(MEDIA);
  if (media.length === 0) fail2(".next/static/media is empty — the build's media are no longer there, so this reads nothing.");
  const pub = existsSync(PUBLIC) ? filesUnder(PUBLIC) : [];
  const leaks = [];
  const exempted = [];
  const built = new Set();
  for (const [files, inMedia] of [[media, true], [pub, false]]) {
    for (const f of files) {
      const rel = path.relative(ROOT, f);
      const ext = path.extname(f).toLowerCase();
      if (inMedia && !MEDIA_TYPES.includes(ext)) {
        leaks.push(`  ${rel}: a file type this check cannot read (${ext || "no extension"}) — only ${MEDIA_TYPES.join(", ")} belong in static media`);
        continue;
      }
      const buf = readFileSync(f);
      const h = inMedia ? sha(buf) : null;
      if (h) built.add(h);
      // public/ never carries an exemption; in the repository a label is kept only on a kept maker's own showcase file.
      const allow = inMedia && (binding ? binding.byHash.has(h) : true);
      const r = findLeaks(buf.toString("latin1"), ext, list, allow);
      if (r.exempted) exempted.push(rel);
      if (r.hits.length) leaks.push(`  ${rel}: ${r.hits.join(", ")}`);
    }
  }
  if (leaks.length) {
    console.error(`media-bundle-check: ${leaks.length} of ${media.length + pub.length} files name a vendor or carry an id outside a maker's signed implicit label:`);
    console.error(leaks.join("\n"));
    console.error('Only a maker\'s signed TC260 AIGC label on its own sample is kept (docs/AI_DISCLOSURE.md "Vendor watermarks and provenance"); find what wrote the rest.');
    process.exit(1);
  }
  if (binding) {
    const missing = binding.labelled.filter((l) => !built.has(l.h));
    if (missing.length) fail2(`${missing.length} labelled showcase clips are not in the build (first: ${missing[0].file}) — this scan would be reading the wrong files.`);
  }
  if (report) for (const e of exempted) console.log(`exempt: ${e}`);
  const bound = binding ? `bound to their jobs (${binding.labelled.length} labelled sources, all in the build)` : "NOT bound to a job: no components/site/showcase here";
  console.log(`media-bundle-check: ${media.length} files under .next/static/media and ${pub.length} under public/; ${exempted.length} carry a maker's signed implicit label (kept, docs/AI_DISCLOSURE.md), ${bound}; none names a vendor or carries an id anywhere else.`);
}

main();
