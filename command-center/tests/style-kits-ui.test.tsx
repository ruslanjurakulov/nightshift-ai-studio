/**
 * Style kits and characters in the Studio (migration 0047), rendered to static
 * markup in every language. Pinned: an empty organization gets the first
 * action, not a blank grid; a card's cover is its first image still in the
 * library and a removed image is counted, not hidden; a character reads as its
 * @name; the channel's default kit is marked and offered for removal only with
 * one channel in view; and no customer-facing copy names another product.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { fmt } from "../lib/i18n";
import { esc } from "./helpers/supabaseStub";
import type { Character, StyleKit, StyleReference } from "../lib/style-kits";

const state = vi.hoisted(() => ({ locale: "en" as "en" | "ru" | "uz" }));

vi.mock("@/lib/i18n/context", async () => {
  const { dictionaries, fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: dictionaries[state.locale], locale: state.locale, fmt, setLocale: () => {} }) };
});
// Shared components on the public pages read the public slice the same way.
vi.mock("@/lib/i18n/public-context", async () => {
  const { dictionaries, fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: dictionaries[state.locale], locale: state.locale, fmt, setLocale: () => {} }) };
});

const { StyleSections } = await import("../components/studio/StyleSections");

const ref = (n: number, live: boolean, thumb: string | null = `/thumb/${n}`): StyleReference => ({
  assetId: `0c000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  position: n,
  live,
  mime: live ? "image/png" : null,
  width: null,
  height: null,
  thumbUrl: live ? thumb : null,
});

const KIT: StyleKit = {
  id: "0b000000-0000-4000-8000-00000000000b",
  name: "Warm documentary",
  description: "film grain",
  createdAt: null,
  updatedAt: null,
  references: [ref(0, false), ref(1, true, "/cover-1"), ref(2, true)],
};
const CHAR: Character = {
  id: "0d000000-0000-4000-8000-00000000000d",
  name: "hero",
  kind: "product",
  description: "",
  createdAt: null,
  updatedAt: null,
  references: [ref(5, true)],
};

function render(props: Partial<Parameters<typeof StyleSections>[0]> = {}, locale: "en" | "ru" | "uz" = "en") {
  state.locale = locale;
  return renderToStaticMarkup(
    createElement(StyleSections, {
      orgId: "0a000000-0000-4000-8000-00000000000a",
      initialKits: [],
      initialCharacters: [],
      channelId: null,
      channelKitId: null,
      libraryHref: "/x/library",
      ...props,
    }),
  );
}

describe("Studio style sections", () => {
  it.each([
    ["en", en],
    ["ru", ru],
    ["uz", uz],
  ] as const)("an empty organization is offered the first kit and character (%s)", (locale, t) => {
    const html = render({}, locale);
    expect(html).toContain(esc(t.styleKits.kitsTitle));
    expect(html).toContain(esc(t.styleKits.charsTitle));
    expect(html).toContain(esc(t.styleKits.emptyKits));
    expect(html).toContain(esc(t.styleKits.emptyChars));
    expect(html).toContain(esc(t.styleKits.newKit));
    expect(html).toContain(esc(t.styleKits.newChar));
  });

  it("covers a card with its first image still in the library and counts the removed one", () => {
    const html = render({ initialKits: [KIT] });
    expect(html).toContain('src="/cover-1"');
    expect(html).toContain(esc(fmt(en.styleKits.imagesCount, { n: 2 })));
    expect(html).toContain(esc(fmt(en.styleKits.missingRefs, { n: 1 })));
  });

  it("shows a character by its @name and kind", () => {
    const html = render({ initialCharacters: [CHAR] });
    expect(html).toContain("@hero");
    expect(html).toContain(esc(en.styleKits.kindProduct));
  });

  it("offers channel defaults only with one channel in view", () => {
    const all = render({ initialKits: [KIT] });
    expect(all).not.toContain(esc(en.styleKits.useForChannel));
    expect(all).toContain(esc(en.styleKits.pickChannelForKit));
    const one = render({ initialKits: [KIT], channelId: "chan-a", channelKitId: KIT.id });
    expect(one).toContain(esc(en.styleKits.channelDefault));
    expect(one).toContain(esc(en.styleKits.removeFromChannel));
  });

  it("names no other product in any language", () => {
    const brands = /krea|higgsfield|magiclight|kling|capcut|inshot|midjourney|openai|gemini|elevenlabs|moodboard|lora|soul id/i;
    for (const t of [en, ru, uz]) expect(JSON.stringify(t.styleKits)).not.toMatch(brands);
  });
});
