/**
 * Studio → Projects' strings (lib/i18n/film-studio). What would break without these: a key present in English and missing in Russian
 * or Uzbek (the screen shows a blank or a key), a {filler} dropped in translation (a number vanishes from a sentence), Uzbek written
 * with a plain apostrophe instead of ʻ (U+02BB), a string under the 13px-type rule's twin (a capitalised shout), the Studio's own name
 * hard-coded instead of filled from `nav.hub`, and copy that suggests a project can be priced, started or published in this release.
 */
import { describe, expect, it } from "vitest";
import { filmStudioEn } from "../lib/i18n/film-studio/en";
import { filmStudioRu } from "../lib/i18n/film-studio/ru";
import { filmStudioUz } from "../lib/i18n/film-studio/uz";
import { filmStudioStrings } from "../lib/i18n/film-studio";
import { FILM_ERRORS, FILM_STATUSES, SCENE_STATUSES, STATIONS } from "../lib/films";

type Tree = { [k: string]: string | Tree };
function leaves(o: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of leaves(v, key)) out.set(kk, vv);
  }
  return out;
}
const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const en = leaves(filmStudioEn as unknown as Tree);
const all = { ru: leaves(filmStudioRu as unknown as Tree), uz: leaves(filmStudioUz as unknown as Tree) };

describe("the three dictionaries", () => {
  it("have exactly the same keys", () => {
    for (const [lang, d] of Object.entries(all)) expect([...d.keys()].sort(), lang).toEqual([...en.keys()].sort());
  });

  it("keep every {filler} of the English sentence", () => {
    for (const [lang, d] of Object.entries(all)) for (const [k, v] of en) expect(fillers(d.get(k) ?? ""), `${lang} ${k}`).toEqual(fillers(v));
  });

  it("have no empty string", () => {
    for (const d of [en, ...Object.values(all)]) for (const [k, v] of d) expect(v.trim(), k).not.toBe("");
  });

  it("cover every status, scene state, station and refusal the code can produce", () => {
    for (const d of [filmStudioEn, filmStudioRu, filmStudioUz]) {
      for (const s of FILM_STATUSES) expect(d.status[s]).toBeTruthy();
      for (const s of SCENE_STATUSES) expect(d.sceneStatus[s]).toBeTruthy();
      for (const s of STATIONS) expect(d.stations[s]).toBeTruthy();
      for (const e of FILM_ERRORS) expect(d.errors[e]).toBeTruthy();
    }
  });

  it("Uzbek uses ʻ (U+02BB) and ʼ (U+02BC), never a plain apostrophe or a backtick", () => {
    for (const [k, v] of all.uz) {
      expect(v, k).not.toMatch(/[oOgG]['`‘’]/);
      expect(v, k).not.toMatch(/'/);
    }
    expect(filmStudioUz.section).toBe("Loyihalar");
    expect(filmStudioRu.section).toBe("Проекты");
    expect(filmStudioEn.section).toBe("Projects");
  });

  it("never write the Studio's name: it is filled from nav.hub", () => {
    for (const d of [en, ...Object.values(all)]) for (const [k, v] of d) expect(v, k).not.toMatch(/Nightshift Studio|Film Studio|Kinostudiya|Киностудия/);
    expect(filmStudioEn.list.heading).toContain("{studio}");
  });

  it("say Start is off and why, with no price anywhere (rules 3 and 5)", () => {
    for (const d of [filmStudioEn, filmStudioRu, filmStudioUz]) {
      expect(d.dock.notLive.length).toBeGreaterThan(20);
      expect(d.dock.notLive).not.toMatch(/\d/);
      expect(d.canvas.aiWriteReason.length).toBeGreaterThan(20);
    }
  });

  it("an unknown locale reads as English", () => {
    expect(filmStudioStrings("de")).toBe(filmStudioEn);
    expect(filmStudioStrings("uz")).toBe(filmStudioUz);
  });
});
