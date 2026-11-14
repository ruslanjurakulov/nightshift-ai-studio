import { describe, expect, it } from "vitest";
import { siteEn } from "@/lib/i18n/site/en";
import { siteRu } from "@/lib/i18n/site/ru";
import { siteUz } from "@/lib/i18n/site/uz";
import { siteAutopilotUz } from "@/lib/i18n/site-autopilot/uz";
import { effectsUz } from "@/lib/i18n/effects/uz";
import { uz } from "@/lib/i18n/uz";
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

  // The owner reads the Uzbek page (live audit, 2026-11-14): calques he flagged must not come back.
  it("uz: says 'press the publish button', calls a story's hook a beginning, gives one effect one name, and names the theme switch apart from a video's topic", () => {
    expect(siteUz.hero.titleB).toBe("Nashr tugmasini siz bosasiz.");
    const site = strings(siteUz as unknown as Node);
    const pilot = strings(siteAutopilotUz as unknown as Node);
    // "Nashr qilishni bosish" is "to press publishing"; "ilmoq" and "ilgak" are a fish-hook and a clasp, not a story's opening.
    for (const s of [...site, ...pilot]) expect(s).not.toMatch(/Nashr qilishni|\bilmoq\b|\bilgak\b/i);
    // The same shot is "satisfying macro" in the hero's chips, the gallery and the effects: one Uzbek name for all of them.
    const macro = siteUz.formats.items.find((i) => i.id === "satisfying")!.title;
    expect(macro).toBe(effectsUz.items["satisfying-macro"].name);
    // "Mavzu" is the video's topic everywhere in the app, and "Koʻrinish" is the mobile/desktop view switch.
    expect(uz.common.theme).not.toBe("Mavzu");
    expect(uz.common.theme).not.toBe(uz.common.view);
    // oʻ and gʻ are written with U+02BB, never with a quote mark that looks like it.
    for (const s of [...site, ...pilot]) expect(s).not.toMatch(/[oOgG][‘’']/);
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
