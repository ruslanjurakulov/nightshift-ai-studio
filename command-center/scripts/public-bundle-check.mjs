#!/usr/bin/env node
/**
 * After `next build`: no JavaScript a public page loads carries the signed-in app's dictionary.
 *
 * Reads .next/app-build-manifest.json (every app route's entry -> the chunks its page loads), takes the public routes'
 * chunks, and fails if any of them contains a sentinel: a string that only the signed-in app's operator notices use, so
 * it is in the browser only when the whole dictionary came along. tests/public-bundle-dictionary.test.ts checks the
 * import graph before a build; this checks what the build actually produced.
 *
 * Run from command-center/ after `next build`: `node scripts/public-bundle-check.mjs`. Prints chunk names and route
 * names only.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const NEXT = path.join(process.cwd(), ".next");
const MANIFEST = path.join(NEXT, "app-build-manifest.json");

/**
 * Each appears in lib/i18n's dictionaries only in signed-in screens' operator notices (the Credits page's setup and
 * enforcement notes, the model-keys page, the plan portal's setup note), never in a string the public slice
 * (lib/i18n/public.ts) carries and never in other client code. Checked against a build: before the fix they were all
 * in /pricing's dictionary chunk and in no other chunk.
 */
const SENTINELS = ["PADDLE_API_KEY", "DODO_PAYMENTS_API_KEY", "NIGHTSHIFT_CREDITS_ENFORCE", "NIGHTSHIFT_MODEL_KEYS", "docs/PADDLE_SETUP.md"];

/**
 * The manifest's entries that are not public pages: the signed-in app, API and other route handlers (no client
 * bundle), /welcome, the first run of a signed-in account, and /owner, the platform owner's console (signed in, owner
 * only). tests/public-bundle-dictionary.test.ts skips the same.
 */
function isPublicEntry(entry) {
  if (entry.startsWith("/(app)/") || entry.startsWith("/api/") || entry.startsWith("/welcome/") || entry.startsWith("/owner/")) return false;
  return !entry.endsWith("/route");
}

function main() {
  if (!existsSync(MANIFEST)) {
    console.error("public-bundle-check: .next/app-build-manifest.json not found — run `next build` first.");
    process.exit(2);
  }
  const pages = JSON.parse(readFileSync(MANIFEST, "utf8")).pages ?? {};
  const entries = Object.keys(pages);
  const publicEntries = entries.filter(isPublicEntry);
  const signedIn = entries.filter((e) => e.startsWith("/(app)/"));
  if (publicEntries.length === 0 || signedIn.length === 0) {
    console.error(`public-bundle-check: the manifest lists ${publicEntries.length} public and ${signedIn.length} app entries — its shape changed, so nothing was checked.`);
    process.exit(2);
  }

  const contents = new Map();
  const read = (chunk) => {
    if (!contents.has(chunk)) contents.set(chunk, readFileSync(path.join(NEXT, chunk), "utf8"));
    return contents.get(chunk);
  };
  const found = (chunk) => SENTINELS.filter((s) => read(chunk).includes(s));
  const js = (list) => list.filter((c) => c.endsWith(".js"));

  // The sentinels must still be real: the app's own pages do ship the dictionary. If none does, a sentinel was renamed
  // and the check below would pass for the wrong reason.
  const appChunks = new Set(signedIn.flatMap((e) => js(pages[e])));
  const alive = SENTINELS.filter((s) => [...appChunks].some((c) => read(c).includes(s)));
  const dead = SENTINELS.filter((s) => !alive.includes(s));
  if (dead.length > 0) {
    console.error(`public-bundle-check: no signed-in page's bundle contains ${dead.join(", ")} — pick sentinels that still exist (see SENTINELS).`);
    process.exit(1);
  }

  const leaks = [];
  for (const entry of publicEntries) {
    for (const chunk of js(pages[entry])) {
      const hits = found(chunk);
      if (hits.length > 0) leaks.push(`${entry}: ${chunk} (${hits.join(", ")})`);
    }
  }
  if (leaks.length > 0) {
    console.error("public-bundle-check: a public page loads the signed-in app's dictionary:");
    for (const line of leaks) console.error(`  ${line}`);
    console.error("Import fmt/Locale from @/lib/i18n/core and read words through usePublicI18n in client code on public pages.");
    process.exit(1);
  }
  console.log(`public-bundle-check: ${publicEntries.length} public entries, none loads the signed-in app's dictionary.`);
}

main();
