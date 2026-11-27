#!/usr/bin/env node
/**
 * After `next build`: no JavaScript the browser can load, and no prerendered page, carries the showcase manifest's private data.
 *
 * lib/site/showcase.json names, for every sample, the vendor that ran it, the vendor's own model, what it cost, the maker's credit,
 * the library asset and the file's sha256. The owner's rule is that vendor costs and provider identity never reach the public site,
 * and until the slice the whole file was in one shared chunk loaded on /, /login, /signup and the Studio, because client code (the
 * sign-in stages' slot, the effect cards) imported it. lib/site/showcase.ts is now `server-only` and client code reads SHOWCASE_CARDS
 * (components/site/showcase-assets.ts); tests/showcase-cards.test.ts checks the slice, this checks what the build produced.
 *
 * Every .js under .next/static is read, not only the chunks app-build-manifest.json lists for a page: a chunk loaded by import() or
 * next/dynamic is in no page's list, and the Studio's chunks reach every signed-up account's browser. Text is read with its
 * escaping undone (\" and \\\" become "), so data inside a string literal or a flight payload in HTML reads as it would in JSON.
 *
 * Checks, each a different way the data could come back:
 *   1. the manifest's fields as a quoted JSON key ("provider": …), the shape a JSON import takes in a chunk;
 *   2. those fields given a literal value in any key form (provider:"…", operatorPreview:!0), the shape a generated TypeScript
 *      slice that carried them would take. `provider` only with a registry vendor as its value: the app's own code uses the word
 *      for other things (the dictionary's label provider:"Provider", a credential's provider:"youtube", a prop's provider:"");
 *   3. a maker's credit from schemas/model_registry.json (its attribution text, and its link as a whole string: the operator's
 *      provider-keys page links to a vendor's console under the same host), which the public site never shows;
 *   4. the manifest's own values, read from the data file so they cannot drift: each entry's sha256 and assetId, its input's and end
 *      frame's assetId and sha256, its maker's credit and its vendor models, under whatever key or none. This one also reads the
 *      prerendered pages (.next/server/app/**\/*.rsc and *.html), where a Server Component's props to a Client Component land.
 * And one positive control, so a pass is not a scan of the wrong files: some chunk does carry the slice (a card's job id beside
 * `modelId:`).
 *
 * Not covered: a page rendered per request has no file to read here, so its RSC payload is not scanned (docs/SHOWCASE.md,
 * "Follow-up"). Not checked either: a bare vendor slug anywhere. On 2026-11-27 slugs were in public chunks from other modules than
 * the showcase (lib/billing.ts, lib/models-discovery.ts, lib/creative/model-names.ts, lib/channels.ts, lib/effects/effects.json,
 * the agent builder, "google" as the sign-in provider), so it would say nothing about this file; `--report-vendors` lists them.
 *
 * Run from command-center/ after `next build`: `node scripts/showcase-bundle-check.mjs`. Prints file names and field names only,
 * never the data.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const NEXT = path.join(ROOT, ".next");
const STATIC = path.join(NEXT, "static");
const SERVER_APP = path.join(NEXT, "server", "app");
const DATA = path.join(ROOT, "lib", "site", "showcase.json");
const REGISTRY = path.join(ROOT, "..", "schemas", "model_registry.json");

/** The manifest's fields that name the vendor, price the job or identify the file: lib/site/showcase.ts ShowcaseEntry / ShowcaseCost. */
const FIELDS = ["provider", "vendorModel", "modelName", "operatorPreview", "sha256", "usdEstimate", "priceSource"];

/**
 * Next's own runtime chunks: React, the router and the polyfills. No module of ours is in them, so they can hold nothing of the
 * manifest; skipped only because their size makes every scan slower for nothing.
 */
const FRAMEWORK = /(?:^|[/\\])(?:framework|main|main-app|polyfills)-[0-9a-f]+\.js$/;

function files(dir, test, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, test, out);
    else if (test(e.name, p)) out.push(p);
  }
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Undo string escaping of quotes at any depth: `\"`, `\\\"` (a flight payload inside a script string) all read as `"`. */
const unescapeQuotes = (s) => s.replace(/\\+"/g, '"');

/** Every value of the manifest that may never be in a browser, with what it is (printed instead of the value). */
function privateValues(entries) {
  const out = new Map(); // value -> label
  const add = (v, label, min) => {
    if (typeof v === "string" && v.length >= min && !out.has(v)) out.set(v, label);
  };
  for (const e of entries) {
    add(e.sha256, "an entry's sha256", 64);
    add(e.assetId, "an entry's assetId", 36);
    for (const [frame, name] of [[e.input, "input"], [e.endFrame, "endFrame"]]) {
      if (frame && typeof frame === "object") {
        add(frame.assetId, `an entry's ${name}.assetId`, 36);
        add(frame.sha256, `an entry's ${name}.sha256`, 64);
      }
    }
    // The link is matched as a whole string (urlPattern), so it is not here.
    if (e.attribution && typeof e.attribution === "object") add(e.attribution.text, "an entry's maker's credit", 4);
  }
  return out;
}

/** A link as a whole quoted string, with or without a final slash: not a longer address that starts with it. */
const urlPattern = (u) => new RegExp(`["'\`]${escape(u.replace(/\/$/, ""))}/?["'\`]`);

/** The vendor models the data file records (cost.vendor[].vendorModel): short words like "turbo", so matched only as a whole string. */
function vendorModels(entries) {
  const out = new Set();
  for (const e of entries) for (const v of e?.cost?.vendor ?? []) if (typeof v?.vendorModel === "string" && v.vendorModel) out.add(v.vendorModel);
  return [...out];
}

function main() {
  const report = process.argv.includes("--report-vendors");
  for (const [p, what] of [[STATIC, "run `next build` first"], [DATA, "the data file is missing"], [REGISTRY, "the model registry is missing"]]) {
    if (!existsSync(p)) {
      console.error(`showcase-bundle-check: ${path.relative(ROOT, p)} not found — ${what}.`);
      process.exit(2);
    }
  }
  const entries = JSON.parse(readFileSync(DATA, "utf8")).entries ?? [];
  const registry = JSON.parse(readFileSync(REGISTRY, "utf8")).models ?? [];
  // Vacuous unless the data still has what is being kept out: a renamed field would pass every scan below for the wrong reason.
  const missing = FIELDS.filter((f) => !entries.some((e) => JSON.stringify(e).includes(`"${f}":`)));
  if (entries.length === 0 || missing.length > 0) {
    console.error(`showcase-bundle-check: lib/site/showcase.json has ${entries.length} entries and none with ${missing.join(", ")} — update FIELDS.`);
    process.exit(2);
  }
  const creditTexts = [...new Set(registry.map((m) => m.attribution?.text).filter(Boolean))];
  const creditLinks = [...new Set([...registry.map((m) => m.attribution?.url), ...entries.map((e) => e?.attribution?.url)].filter((u) => typeof u === "string" && u))];
  const linkRes = creditLinks.map(urlPattern);
  const values = privateValues(entries);
  const models = vendorModels(entries);
  if (creditTexts.length === 0 || linkRes.length === 0 || ![...values.values()].some((l) => l.endsWith("sha256")) || models.length === 0) {
    console.error("showcase-bundle-check: the registry lists no maker's credit, or the data file no sha256 or vendor model — a shape changed, so a check would check nothing.");
    process.exit(2);
  }

  const js = files(STATIC, (name, p) => name.endsWith(".js") && !FRAMEWORK.test(p));
  const pages = files(SERVER_APP, (name) => name.endsWith(".rsc") || name.endsWith(".html"));
  const cache = new Map();
  const read = (abs) => {
    if (!cache.has(abs)) cache.set(abs, unescapeQuotes(readFileSync(abs, "utf8")));
    return cache.get(abs);
  };
  const rel = (abs) => path.relative(NEXT, abs);

  const slugs = [...new Set(registry.map((m) => m.provider).filter(Boolean))];
  const others = FIELDS.filter((f) => f !== "provider");
  const literal = new RegExp(
    `(?:^|[{,\\s])["']?(?:(${others.map(escape).join("|")})["']?\\s*:\\s*(?:["'\`]|!0|!1|true|false|-?\\d)|(provider)["']?\\s*:\\s*["'\`](?:${slugs.map(escape).join("|")})["'\`])`,
    "g",
  );
  const modelRes = models.map((m) => new RegExp(`["'\`]${escape(m)}["'\`]`));
  const leaks = [];
  const valueScan = (abs) => {
    const s = read(abs);
    const hits = new Set();
    for (const [v, label] of values) if (s.includes(v)) hits.add(label);
    for (const re of modelRes) if (re.test(s)) hits.add("a vendor model");
    for (const re of linkRes) if (re.test(s)) hits.add("a maker's link");
    if (hits.size > 0) leaks.push(`${rel(abs)}: ${[...hits].join(", ")}`);
  };
  for (const abs of js) {
    const s = read(abs);
    // 1. The JSON shape.
    const keys = FIELDS.filter((f) => s.includes(`"${f}":`));
    if (keys.length > 0) leaks.push(`${rel(abs)}: ${keys.map((h) => `"${h}":`).join(", ")}`);
    // 2. A literal value under any of the fields, quoted key or not.
    const lits = [...new Set([...s.matchAll(literal)].map((m) => m[1] ?? m[2]))];
    if (lits.length > 0) leaks.push(`${rel(abs)}: ${lits.map((h) => `${h}: <literal>`).join(", ")}`);
    // 3. A maker's credit from the registry.
    const cred = [...creditTexts.filter((c) => s.includes(c)), ...linkRes.filter((re) => re.test(s))];
    if (cred.length > 0) leaks.push(`${rel(abs)}: ${cred.length} maker's credit(s) from the registry`);
    // 4. The manifest's own values.
    valueScan(abs);
  }
  for (const abs of pages) valueScan(abs);

  if (leaks.length > 0) {
    console.error("showcase-bundle-check: the browser's JavaScript or a prerendered page carries the showcase manifest's private data:");
    for (const l of [...new Set(leaks)]) console.error(`  ${l}`);
    console.error(
      "Client code must read SHOWCASE_CARDS (components/site/showcase-assets.ts), never lib/site/showcase.ts or showcase.json, and a prop to a Client Component takes a card (showcaseCard), never an entry; a decision that needs a private field is made on the server or by tools/export_showcase.py.",
    );
    process.exit(1);
  }

  // The positive control: the slice is in a chunk (the sign-in stages resolve their slot in the browser).
  const ids = entries.map((e) => e.jobId).filter((j) => typeof j === "string");
  const card = new RegExp(`jobId:"(?:${ids.map(escape).join("|")})",modelId:`);
  if (!js.some((abs) => card.test(read(abs)))) {
    console.error("showcase-bundle-check: no chunk carries the showcase slice (SHOWCASE_CARDS) — the scan looked at the wrong files, or the slice's shape changed.");
    process.exit(1);
  }

  if (report) {
    for (const abs of js) {
      const hits = slugs.filter((s) => new RegExp(`["'\`]${escape(s)}["'\`]`).test(read(abs)));
      if (hits.length > 0) console.log(`  vendor slugs (not enforced) ${rel(abs)}: ${hits.join(", ")}`);
    }
  }
  console.log(`showcase-bundle-check: ${js.length} chunks and ${pages.length} prerendered files; none carries the showcase manifest's private data.`);
}

main();
