#!/usr/bin/env node
/**
 * After `next build`: no browser JavaScript carries our vendor routing, the vendor display map, or our vendor metering units.
 *
 * Three things the site must never show, each of which a build once put in a static chunk:
 *
 *   - each effect's model preference order (lib/effects/effects.json "models":["runway-gen4.5","minimax-h3",…]) and its full
 *     prompt: the catalog was a client module, in the chunk on /, /solutions/[slug] and the Studio. It is server-only now
 *     (lib/effects/catalog.ts) and the browser gets the slices in lib/effects/shared.ts;
 *   - the provider display map (openai:"OpenAI", bfl:"Black Forest Labs", …): it sat in lib/models-discovery.ts, which the plan
 *     finder imports, so it was in the chunk on /, /pricing and /login. It is lib/server/provider-names.ts now;
 *   - the cost ledger's units: the list (["gemini_input_tokens",…,"pexels_requests",…]) sat in lib/credits.ts, and the
 *     vendor-named ones were keys of the shared dictionary and of lib/creditUnits.ts. They are lib/server/ledger-units.ts and
 *     lib/server/ledger-unit-labels.ts now; a vendor-named unit is flagged in ANY form, a dictionary key included.
 *
 * Every value is read from those files, so a new effect, vendor or unit is checked without editing this script. What is
 * scanned: EVERY .js file under .next/static (a static chunk is downloadable by anyone who knows its name, signed in or not),
 * and every text file next build wrote under .next/server/app (prerendered .html/.rsc pages, route handler .body files, their
 * .meta) and the .html under .next/server/pages, except the server's own code (.js, .map, .nft.json), which legitimately
 * holds the data. Pages that render per request (all of today's app pages) are not files in the build and are NOT covered
 * here: their props are held by tests (tests/pricing-finder-props.test.tsx, tests/effects-gallery-props.test.tsx). The
 * summary line says how many app pages were prerendered, 0 included.
 *
 * Text is read the way the browser would read it: escaped quotes are undone until nothing changes (a JSON string in an RSC
 * row in a flight script is escaped two or three times) and the HTML quote entities are decoded.
 *
 * Exit 1 on a leak, 2 when the check could not run (no build, a partial build, or a source no longer in the shape read here —
 * a pass then would mean nothing). Run from command-center/ after `next build`: `node scripts/vendor-bundle-check.mjs
 * [path/to/.next]`. Prints file paths and the pattern that matched; never the surrounding text.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
// An optional first argument names another build's .next (to show the check failing on a copy of an older build).
const NEXT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, ".next");
const STATIC = path.join(NEXT, "static");
const PRERENDERED = path.join(NEXT, "server");
const EFFECTS_JSON = path.join(ROOT, "lib", "effects", "effects.json");
const EFFECTS_MODULE = path.join(ROOT, "lib", "effects", "catalog.ts");
const PROVIDERS = path.join(ROOT, "lib", "server", "provider-names.ts");
const LEDGER = path.join(ROOT, "lib", "server", "ledger-units.ts");

/** How many pairs of the provider map in one file make it the map: two vendor names in some copy are not a lookup table. */
export const MAP_PAIRS_MIN = 3;
/** A prompt is matched by windows of this many characters from each part between its slots: long enough that no other text
 *  in the product holds one, short enough that a part as short as a template's head still has one. */
export const PROMPT_WINDOW = 30;

const fail2 = (msg) => {
  console.error(`vendor-bundle-check: ${msg}`);
  process.exit(2);
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const Q = `["'\`]`;

function serverOnly(file, label) {
  if (!existsSync(file)) fail2(`${label} not found — run from command-center/.`);
  const src = readFileSync(file, "utf8");
  if (!/^import "server-only";$/m.test(src)) fail2(`${label} no longer has \`import "server-only"\` — the guard this check backs up is gone.`);
  return src;
}

/** The effects, the provider map and the ledger units, read from their (server-only) sources. */
function readSource() {
  serverOnly(EFFECTS_MODULE, "lib/effects/catalog.ts");
  if (!existsSync(EFFECTS_JSON)) fail2("lib/effects/effects.json not found — run from command-center/.");
  let raw;
  try {
    raw = JSON.parse(readFileSync(EFFECTS_JSON, "utf8"));
  } catch {
    fail2("lib/effects/effects.json is not JSON.");
  }
  const effects = (Array.isArray(raw?.effects) ? raw.effects : [])
    .filter((e) => typeof e?.id === "string" && Array.isArray(e.models) && typeof e.prompt === "string")
    .map((e) => ({ id: e.id, models: e.models.filter((m) => typeof m === "string"), prompt: e.prompt }));
  // Floors from the file as it is today (8 effects, 2 to 4 models each): far below them the file is no longer read.
  if (effects.length < 5 || effects.some((e) => e.models.length < 1 || e.prompt.length < 40)) {
    fail2(`read ${effects.length} effects with models and prompts from lib/effects/effects.json — its shape changed.`);
  }

  const providerSrc = serverOnly(PROVIDERS, "lib/server/provider-names.ts");
  const block = providerSrc.match(/const PROVIDER_NAMES[^=]*=\s*\{([\s\S]*?)\};/);
  if (!block) fail2("PROVIDER_NAMES is no longer an object literal in lib/server/provider-names.ts — update readSource().");
  const providers = [...block[1].matchAll(/^\s*["']?([a-z0-9_-]+)["']?:\s*"([^"]+)",?\s*$/gm)].map((m) => ({ slug: m[1], name: m[2] }));
  if (providers.length < 8) fail2(`read only ${providers.length} PROVIDER_NAMES entries — its shape changed.`);

  const ledgerSrc = serverOnly(LEDGER, "lib/server/ledger-units.ts");
  const list = ledgerSrc.match(/export const LEDGER_UNITS\s*=\s*\[([\s\S]*?)\]/);
  if (!list) fail2("LEDGER_UNITS is no longer an array literal in lib/server/ledger-units.ts — update readSource().");
  const units = [...list[1].matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);
  if (units.length < 5) fail2(`read only ${units.length} LEDGER_UNITS — its shape changed.`);
  const vlist = ledgerSrc.match(/export const VENDOR_NAMED_LEDGER_UNITS\s*=\s*\[([\s\S]*?)\]/);
  if (!vlist) fail2("VENDOR_NAMED_LEDGER_UNITS is no longer an array literal in lib/server/ledger-units.ts — update readSource().");
  const vendorUnits = [...vlist[1].matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);
  if (vendorUnits.length < 1 || vendorUnits.some((u) => !units.includes(u))) fail2("VENDOR_NAMED_LEDGER_UNITS is empty or names a unit LEDGER_UNITS does not — its shape changed.");
  return { effects, providers, units, vendorUnits };
}

/** The windows a prompt is matched by: from each part between its {slots}, its start, middle and end (PROMPT_WINDOW long). */
export function promptWindows(prompt) {
  const out = new Set();
  for (const part of prompt.split(/\{[^}]*\}/).map((p) => p.trim())) {
    if (part.length < PROMPT_WINDOW) continue;
    const mid = Math.floor((part.length - PROMPT_WINDOW) / 2);
    for (const at of [0, mid, part.length - PROMPT_WINDOW]) out.add(part.slice(at, at + PROMPT_WINDOW));
  }
  return [...out];
}

/** Every pattern the browser must not see: [label, RegExp] for single hits, and the provider pairs counted per file. */
export function patterns({ effects, providers, units, vendorUnits }) {
  const single = [];
  for (const e of effects) {
    // Any two consecutive choices of the effect's order, as adjacent array elements in any quotes: a prefix of the list is
    // already the routing. A one-model effect is matched on its key and value together.
    if (e.models.length === 1) {
      single.push([`effect ${e.id} model order`, new RegExp(`${Q}?models${Q}?\\s*:\\s*\\[\\s*${Q}${escape(e.models[0])}${Q}\\s*\\]`)]);
    }
    for (let i = 0; i + 1 < e.models.length; i++) {
      const [a, b] = [e.models[i], e.models[i + 1]];
      single.push([`effect ${e.id} model order (${a} then ${b})`, new RegExp(`${Q}${escape(a)}${Q}\\s*,\\s*${Q}${escape(b)}${Q}`)]);
    }
    // The prompt, filled or not: a window from any part between its slots. A filled prompt keeps every part.
    const windows = promptWindows(e.prompt);
    if (windows.length === 0) fail2(`effect ${e.id}: no part of its prompt is ${PROMPT_WINDOW} characters long — update promptWindows().`);
    single.push([`effect ${e.id} prompt`, new RegExp(windows.map(escape).join("|"))]);
  }
  // Two ledger units next to each other as array elements is the unit list (a dictionary writes unit:"label", never this).
  const unit = `${Q}(?:${units.map(escape).join("|")})${Q}`;
  single.push(["ledger unit list", new RegExp(`${unit}\\s*,\\s*${unit}`)]);
  // A vendor-named unit anywhere, in any form: quoted, a key, inside a longer string.
  for (const u of vendorUnits) single.push([`vendor-named ledger unit ${u}`, new RegExp(`(?<![a-z0-9_])${escape(u)}(?![a-z0-9_])`)]);
  const pairs = providers.map((p) => ({
    label: `${p.slug}:"${p.name}"`,
    // bfl:"Black Forest Labs", "bfl":"Black Forest Labs", bfl: 'Black Forest Labs' — any quote, quoted key or not.
    re: new RegExp(`(?<![\\w$])${Q}?${escape(p.slug)}${Q}?\\s*:\\s*${Q}${escape(p.name)}${Q}`),
    // A pair whose name is not just its slug written properly (bfl -> Black Forest Labs) is the map's own: one is enough.
    alone: p.name.toLowerCase().replace(/[^a-z0-9]/g, "") !== p.slug.replace(/[^a-z0-9]/g, ""),
  }));
  return { single, pairs };
}

/** Text as the browser reads it: `\"` undone until nothing changes (each serializer layer adds one), HTML quote entities decoded. */
export function normalize(raw) {
  let text = raw.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&#39;|&#x27;/gi, "'");
  for (let i = 0; i < 8; i++) {
    const next = text.replace(/\\+"/g, '"');
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * The labels of everything in `raw` the browser must not see, read through normalize(): a payload inlined as
 * JSON.parse("{\"models\":[\"a\"]}"), an RSC row inside a flight script, or an HTML attribute carries the same data.
 */
export function findLeaks(raw, { single, pairs }) {
  const text = normalize(raw);
  const hits = single.filter(([, re]) => re.test(text)).map(([label]) => label);
  const mapHits = pairs.filter((p) => p.re.test(text));
  if (mapHits.length >= MAP_PAIRS_MIN || mapHits.some((p) => p.alone)) {
    hits.push(`provider display map (${mapHits.map((p) => p.label).join(", ")})`);
  }
  return hits;
}

function filesUnder(dir, keep) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, keep));
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}

/** A file is text when it has no NUL byte in its first 8 KB (a .body may be an icon). */
function isText(file) {
  const buf = readFileSync(file);
  return !buf.subarray(0, 8192).includes(0);
}

/** Every file next build wrote for a browser under server/: not the server's own code, which legitimately holds the data. */
const SERVER_CODE = /\.(?:js|mjs|cjs|map)$|\.nft\.json$/;

function main() {
  const source = readSource();
  const list = patterns(source);
  const scan = (text) => findLeaks(text, list);
  const has = (hits, prefix) => hits.some((h) => h.startsWith(prefix));

  // Positive control 1: the patterns catch the forms the product writes, minified, escaped, in an HTML attribute and with
  // the prompt filled. If a regex is broken, this fails before a clean scan can be mistaken for a clean build.
  const e0 = source.effects.find((e) => e.models.length > 1) ?? source.effects[0];
  const filled = source.effects.find((e) => /\{[^}]*\}/.test(e.prompt));
  const p = source.providers;
  const u = source.units;
  const shipped = [
    `{id:"${e0.id}",models:${JSON.stringify(e0.models)},prompt:${JSON.stringify(e0.prompt)}}`,
    `F={${p.map((x) => `${x.slug}:"${x.name}"`).join(",")}}`,
    `o=${JSON.stringify(u)}`,
  ].join(";");
  const twice = JSON.stringify(JSON.stringify(JSON.stringify({ models: e0.models, units: u, map: Object.fromEntries(p.map((x) => [x.slug, x.name])) })));
  const attribute = `<div data-x="${JSON.stringify({ models: e0.models, map: Object.fromEntries(p.map((x) => [x.slug, x.name])), u }).replace(/"/g, "&quot;")}">`;
  for (const text of [shipped, `JSON.parse(${twice})`, attribute]) {
    const caught = scan(text);
    for (const must of [`effect ${e0.id} model order`, "ledger unit list", "provider display map"]) {
      if (!has(caught, must)) fail2(`self-test: the pattern "${must}" does not match the text it exists to catch.`);
    }
  }
  if (!has(scan(shipped), `effect ${e0.id} prompt`)) fail2("self-test: the prompt pattern does not match the prompt.");
  if (filled && !has(scan(JSON.stringify(filled.prompt.replace(/\{[^}]*\}/g, "a red fox"))), `effect ${filled.id} prompt`)) {
    fail2("self-test: the prompt pattern does not match a filled prompt.");
  }
  for (const e of source.effects) {
    if (!has(scan(`m=${JSON.stringify(e.models.slice(0, 2))}`), `effect ${e.id} model order`)) fail2(`self-test: the pattern for ${e.id}'s models does not match them.`);
  }
  for (const v of source.vendorUnits) {
    if (!has(scan(`{${v}:"x"}`), `vendor-named ledger unit ${v}`)) fail2(`self-test: ${v} as a key is not caught.`);
  }

  if (!existsSync(STATIC)) fail2(".next/static not found — run `next build` first.");
  const files = filesUnder(STATIC, (n) => n.endsWith(".js"));
  const appDir = path.join(PRERENDERED, "app");
  const appFiles = filesUnder(appDir, (n) => !SERVER_CODE.test(n)).filter(isText);
  const errorPages = filesUnder(path.join(PRERENDERED, "pages"), (n) => n.endsWith(".html"));
  // What a "prerendered app page" is: an .html or .rsc next build wrote for an app route. Usually none (every app page is
  // dynamic today); then the summary says so, and nothing is claimed about the pages' payloads.
  const appPages = appFiles.filter((f) => /\.(?:html|rsc)$/.test(f));
  // Positive control 2: a real, whole build, with the public page the map and the unit list reached.
  const publicPage = files.filter((f) => /[\\/]app[\\/]pricing[\\/]page-[^\\/]+\.js$/.test(f));
  if (files.length < 50 || publicPage.length === 0) {
    fail2(`found ${files.length} .js files (${publicPage.length} /pricing page chunks) under static/ — not a whole build.`);
  }
  // Positive control 3: the screens that used to carry the data are still in the build — the Studio's Effects desk, the
  // canvas's effect list, the operator's price editor. If one stopped rendering, a pass would only say the screen is gone.
  const texts = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  for (const [marker, screen] of [
    ['"fx-grid"', "the Studio's Effects desk"],
    ['"cv-effects"', "the Studio canvas's effect list"],
    ['"credit-prices"', "the operator's price editor"],
  ]) {
    if (![...texts.values()].some((t) => t.includes(marker))) fail2(`no chunk contains ${marker} (${screen}) — that screen is not in the build, so a pass would mean nothing.`);
  }

  const leaks = [];
  for (const file of [...files, ...appFiles, ...errorPages]) {
    const hits = scan(texts.get(file) ?? readFileSync(file, "utf8"));
    if (hits.length > 0) leaks.push(`${path.relative(ROOT, file)}: ${hits.join("; ")}`);
  }
  const scanned = `${files.length} static chunks, ${appFiles.length} files under server/app (${appPages.length} app pages prerendered) and ${errorPages.length} error pages`;
  if (leaks.length > 0) {
    console.error(`vendor-bundle-check: ${leaks.length} files of ${scanned} carry vendor routing, the vendor map or vendor metering units:`);
    for (const line of leaks) console.error(`  ${line}`);
    console.error(
      "Resolve on the server and pass the result as props: lib/effects/catalog.ts, lib/server/provider-names.ts, lib/server/ledger-units.ts and lib/server/ledger-unit-labels.ts are server-only.",
    );
    process.exit(1);
  }
  console.log(
    `vendor-bundle-check: ${scanned}; ${list.single.length} patterns + the provider map (${source.effects.length} effects, ${source.providers.length} providers, ${source.units.length} ledger units, ${source.vendorUnits.length} vendor-named): clean.`,
  );
}

// Run only as a script: a test (or another script) importing promptWindows / normalize / findLeaks must not run a scan.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
