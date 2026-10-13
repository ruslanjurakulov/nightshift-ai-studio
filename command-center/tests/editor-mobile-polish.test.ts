/**
 * The phone polish of the editor page (design review F1-F12): the pieces that are
 * stylesheet or wording, pinned so they are not undone by accident. The behaviour
 * (layout, targets, axe) was measured in a browser; see the PR.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("shell: the page keeps its end above the bottom tab bar", () => {
  it("the customer <main> opts in with the unlayered class, not a pb-* utility the unlayered .pad-page would beat", () => {
    const layout = read("app/(app)/layout.tsx");
    expect(layout).toContain('className="pad-page pad-page-tabbar min-w-0 flex-1"');
    expect(layout).not.toContain("pb-24");
    const css = read("app/globals.css");
    expect(css).toMatch(/@media \(max-width: 1023\.98px\) \{\s*\.pad-page-tabbar \{ padding-bottom: calc\(6rem \+ env\(safe-area-inset-bottom\)\); \}/);
  });
});

describe("draft banner", () => {
  it("draws its warn accent inline (the unlayered .panel border beats a border-l-4 utility)", () => {
    const src = read("components/editor/DraftBanner.tsx");
    expect(src).toContain('borderLeftWidth: 4, borderLeftColor: "var(--color-warn)"');
    expect(src).not.toMatch(/className="[^"]*border-l-4/);
  });
});

describe("editor wording (F6): one term per language for the playhead", () => {
  const dicts = { en: en.editor, ru: ru.editor, uz: uz.editor } as const;
  const term = { en: /playhead/i, ru: /курсор/i, uz: /kursor/i } as const;
  for (const l of ["en", "ru", "uz"] as const) {
    const d = dicts[l];
    it(`${l}: the slider, split, nudge, snap and sound-start strings use it`, () => {
      for (const s of [d.playhead, d.split, d.splitHint, d.soundToPlayhead, d.view.scSplit, d.view.scNudge, d.view.scNudgeBig, d.view.snapDesc]) {
        expect(s, `${l}: ${s}`).toMatch(term[l]);
      }
    });
    it(`${l}: the view bar's fit names the timeline, so it is not the picture's Fit`, () => {
      expect(d.view.fit).not.toBe(d.fitContain.replace(/ \(.*\)$/, ""));
      expect(d.view.fit).not.toMatch(/^(Fit|Вписать|Sigʻdirish)$/);
    });
  }
  it("the text caret has its own word, never the playhead's", () => {
    expect(en.editor.view.shortcutsNote).toMatch(/text cursor/);
    expect(ru.editor.view.shortcutsNote).toMatch(/каретка/);
    expect(uz.editor.view.shortcutsNote).toMatch(/matn kursori/);
  });
  it("the preview is not promised to be exact; the exported file is the reference", () => {
    for (const d of [en.editor, ru.editor, uz.editor]) {
      expect(d.previewNote + d.gradeHint).not.toMatch(/exact|точн|aniq/i);
    }
  });
  it("the Uzbek draft prompt says discard in the button's word, not 'bekor qiling' (cancel / Undo)", () => {
    expect(uz.editor.draftFound).toMatch(/olib tashlang/);
    expect(uz.editor.draftFound).not.toMatch(/bekor qiling/);
  });
});
