/**
 * The image editor's strings exist in en, ru and uz with the same keys and the same {fillers}; every refusal code the
 * save can meet has a sentence in each language; the flag is off unless explicitly on.
 * What would break without these: a Russian or Uzbek phone showing English or an empty line, a `{max}` printed as the
 * literal text, an upload refusal with no sentence, a switch that is on by accident.
 */
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { imageEditorEnabled, IMAGE_EDITOR_FLAG } from "../lib/imageEditor/flag";
import { SAVE_ERRORS } from "../lib/imageEditor/save";
import { ASPECTS } from "../lib/imageEditor/crop";
import { FAMILIES } from "../lib/imageEditor/layers";

const dicts = { en, ru, uz } as const;
const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function leaves(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}

describe("imageEditor parity", () => {
  const source = leaves(en.imageEditor);
  it("has strings (the check is not vacuous)", () => {
    expect(source.length).toBeGreaterThan(100);
  });

  it.each(["ru", "uz"] as const)("%s has exactly the keys of en, none empty, with the same {fillers}", (loc) => {
    const got = new Map(leaves(dicts[loc].imageEditor));
    expect([...got.keys()].sort()).toEqual(source.map(([k]) => k).sort());
    for (const [key, text] of source) {
      expect(got.get(key), `${loc}.${key}`).toBeTruthy();
      expect(fillers(got.get(key)!), `${loc}.${key} fillers`).toEqual(fillers(text));
    }
  });

  it.each(["ru", "uz"] as const)("%s does not leave sentences in English", (loc) => {
    const own = new Map(leaves(dicts[loc].imageEditor));
    // Words that are the same in every language: shape ratios, a brand-free unit.
    const same = new Set(Object.keys(en.imageEditor.aspects).map((k) => `aspects.${k}`));
    for (const [key, text] of source) {
      if (same.has(key)) continue;
      if (text.split(/\s+/).length < 3) continue;
      expect(own.get(key), `${loc}.${key}`).not.toBe(text);
    }
  });

  it.each(["en", "ru", "uz"] as const)("%s words every refusal the upload can answer, every crop shape and every font", (loc) => {
    const d = dicts[loc].imageEditor;
    const errors = d.errors as Record<string, string>;
    for (const code of SAVE_ERRORS) expect(errors[code], `${loc}.errors.${code}`).toBeTruthy();
    expect(Object.keys(errors).sort()).toEqual([...SAVE_ERRORS].sort());
    expect(Object.keys(d.aspects).sort()).toEqual([...ASPECTS].sort());
    expect(Object.keys(d.fonts).sort()).toEqual([...FAMILIES].sort());
  });

  it("names the 16 megapixel ceiling and the placeholder for the limit in the two sentences that need them", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      expect(fillers(dicts[loc].imageEditor.tooLarge), loc).toEqual(["max", "mp"]);
      expect(fillers(dicts[loc].imageEditor.errors.too_large), loc).toEqual(["max"]);
    }
  });

  it("tells the person the original is never changed and that the AI tools open the ORIGINAL, not the edits", () => {
    expect(en.imageEditor.subtitle).toMatch(/original is never changed/);
    expect(en.imageEditor.formatHint).toMatch(/original stays/);
    expect(en.imageEditor.aiNote).toMatch(/ORIGINAL library picture/);
    expect(en.imageEditor.aiNote).toMatch(/not your edits/);
    expect(en.imageEditor.aiNote).toMatch(/price/);
    expect(en.imageEditor.aiSaveFirst).toMatch(/save first, then choose the new file in Studio/);
    for (const loc of ["ru", "uz"] as const) expect(dicts[loc].imageEditor.aiNote, loc).not.toBe(en.imageEditor.aiNote);
  });
});

describe("the switch", () => {
  it("is named NIGHTSHIFT_IMAGE_EDITOR and is off unless explicitly on", () => {
    expect(IMAGE_EDITOR_FLAG).toBe("NIGHTSHIFT_IMAGE_EDITOR");
    for (const v of [undefined, "", "off", "0", "false", "no", "enabled", " ", "onn"]) expect(imageEditorEnabled(v), String(v)).toBe(false);
    for (const v of ["on", "ON", " 1 ", "true", "yes", "Yes"]) expect(imageEditorEnabled(v), v).toBe(true);
  });

  it("reads the process environment by default, at call time", () => {
    const before = process.env.NIGHTSHIFT_IMAGE_EDITOR;
    try {
      delete process.env.NIGHTSHIFT_IMAGE_EDITOR;
      expect(imageEditorEnabled()).toBe(false);
      process.env.NIGHTSHIFT_IMAGE_EDITOR = "on";
      expect(imageEditorEnabled()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.NIGHTSHIFT_IMAGE_EDITOR;
      else process.env.NIGHTSHIFT_IMAGE_EDITOR = before;
    }
  });
});
