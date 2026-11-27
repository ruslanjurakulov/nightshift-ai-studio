import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { unitMeaning, type UnitMeaningText } from "@/lib/creditUnits";
import { ledgerUnitMeanings } from "@/lib/server/ledger-unit-labels";

/**
 * Breach, PR #956: the PR moved the cost ledger's unit list (gemini_input_tokens, pexels_requests, ...) to
 * lib/server/ledger-units.ts so that no browser chunk names the vendors we meter. The same nine units, in the same order,
 * are still the keys of lib/creditUnits.ts FIXED, which CreditPricesEditor and OwnerPriceHistory ("use client") import, so
 * they sit in the /{channel}/credits page chunk every signed-in customer downloads (observed in a `next build` of
 * f1b7e5c62: static/chunks/app/(app)/[channel]/credits/page-*.js carries
 * `gemini_input_tokens:"tokens",...,pexels_requests:"requests",...,vision_calls:"calls"`). scripts/vendor-bundle-check.mjs
 * reads `unit:"label"` as a dictionary and lets it through.
 *
 * This walks the client import graph of those two components (the repo's own modules; lib/i18n is PR 2's and left out) and
 * fails while any module in it names two or more ledger units in code. The gloss itself must survive the fix: a ledger unit
 * is still explained by its measure word (`_tokens`, `_characters`, `_requests`, ...), never by its vendor-named key.
 */
const CC = process.cwd();
const ROOTS = ["components/credits/CreditPricesEditor.tsx", "components/credits/OwnerPriceHistory.tsx"];
const UNITS = [...readFileSync(path.join(CC, "lib/server/ledger-units.ts"), "utf8").matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(CC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(c) && /\.tsx?$/.test(c)) return c;
  }
  return null;
}

function clientGraph(): string[] {
  const seen = new Set<string>();
  const stack = ROOTS.map((r) => path.join(CC, r));
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    // A type-only import is erased: it puts nothing into a chunk.
    for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) {
      const next = resolve(file, m[1]);
      if (next && !next.includes(`${path.sep}lib${path.sep}i18n${path.sep}`)) stack.push(next);
    }
  }
  return [...seen];
}

const GLOSS = {
  tokens: "tokens",
  characters: "characters",
  renderSeconds: "render seconds",
  requests: "requests",
  bytes: "bytes",
  generatedClips: "clips",
  generatedImages: "images",
  calls: "calls",
} as Partial<UnitMeaningText> as UnitMeaningText;

describe("breach #956: the ledger's vendor-named units in the price editor's client chunk", () => {
  it("the graph is real: it reaches lib/creditUnits.ts and the unit list was read", () => {
    expect(UNITS.length).toBeGreaterThanOrEqual(5);
    expect(clientGraph().map((f) => path.relative(CC, f))).toContain(path.join("lib", "creditUnits.ts"));
  });

  it("no module the price editor ships to the browser names two or more ledger units", () => {
    const offenders = clientGraph()
      .map((f) => {
        const code = stripComments(readFileSync(f, "utf8"));
        const named = UNITS.filter((u) => new RegExp(`(?<![a-z0-9_])${u}(?![a-z0-9_])`).test(code));
        return named.length >= 2 ? `${path.relative(CC, f)}: ${named.join(", ")}` : null;
      })
      .filter((x): x is string => x !== null);
    expect(offenders).toEqual([]);
  });

  it("a ledger unit is still glossed after the fix (by its measure word, not a vendor-keyed table)", () => {
    expect(unitMeaning("gemini_input_tokens", GLOSS)).toBe("tokens");
    expect(unitMeaning("pexels_requests", GLOSS)).toBe("requests");
    // Amended after Lens's recheck (rule 5): "characters" reads "per narrated character", which is not true of every
    // *_characters unit, so the browser no longer reads it off the last word. Its exact meaning comes from the server
    // (lib/server/ledger-unit-labels.ts ledgerUnitMeanings), handed in as unitMeaning's `known`.
    expect(unitMeaning("tts_characters", GLOSS)).toBeNull();
    expect(unitMeaning("tts_characters", GLOSS, ledgerUnitMeanings(GLOSS))).toBe("characters");
  });
});
