#!/usr/bin/env node
/**
 * After `next build`: no JavaScript the browser loads carries the showcase manifest's private fields.
 *
 * lib/site/showcase.json names, for every sample, the vendor that ran it, the vendor's own model, what it cost, the maker's credit
 * and the file's sha256. The owner's rule is that vendor names and vendor costs never reach the public site, and until the slice
 * the whole file was in one shared chunk loaded on /, /login, /signup and the Studio, because client code (the sign-in stages'
 * slot, the effect cards) imported it. lib/site/showcase.ts is now `server-only` and client code reads SHOWCASE_CARDS
 * (components/site/showcase-assets.ts); tests/showcase-cards.test.ts checks the slice, this checks what the build produced.
 *
 * Three checks, each a different way the data could come back:
 *   1. every .js under .next/static: none of the manifest's fields as a quoted JSON key ("provider": …), the shape a JSON import
 *      takes in a chunk. Field names alone are not enough: "provider" is also the sign-in code's OAuth parameter.
 *   2. every public page's .js: none of those fields given a literal value in any key form (provider:"…", operatorPreview:!0),
 *      the shape a generated TypeScript slice that carried them would take.
 *   3. every public page's .js: no maker's credit from schemas/model_registry.json (its attribution text and link), which the
 *      public site never shows (owner decision 2026-11-13) and which only the manifest carried.
 * And one positive control, so a pass is not a scan of the wrong files: some public page's .js does carry the slice (a card's job
 * id beside `modelId:`).
 *
 * NOT checked here, and why: a bare vendor slug anywhere in a public chunk. On 2026-11-27 such slugs were in public chunks from
 * other modules than the showcase (lib/billing.ts's provider map, lib/models-discovery.ts's provider names, lib/creative/
 * model-names.ts's model names, lib/channels.ts's voice provider, lib/effects/effects.json's model ids, the agent builder's
 * vendor list, and "google" as the sign-in provider), so a failing check would say nothing about this file. `--report-vendors`
 * prints where each slug appears, for the change that takes those out.
 *
 * Run from command-center/ after `next build`: `node scripts/showcase-bundle-check.mjs`. Prints chunk names, route names and
 * field names only, never the data.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const NEXT = path.join(ROOT, ".next");
const STATIC = path.join(NEXT, "static");
const MANIFEST = path.join(NEXT, "app-build-manifest.json");
const DATA = path.join(ROOT, "lib", "site", "showcase.json");
const REGISTRY = path.join(ROOT, "..", "schemas", "model_registry.json");

/** The manifest's fields that name the vendor or identify the file: lib/site/showcase.ts ShowcaseEntry and ShowcaseCost. */
const FIELDS = ["provider", "vendorModel", "modelName", "operatorPreview", "sha256"];

/** Public pages, as scripts/public-bundle-check.mjs counts them: not the signed-in app, a route handler, /welcome or /owner. */
function isPublicEntry(entry) {
  if (entry.startsWith("/(app)/") || entry.startsWith("/api/") || entry.startsWith("/welcome/") || entry.startsWith("/owner/")) return false;
  return !entry.endsWith("/route");
}

function jsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fail(lines, remedy) {
  console.error("showcase-bundle-check: the browser's JavaScript carries the showcase manifest's private data:");
  for (const l of lines) console.error(`  ${l}`);
  console.error(remedy);
  process.exit(1);
}

function main() {
  const report = process.argv.includes("--report-vendors");
  for (const [p, what] of [[MANIFEST, "run `next build` first"], [DATA, "the data file is missing"], [REGISTRY, "the model registry is missing"]]) {
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
  const credits = [...new Set(registry.flatMap((m) => (m.attribution ? [m.attribution.text, m.attribution.url] : [])).filter(Boolean))];
  if (credits.length === 0) {
    console.error("showcase-bundle-check: the registry lists no maker's credit — its shape changed, so check 3 would check nothing.");
    process.exit(2);
  }

  const pages = JSON.parse(readFileSync(MANIFEST, "utf8")).pages ?? {};
  const publicEntries = Object.keys(pages).filter(isPublicEntry);
  if (publicEntries.length === 0) {
    console.error("showcase-bundle-check: the build manifest lists no public page — its shape changed, so nothing was checked.");
    process.exit(2);
  }
  const all = jsFiles(STATIC);
  const cache = new Map();
  const read = (abs) => {
    if (!cache.has(abs)) cache.set(abs, readFileSync(abs, "utf8"));
    return cache.get(abs);
  };
  const rel = (abs) => path.relative(NEXT, abs);
  const publicChunks = new Map(); // absolute path -> the public routes that load it
  for (const entry of publicEntries) {
    for (const c of pages[entry].filter((x) => x.endsWith(".js"))) {
      const abs = path.join(NEXT, c);
      if (!publicChunks.has(abs)) publicChunks.set(abs, []);
      publicChunks.get(abs).push(entry);
    }
  }
  const routes = (abs) => {
    const r = publicChunks.get(abs) ?? [];
    return r.length > 3 ? `${r.slice(0, 3).join(", ")} and ${r.length - 3} more` : r.join(", ");
  };

  const leaks = [];
  // 1. The JSON shape, in any chunk (the Studio's included).
  for (const abs of all) {
    const hits = FIELDS.filter((f) => read(abs).includes(`"${f}":`));
    if (hits.length > 0) leaks.push(`${rel(abs)}${publicChunks.has(abs) ? ` [${routes(abs)}]` : ""}: ${hits.map((h) => `"${h}":`).join(", ")}`);
  }
  // 2. A literal value under any of the fields, quoted key or not, in a public page's chunk.
  const literal = new RegExp(`(?:^|[{,\\s])["']?(${FIELDS.map(escape).join("|")})["']?\\s*:\\s*(?:["'\`]|!0|!1|true|false|-?\\d)`, "g");
  for (const abs of publicChunks.keys()) {
    const hits = [...new Set([...read(abs).matchAll(literal)].map((m) => m[1]))];
    if (hits.length > 0) leaks.push(`${rel(abs)} [${routes(abs)}]: ${hits.map((h) => `${h}: <literal>`).join(", ")}`);
  }
  // 3. A maker's credit, in a public page's chunk.
  for (const abs of publicChunks.keys()) {
    const hits = credits.filter((c) => read(abs).includes(c));
    if (hits.length > 0) leaks.push(`${rel(abs)} [${routes(abs)}]: ${hits.length} maker's credit(s) from the registry`);
  }
  if (leaks.length > 0) {
    fail(
      [...new Set(leaks)],
      "Client code must read SHOWCASE_CARDS (components/site/showcase-assets.ts), never lib/site/showcase.ts or showcase.json; a decision that needs a private field is made on the server or by tools/export_showcase.py.",
    );
  }

  // The positive control: the slice is in a public chunk (the sign-in stages resolve their slot in the browser).
  const ids = entries.map((e) => e.jobId).filter((j) => typeof j === "string");
  const shipped = [...publicChunks.keys()].some((abs) => ids.some((id) => new RegExp(`jobId:"${escape(id)}",modelId:`).test(read(abs))));
  if (!shipped) {
    console.error("showcase-bundle-check: no public page's JavaScript carries the showcase slice (SHOWCASE_CARDS) — the scan looked at the wrong files, or the slice's shape changed.");
    process.exit(1);
  }

  if (report) {
    const slugs = [...new Set(registry.map((m) => m.provider).filter(Boolean))];
    for (const abs of publicChunks.keys()) {
      const hits = slugs.filter((s) => new RegExp(`["'\`]${escape(s)}["'\`]`).test(read(abs)));
      if (hits.length > 0) console.log(`  vendor slugs (not enforced) ${rel(abs)} [${routes(abs)}]: ${hits.join(", ")}`);
    }
  }
  console.log(`showcase-bundle-check: ${all.length} chunks, ${publicChunks.size} on ${publicEntries.length} public pages; none carries the showcase manifest's private fields.`);
}

main();
