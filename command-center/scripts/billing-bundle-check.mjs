#!/usr/bin/env node
/**
 * After `next build`: no browser JavaScript carries the operator's vendor billing data.
 *
 * lib/billing.ts holds what the site must never show: vendor names tied to their billing dashboards, a vendor's
 * per-credit price (Runway at $0.01) and our routing map (registry vendor -> billing row, e.g. bytedance -> seedance).
 * It once reached the public chunk loaded on /, /login, /signup and /pricing because lib/credits.ts imported one pure
 * helper (`percentile`) from it. The module is now `server-only`; this checks what the build actually produced.
 *
 * It scans EVERY .js file under .next/static (not the manifest's page lists, which miss lazy chunks) and every prerendered
 * .html/.rsc under .next/server/app, not only the public routes' chunks: a static chunk is downloadable by
 * anyone who knows (or guesses) its name, so a signed-in operator page's chunk is public in the sense that matters.
 *
 * The vendor URLs and the routing pairs are read from lib/billing.ts itself, so a vendor added there is checked without
 * editing this file. Exit 1 on a leak, 2 when the check could not run (no build, or the source no longer has the shape
 * this script reads — a pass then would mean nothing).
 *
 * Run from command-center/ after `next build`: `node scripts/billing-bundle-check.mjs [path/to/.next]`. Prints chunk paths and the
 * pattern that matched; never the surrounding chunk text.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
// An optional first argument names another build's .next (to show the check failing on a copy of an older build).
const NEXT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, ".next");
const STATIC = path.join(NEXT, "static");
// Prerendered pages (server/app/**, and server/pages/** for the built-in error pages): their HTML and RSC payloads are
// served to anyone who loads the page, like a static chunk. Only .html/.rsc: the server's own .js legitimately holds
// lib/billing.ts. Today every app route is dynamic, so this is mostly 500.html, but a page that becomes static is covered.
const PRERENDERED = path.join(NEXT, "server");
const SOURCE = path.join(ROOT, "lib", "billing.ts");

const fail2 = (msg) => {
  console.error(`billing-bundle-check: ${msg}`);
  process.exit(2);
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The vendor billing URLs and the non-identity routing pairs, read from lib/billing.ts. */
function readSource() {
  if (!existsSync(SOURCE)) fail2("lib/billing.ts not found — run from command-center/.");
  const src = readFileSync(SOURCE, "utf8");
  if (!/^import "server-only";$/m.test(src)) fail2('lib/billing.ts no longer starts with `import "server-only"` — the guard this check backs up is gone.');

  const urls = [...new Set([...src.matchAll(/billingUrl:\s*"(https:\/\/[^"]+)"/g)].map((m) => m[1]))];
  // Every billing URL counts, the ones that are also a vendor's API-key console (BFL, Kling, Leonardo) included: those used to
  // be exempt because lib/providers.ts put them in the Providers page's chunk, but that list is server-only now and the page
  // passes its cards as props (scripts/vendor-bundle-check.mjs checks the key pages themselves).
  // Vendors sold at a fixed credit price: { id, name, price }. The price is a bare number (.01) that cannot be searched for
  // alone, so it is searched for next to the vendor it belongs to (see creditHits).
  const credits = [...src.matchAll(/^\s{2}([a-z0-9_]+):\s*\{\s*name:\s*"([^"]+)"[^}]*?creditUsd:\s*([0-9.e-]+)/gm)].map((m) => ({
    id: m[1],
    name: m[2],
    price: Number(m[3]),
  }));
  if (!/creditUsd:\s*[0-9.]/.test(src) || credits.length === 0 || credits.some((c) => !(c.price > 0))) {
    fail2("could not read a vendor credit price (`creditUsd: <n>` inside a `{ name: ... }` entry) from lib/billing.ts — its shape changed.");
  }
  const block = src.match(/export const REGISTRY_BILLING[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/);
  if (!block) fail2("REGISTRY_BILLING is no longer an `Object.freeze({...})` literal in lib/billing.ts — update readSource().");
  const pairs = [...block[1].matchAll(/^\s*([a-z0-9_]+):\s*"([a-z0-9_-]+)",?\s*$/gm)].map((m) => [m[1], m[2]]);
  // Identity pairs (anthropic: "anthropic") say nothing about routing and would match innocent maps elsewhere.
  const routed = pairs.filter(([k, v]) => k !== v);

  // Floors from the file (15 distinct billing URLs, 21 vendors, 3 renamed on 28 Nov 2026): far below them, the regexes above no
  // longer read the file, and a pass would be a pass over an empty list.
  if (urls.length < 10) fail2(`read only ${urls.length} billing URLs from lib/billing.ts — its shape changed.`);
  if (pairs.length < 15 || routed.length < 3) fail2(`read only ${pairs.length} REGISTRY_BILLING entries (${routed.length} routed) — its shape changed.`);
  return { urls, routed, credits };
}

/** Every pattern the browser must not see, as [label, RegExp]. */
function patterns({ urls, routed }) {
  const q = `["'\`]`;
  const list = [
    // Names that exist only in lib/billing.ts and the server code around it. Client components take provider rows as
    // props named payUrl / usdPerCredit, so these names in a chunk mean the module (or a copy of its shape) shipped.
    ["creditUsd", /creditUsd/],
    ["billingUrl", /billingUrl/],
    ["REGISTRY_BILLING", /REGISTRY_BILLING/],
    ["BILLED_PROVIDERS", /BILLED_PROVIDERS/],
    // These two names are also our own field names with no data behind them in a bundle (the price the operator types is
    // POSTed as `usd_per_unit`; the owner budget tool passes `usdPerUnit` computed from server props). A leak is the name
    // carrying a number literal, in any minified or quoted form: usd_per_unit:.01, "usdPerUnit":1e-3, usdPerUnit: 0.5.
    ["usd_per_unit=<number>", new RegExp(`${q}?usd_per_unit${q}?\\s*:\\s*-?(?:\\d|\\.\\d)`)],
    ["usdPerUnit=<number>", new RegExp(`${q}?usdPerUnit${q}?\\s*:\\s*-?(?:\\d|\\.\\d)`)],
  ];
  for (const url of urls) {
    // The URL with and without its trailing slash: the vendor's dashboard is the datum, not our spelling of it.
    const bare = url.replace(/\/+$/, "");
    list.push([`vendor billing URL ${bare}`, new RegExp(`${escape(bare)}(?![\\w.-])`)]);
  }
  for (const [vendor, row] of routed) {
    // bytedance:"seedance", "bytedance":"seedance", bytedance: 'seedance' — quoted keys, any quote, optional spaces.
    list.push([`routing ${vendor}->${row}`, new RegExp(`(?<![\\w$])${q}?${escape(vendor)}${q}?\\s*:\\s*${q}${escape(row)}${q}`)]);
  }
  return list;
}

/** The ways a minifier or a serializer writes a number: 0.01, .01, 1e-2. */
function numberForms(n) {
  const plain = String(n);
  return [...new Set([plain, plain.replace(/^0\./, "."), n.toExponential().replace(/\.?0*e\+?/, "e")])];
}

/**
 * A vendor's credit price next to that vendor: its quoted name ("Runway") or its id as a key (runway:) within 300
 * characters of the number. Catches the price even when the field is renamed or the object is reshaped, without flagging
 * every .01 in the bundle.
 */
function creditHits(text, credits) {
  const hits = [];
  for (const c of credits) {
    const num = new RegExp(`(?<![\\w.])(?:${numberForms(c.price).map(escape).join("|")})(?![\\d.e])`);
    const anchor = new RegExp(`["'\`]${escape(c.name)}["'\`]|(?<![\\w$])["'\`]?${escape(c.id)}["'\`]?\\s*:`, "g");
    for (const m of text.matchAll(anchor)) {
      if (num.test(text.slice(Math.max(0, m.index - 300), m.index + m[0].length + 300))) {
        hits.push(`credit price of ${c.name}`);
        break;
      }
    }
  }
  return hits;
}

/**
 * The labels of everything in `raw` the browser must not see. `\"` is read as `"` first: a payload inlined as
 * JSON.parse("{\"creditUsd\":0.01}") or an RSC/HTML string carries the same data behind escaped quotes.
 */
export function findLeaks(raw, list, credits) {
  const text = raw.replace(/\\"/g, '"');
  return [...list.filter(([, re]) => re.test(text)).map(([label]) => label), ...creditHits(text, credits)];
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
  const scan = (text) => findLeaks(text, list, source.credits);

  // Positive control 1: the patterns catch the exact text that shipped on the live site, and the same data behind escaped
  // quotes. If a regex is broken, this fails before a clean scan can be mistaken for a clean build.
  const shipped = 'runway:{name:"Runway",billingUrl:"https://dev.runway.com/",creditUsd:.01},X={alibaba:"wan",bytedance:"seedance"}';
  const escaped = 'JSON.parse("{\\"runway\\":{\\"name\\":\\"Runway\\",\\"rate\\":0.01},\\"bytedance\\":\\"seedance\\"}")';
  const caught = new Set([...scan(shipped), ...scan(escaped)]);
  for (const must of ["creditUsd", "billingUrl", "routing bytedance->seedance", "routing alibaba->wan", ...source.credits.map((c) => `credit price of ${c.name}`)]) {
    if (!caught.has(must)) fail2(`self-test: the pattern "${must}" does not match the text it exists to catch.`);
  }
  for (const url of source.urls) {
    if (!scan(`{href:"${url}"}`).includes(`vendor billing URL ${url.replace(/\/+$/, "")}`)) fail2(`self-test: the pattern for ${url} does not match it.`);
  }

  if (!existsSync(STATIC)) fail2(".next/static not found — run `next build` first.");
  // Every .js file, not the manifest's page lists: a next/dynamic or lazily loaded chunk is in no page's list and is still
  // downloadable.
  const files = filesUnder(STATIC, (n) => n.endsWith(".js"));
  const pages = filesUnder(PRERENDERED, (n) => n.endsWith(".html") || n.endsWith(".rsc"));
  // Positive control 2: this is a real, whole build. The Billing page is the operator chunk most likely to carry the
  // data; if its chunk is not here, the scan is over the wrong directory or a partial build.
  const billingPage = files.filter((f) => /[\\/]app[\\/]\(app\)[\\/]\[channel\][\\/]billing[\\/]page-[^\\/]+\.js$/.test(f));
  const publicPage = files.filter((f) => /[\\/]app[\\/]pricing[\\/]page-[^\\/]+\.js$/.test(f));
  if (files.length < 50 || billingPage.length === 0 || publicPage.length === 0 || pages.length === 0) {
    fail2(
      `found ${files.length} .js files (${billingPage.length} Billing page, ${publicPage.length} /pricing page chunks) under static/ and ${pages.length} prerendered .html/.rsc files — not a whole build.`,
    );
  }
  // Positive control 3: the operator's Billing page still gets its board, so its chunk holds the board's own code. If the
  // page stopped rendering it, a pass would only say the data is gone because the page is.
  const boardMarker = "/api/billing/settings";
  if (!files.some((f) => readFileSync(f, "utf8").includes(boardMarker))) {
    fail2(`no chunk contains the Billing board's "${boardMarker}" call — the board is not in the build, so a pass would mean nothing.`);
  }

  const leaks = [];
  for (const file of [...files, ...pages]) {
    const hits = scan(readFileSync(file, "utf8"));
    if (hits.length > 0) leaks.push(`${path.relative(ROOT, file)}: ${hits.join("; ")}`);
  }
  const scanned = `${files.length} static chunks and ${pages.length} prerendered pages`;
  if (leaks.length > 0) {
    console.error(`billing-bundle-check: ${leaks.length} of ${scanned} carry vendor billing data:`);
    for (const line of leaks) console.error(`  ${line}`);
    console.error("lib/billing.ts is server-only: compute vendor rows on the server and pass them to client components as props.");
    process.exit(1);
  }
  console.log(
    `billing-bundle-check: ${scanned}, ${list.length} patterns (${source.urls.length} vendor billing URLs, ${source.routed.length} routing pairs, ${source.credits.length} credit prices): clean.`,
  );
}

main();
