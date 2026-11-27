#!/usr/bin/env node
/**
 * After `next build`: no browser JavaScript carries our vendor routing, the vendor display map, or our vendor metering units.
 *
 * Three things the site must never show, each of which a build once put in a public chunk:
 *
 *   - each effect's model preference order (lib/effects/effects.json "models":["runway-gen4.5","minimax-h3",…]) and its full
 *     prompt: the catalog was a client module, in the chunk on /, /solutions/[slug] and the Studio. It is server-only now
 *     (lib/effects/catalog.ts) and the browser gets the slices in lib/effects/shared.ts;
 *   - the provider display map (openai:"OpenAI", bfl:"Black Forest Labs", …): it sat in lib/models-discovery.ts, which the plan
 *     finder imports, so it was in the chunk on /, /pricing and /login. It is lib/server/provider-names.ts now;
 *   - the cost ledger's unit list (["gemini_input_tokens","gemini_output_tokens",…,"pexels_requests",…]): it sat in
 *     lib/credits.ts, loaded by every public page. It is lib/server/ledger-units.ts now.
 *
 * Every value is read from those files, so a new effect, vendor or unit is checked without editing this script. It scans EVERY
 * .js file under .next/static (a static chunk is downloadable by anyone who knows its name, signed in or not) and every
 * prerendered .html/.rsc under .next/server. Exit 1 on a leak, 2 when the check could not run (no build, a partial build, or
 * a source no longer in the shape read here — a pass then would mean nothing).
 *
 * Run from command-center/ after `next build`: `node scripts/vendor-bundle-check.mjs [path/to/.next]`. Prints chunk paths and
 * the pattern that matched; never the surrounding chunk text.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

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
  return { effects, providers, units };
}

/** Every pattern the browser must not see: [label, RegExp] for single hits, and the provider pairs counted per file. */
export function patterns({ effects, providers, units }) {
  const single = [];
  for (const e of effects) {
    // The array as any serializer writes it: ["a","b"], ['a', 'b'], "models":["a","b"]. Two or more elements in that order
    // are this effect's preference list; a one-model effect is matched on its key and value together.
    const items = e.models.map((m) => `${Q}${escape(m)}${Q}`);
    const re = e.models.length > 1 ? `\\[\\s*${items.join("\\s*,\\s*")}\\s*\\]` : `${Q}?models${Q}?\\s*:\\s*\\[\\s*${items[0]}\\s*\\]`;
    single.push([`effect ${e.id} model order`, new RegExp(re)]);
    // The prompt: its first 60 characters, which no other text in the product begins with.
    single.push([`effect ${e.id} prompt`, new RegExp(escape(e.prompt.slice(0, 60)))]);
  }
  // Two ledger units next to each other as array elements is the unit list (a dictionary writes unit:"label", never this).
  const unit = `${Q}(?:${units.map(escape).join("|")})${Q}`;
  single.push(["ledger unit list", new RegExp(`${unit}\\s*,\\s*${unit}`)]);
  const pairs = providers.map((p) => ({
    label: `${p.slug}:"${p.name}"`,
    // bfl:"Black Forest Labs", "bfl":"Black Forest Labs", bfl: 'Black Forest Labs' — any quote, quoted key or not.
    re: new RegExp(`(?<![\\w$])${Q}?${escape(p.slug)}${Q}?\\s*:\\s*${Q}${escape(p.name)}${Q}`),
    // A pair whose name is not just its slug written properly (bfl -> Black Forest Labs) is the map's own: one is enough.
    alone: p.name.toLowerCase().replace(/[^a-z0-9]/g, "") !== p.slug.replace(/[^a-z0-9]/g, ""),
  }));
  return { single, pairs };
}

/**
 * The labels of everything in `raw` the browser must not see. `\"` is read as `"` first: a payload inlined as
 * JSON.parse("{\"models\":[\"a\"]}") or an RSC/HTML string carries the same data behind escaped quotes.
 */
export function findLeaks(raw, { single, pairs }) {
  const text = raw.replace(/\\"/g, '"');
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

function main() {
  const source = readSource();
  const list = patterns(source);
  const scan = (text) => findLeaks(text, list);

  // Positive control 1: the patterns catch the text that shipped, minified and behind escaped quotes. If a regex is broken,
  // this fails before a clean scan can be mistaken for a clean build.
  const e0 = source.effects[0];
  const p = source.providers;
  const u = source.units;
  const shipped = [
    `{id:"${e0.id}",models:${JSON.stringify(e0.models)},prompt:${JSON.stringify(e0.prompt)}}`,
    `F={${p.map((x) => `${x.slug}:"${x.name}"`).join(",")}}`,
    `o=${JSON.stringify(u)}`,
  ].join(";");
  const escaped = JSON.stringify(JSON.stringify({ models: e0.models, units: u, map: Object.fromEntries(p.map((x) => [x.slug, x.name])) }));
  for (const text of [shipped, `JSON.parse(${escaped})`]) {
    const caught = scan(text);
    for (const must of [`effect ${e0.id} model order`, "ledger unit list"]) {
      if (!caught.includes(must)) fail2(`self-test: the pattern "${must}" does not match the text it exists to catch.`);
    }
    if (!caught.some((h) => h.startsWith("provider display map"))) fail2("self-test: the provider map pattern does not match the map.");
  }
  if (!scan(shipped).includes(`effect ${e0.id} prompt`)) fail2("self-test: the prompt pattern does not match the prompt.");
  for (const e of source.effects) {
    if (!scan(`m=${JSON.stringify(e.models)}`).includes(`effect ${e.id} model order`)) fail2(`self-test: the pattern for ${e.id}'s models does not match them.`);
  }

  if (!existsSync(STATIC)) fail2(".next/static not found — run `next build` first.");
  const files = filesUnder(STATIC, (n) => n.endsWith(".js"));
  const pages = filesUnder(PRERENDERED, (n) => n.endsWith(".html") || n.endsWith(".rsc"));
  // Positive control 2: a real, whole build, with the public page the map and the unit list reached.
  const publicPage = files.filter((f) => /[\\/]app[\\/]pricing[\\/]page-[^\\/]+\.js$/.test(f));
  if (files.length < 50 || publicPage.length === 0 || pages.length === 0) {
    fail2(`found ${files.length} .js files (${publicPage.length} /pricing page chunks) under static/ and ${pages.length} prerendered .html/.rsc files — not a whole build.`);
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
  for (const file of [...files, ...pages]) {
    const hits = scan(texts.get(file) ?? readFileSync(file, "utf8"));
    if (hits.length > 0) leaks.push(`${path.relative(ROOT, file)}: ${hits.join("; ")}`);
  }
  const scanned = `${files.length} static chunks and ${pages.length} prerendered pages`;
  if (leaks.length > 0) {
    console.error(`vendor-bundle-check: ${leaks.length} of ${scanned} carry vendor routing, the vendor map or vendor metering units:`);
    for (const line of leaks) console.error(`  ${line}`);
    console.error("Resolve on the server and pass the result as props: lib/effects/catalog.ts, lib/server/provider-names.ts and lib/server/ledger-units.ts are server-only.");
    process.exit(1);
  }
  console.log(
    `vendor-bundle-check: ${scanned}, ${list.single.length} patterns + the provider map (${source.effects.length} effects, ${source.providers.length} providers, ${source.units.length} ledger units): clean.`,
  );
}

main();
