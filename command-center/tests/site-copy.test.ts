import { describe, expect, it } from "vitest";
import { siteEn } from "@/lib/i18n/site/en";
import { siteRu } from "@/lib/i18n/site/ru";
import { siteUz } from "@/lib/i18n/site/uz";
import { SOLUTION_IDS } from "@/lib/solutions";
import { PROVIDER_BRANDS } from "./helpers/brands";

/**
 * The public site's copy is complete in all three languages: the same keys,
 * the same list lengths and the same ids, no empty strings, the same {n}
 * placeholders, and no AI provider, competitor or team-role word anywhere.
 */
type Node = string | number | boolean | null | Node[] | { [k: string]: Node };

function walk(a: Node, b: Node, path: string, out: string[]) {
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return void out.push(`${path}: not a list`);
    if (a.length !== b.length) out.push(`${path}: ${a.length} vs ${b.length} items`);
    a.forEach((x, i) => b[i] !== undefined && walk(x, b[i], `${path}[${i}]`, out));
    return;
  }
  if (a && typeof a === "object") {
    if (!b || typeof b !== "object" || Array.isArray(b)) return void out.push(`${path}: not an object`);
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) out.push(`${path}: keys ${ka.join(",")} vs ${kb.join(",")}`);
    for (const k of ka) {
      if (k in b) {
        // ids, methods and paths are data, not copy: they must match exactly.
        if (k === "id" || k === "method" || k === "path") {
          if (a[k] !== b[k]) out.push(`${path}.${k}: ${String(a[k])} vs ${String(b[k])}`);
        }
        walk(a[k], b[k], `${path}.${k}`, out);
      }
    }
    return;
  }
  if (typeof a === "string") {
    if (typeof b !== "string") return void out.push(`${path}: not a string`);
    if (!b.trim()) out.push(`${path}: empty`);
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    if (ph(a) !== ph(b)) out.push(`${path}: placeholders ${ph(a)} vs ${ph(b)}`);
  }
}

function strings(n: Node): string[] {
  if (typeof n === "string") return [n];
  if (Array.isArray(n)) return n.flatMap(strings);
  if (n && typeof n === "object") return Object.values(n).flatMap(strings);
  return [];
}

describe("public site copy", () => {
  it.each([
    ["ru", siteRu],
    ["uz", siteUz],
  ] as const)("is complete in %s, with the same shape, ids and placeholders as English", (_, dict) => {
    const out: string[] = [];
    walk(siteEn as unknown as Node, dict as unknown as Node, "site", out);
    expect(out).toEqual([]);
  });

  it.each([
    ["en", siteEn],
    ["ru", siteRu],
    ["uz", siteUz],
  ] as const)("names no AI provider or competitor, and no team-role word (%s)", (_, dict) => {
    const all = strings(dict as unknown as Node);
    for (const s of all) expect(s).not.toMatch(PROVIDER_BRANDS);
    for (const s of all) expect(s).not.toMatch(/\b(?:owner|viewer)s?\b/i);
  });

  it("has one Solutions page per solution id, in the same order in every language", () => {
    for (const dict of [siteEn, siteRu, siteUz]) {
      expect(dict.solutions.pages.map((p) => p.id)).toEqual([...SOLUTION_IDS]);
    }
  });

  it("states no money amount and no usage or customer figure", () => {
    const MONEY = /[$€£₽]\s?\d|\d\s?(?:USD|EUR|UZS|RUB|so'm|сум)\b/i;
    const BRAG = /\b\d[\d,.]*\s?(?:\+|k\b|m\b)?\s?(?:users|customers|creators|channels|videos made|клиентов|пользователей|foydalanuvchi)/i;
    for (const dict of [siteEn, siteRu, siteUz]) {
      for (const s of strings(dict as unknown as Node)) {
        expect(s).not.toMatch(MONEY);
        expect(s).not.toMatch(BRAG);
      }
    }
  });
});
