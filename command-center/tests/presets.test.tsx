// @vitest-environment jsdom
/**
 * Presets & looks: the gallery only links. Every card's href is read back with
 * the parser of the page it opens (so a card can never open a form that
 * ignores it), the three languages carry the same copy, and the rendered page
 * makes no request and offers a named, reachable link per card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/presets",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({
  useChannelSlug: () => "chronos",
  useChannelPath: () => (p: string) => `/chronos${p}`,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { presetsEn } from "@/lib/i18n/presets/en";
import { presetsRu } from "@/lib/i18n/presets/ru";
import { presetsUz } from "@/lib/i18n/presets/uz";
import { PresetsGallery } from "@/components/presets/PresetsGallery";
import {
  PRESET_KINDS,
  buildPresetCards,
  cardTool,
  filterPresets,
  lookFromQuery,
  presetPrefill,
  templateById,
  type PresetCard,
} from "@/lib/presets";
import { HOME_FORMATS, defaultLanguage, lengthSeconds, runPrefillFromQuery } from "@/lib/home";
import { STUDIO_VOICES, prefillFromQuery } from "@/lib/creative/studio";
import { STUDIO_TEMPLATES } from "@/lib/creative/templates";
import { STYLE_LIBRARY } from "@/lib/styles/library";
import { deskFor, deskFromQuery } from "@/lib/creative/desks";

const SLUG = "chronos";
const cardsFor = (locale: Locale) => buildPresetCards(SLUG, locale, dictionaries[locale]);

/** A card's href as the target page receives it: its section path and its query as a plain object. */
function open(href: string) {
  const u = new URL(href, "https://app.test");
  const q: Record<string, string> = {};
  u.searchParams.forEach((v, k) => (q[k] = v));
  return { path: u.pathname, q, hash: u.hash };
}

describe("preset cards", () => {
  for (const locale of ["en", "ru", "uz"] as const) {
    describe(locale, () => {
      const cards = cardsFor(locale);

      it("covers every format, look, template and voice once, with words and a channel link", () => {
        expect(cards.length).toBe(HOME_FORMATS.length + STYLE_LIBRARY.length + STUDIO_TEMPLATES.length + STUDIO_VOICES.length);
        expect(new Set(cards.map((c) => c.key)).size).toBe(cards.length);
        for (const c of cards) {
          expect(c.title.trim(), c.key).not.toBe("");
          expect(c.who.trim(), c.key).not.toBe("");
          expect(c.href.startsWith(`/${SLUG}/`), c.key).toBe(true);
          expect(c.href.includes("://"), c.key).toBe(false);
        }
        for (const k of PRESET_KINDS) expect(cards.some((c) => c.kind === k), k).toBe(true);
      });

      it("a format opens the video form with its topic, length and language", () => {
        for (const f of HOME_FORMATS) {
          const c = cards.find((x) => x.key === `format:${f.id}`)!;
          const { path, q, hash } = open(c.href);
          expect(path).toBe(`/${SLUG}/create`);
          expect(hash).toBe("#run");
          const copy = dictionaries[locale].home.formats[f.id];
          expect(runPrefillFromQuery(q)).toEqual({
            brief: copy.starter.replace(/\s+/g, " ").trim(),
            duration: String(lengthSeconds(f.length)),
            language: defaultLanguage(locale),
          });
          // The run form is the YouTube desk: that is where a topic lands.
          expect(deskFromQuery({ tool: q.tool, hasRunPrefill: true })).toBe("youtube");
        }
      });

      it("a look opens that look in the Style Library", () => {
        for (const s of STYLE_LIBRARY) {
          const c = cards.find((x) => x.key === `look:${s.id}`)!;
          const { path, q } = open(c.href);
          expect(path).toBe(`/${SLUG}/styles`);
          expect(lookFromQuery(q)?.id).toBe(s.id);
        }
      });

      it("a starter opens its Studio tool with the template's description and shape", () => {
        for (const tpl of STUDIO_TEMPLATES) {
          const c = cards.find((x) => x.key === `starter:${tpl.id}`)!;
          const { path, q } = open(c.href);
          expect(path).toBe(`/${SLUG}/create`);
          // What /create does with the query: the tool's prefill, then the template on top of it.
          const initial = presetPrefill(prefillFromQuery(q.tool, q.source), q);
          expect(initial, c.key).not.toBeNull();
          expect(initial!.capability).toBe(tpl.capability);
          expect(initial!.prompt).toBe(tpl.prompt);
          expect(initial!.aspect).toBe(tpl.aspect ?? "16:9");
          expect(initial!.duration).toBe(tpl.duration ?? 5);
          expect(deskFromQuery({ tool: q.tool })).toBe(deskFor(tpl.capability));
          expect(cardTool(c)).toBe(tpl.capability);
        }
      });

      it("a voice opens Voice-over with that voice picked", () => {
        for (const v of STUDIO_VOICES) {
          const c = cards.find((x) => x.key === `voice:${v.id}`)!;
          const { path, q } = open(c.href);
          expect(path).toBe(`/${SLUG}/create`);
          const initial = presetPrefill(prefillFromQuery(q.tool, q.source), q);
          expect(initial?.capability).toBe("tts");
          expect(initial?.voiceId).toBe(v.id);
          expect(deskFromQuery({ tool: q.tool })).toBe("voice");
        }
      });
    });
  }
});

describe("presetPrefill", () => {
  const base = prefillFromQuery("t2i", undefined)!;

  it("ignores a template that is for another tool, and an unknown one", () => {
    expect(presetPrefill(base, { tool: "t2i", template: "broll" })).toEqual(base);
    expect(presetPrefill(base, { tool: "t2i", template: "nope" })).toEqual(base);
    expect(presetPrefill(base, { tool: "t2i", template: ["yt_thumbnail", "broll"] })).toEqual(base);
  });

  it("ignores a voice that is unknown, malformed, or for another tool", () => {
    const tts = prefillFromQuery("tts", undefined)!;
    expect(presetPrefill(tts, { voice: "not-a-voice" })).toEqual(tts);
    expect(presetPrefill(tts, { voice: "A".repeat(20) })).toEqual(tts);
    expect(presetPrefill(base, { voice: STUDIO_VOICES[0].id })).toEqual(base);
    expect(presetPrefill(null, { template: "broll" })).toBeNull();
  });

  it("keeps a library picture when a template for a picture tool is applied", () => {
    const src = "11111111-1111-4111-8111-111111111111";
    const edit = prefillFromQuery("edit", src)!;
    expect(presetPrefill(edit, { template: "new_background" })?.sourceId).toBe(src);
  });

  it("knows its templates by id only", () => {
    expect(templateById("broll")?.capability).toBe("t2v");
    expect(templateById("BROLL")).toBeNull();
    expect(templateById(undefined)).toBeNull();
  });
});

describe("filterPresets", () => {
  const cards = cardsFor("en");
  it("narrows by kind and by every word", () => {
    expect(filterPresets(cards, "", "voice").every((c) => c.kind === "voice")).toBe(true);
    expect(filterPresets(cards, "", null)).toHaveLength(cards.length);
    expect(filterPresets(cards, "story video", null).map((c) => c.key)).toContain("format:story");
    expect(filterPresets(cards, "zzzzqq", null)).toEqual([]);
  });
  it("finds a look by its English name while reading Russian, and ignores accents and case", () => {
    const ru = cardsFor("ru");
    const s = STYLE_LIBRARY[0];
    expect(filterPresets(ru, s.name.en.toUpperCase(), "look").map((c: PresetCard) => c.id)).toContain(s.id);
  });
});

describe("copy", () => {
  const shape = (v: unknown): unknown =>
    v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v;
  const leaves = (v: unknown, out: string[] = []): string[] => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, out));
    return out;
  };
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");

  it("has the same keys and placeholders in en, ru and uz", () => {
    expect(shape(presetsRu)).toEqual(shape(presetsEn));
    expect(shape(presetsUz)).toEqual(shape(presetsEn));
    const en = leaves(presetsEn);
    const ru = leaves(presetsRu);
    const uz = leaves(presetsUz);
    expect(ru).toHaveLength(en.length);
    expect(uz).toHaveLength(en.length);
    en.forEach((s, i) => {
      expect(s.trim()).not.toBe("");
      expect(holes(ru[i])).toBe(holes(s));
      expect(holes(uz[i])).toBe(holes(s));
    });
  });

  it("is wired into every dictionary and writes Uzbek with the ʻ apostrophe", () => {
    expect(dictionaries.en.presets).toBe(presetsEn);
    expect(dictionaries.ru.presets).toBe(presetsRu);
    expect(dictionaries.uz.presets).toBe(presetsUz);
    expect(leaves(presetsUz).filter((s) => /\w'\w/.test(s))).toEqual([]);
  });
});

describe("PresetsGallery", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 404 })));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  const mount = (locale: Locale = "en") =>
    render(
      <I18nProvider locale={locale}>
        <PresetsGallery />
      </I18nProvider>,
    );

  it("shows one named link per card, grouped under four headings, and makes no request", () => {
    mount();
    const all = cardsFor("en");
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(all.length);
    for (const c of all) {
      const l = screen.getByRole("link", { name: `${presetsEn.actions[c.kind]}: ${c.title}` });
      expect(l.getAttribute("href")).toBe(c.href);
    }
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(
      PRESET_KINDS.map((k) => presetsEn.sections[k].title),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters by kind with pressed chips and by search, and says so when nothing matches", () => {
    mount();
    const voices = screen.getByRole("button", { name: presetsEn.kinds.voice });
    fireEvent.click(voices);
    expect(voices.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByRole("link")).toHaveLength(STUDIO_VOICES.length);

    fireEvent.click(screen.getByRole("button", { name: presetsEn.kinds.all }));
    fireEvent.change(screen.getByRole("searchbox", { name: presetsEn.searchLabel }), { target: { value: "shorts" } });
    const names = screen.getAllByRole("link").map((l) => l.getAttribute("aria-label"));
    expect(names.some((n) => n?.includes("Shorts"))).toBe(true);
    expect(names.length).toBeLessThan(cardsFor("en").length);

    fireEvent.change(screen.getByRole("searchbox", { name: presetsEn.searchLabel }), { target: { value: "zzzzqq" } });
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    const status = screen.getByRole("status");
    expect(within(status).getByText(presetsEn.noMatchTitle)).toBeTruthy();
    fireEvent.click(within(status).getByRole("button", { name: presetsEn.clear }));
    expect(screen.getAllByRole("link")).toHaveLength(cardsFor("en").length);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders in Russian and Uzbek with their own words", () => {
    for (const locale of ["ru", "uz"] as const) {
      const { unmount } = mount(locale);
      expect(screen.getByRole("searchbox", { name: dictionaries[locale].presets.searchLabel })).toBeTruthy();
      expect(screen.getAllByRole("link")).toHaveLength(cardsFor(locale).length);
      unmount();
    }
  });
});
