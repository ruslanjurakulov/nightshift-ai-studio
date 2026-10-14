/**
 * Presets & looks — the gallery's pure half.
 *
 * Nothing here is new: every card is a view of something the product already
 * has — the Home formats, the Style Library, the Studio templates and the
 * Studio's voice list — and its link opens the form that already takes it.
 * A link only FILLS a form: price, hold and confirmation stay in that form,
 * and this module (and the page) never calls anything that generates.
 *
 * Where each kind goes, and the parser on the other end that accepts it:
 *   format  /<slug>/create?topic&length&lang#run  lib/home runPrefillFromQuery
 *   look    /<slug>/styles?style=<library id>     lib/styles/library libraryStyleById
 *   starter /<slug>/create?tool=<cap>&template=…  prefillFromQuery + presetPrefill
 *   voice   /<slug>/create?tool=tts&voice=<id>    prefillFromQuery + presetPrefill
 *
 * Pure and client-safe (tests/presets.test.tsx).
 */
import type { Dictionary, Locale } from "@/lib/i18n";
import { channelPath } from "@/lib/channels";
import { HOME_FORMATS, defaultLanguage, lengthSeconds, runHandoffHref, type HomeFormatId } from "@/lib/home";
import {
  STUDIO_VOICES,
  isVoiceId,
  kindLabel,
  type StudioCapability,
  type StudioPrefill,
} from "@/lib/creative/studio";
import { STUDIO_TEMPLATES, templatePrefill, type StudioTemplate, type TemplateId } from "@/lib/creative/templates";
import { STYLE_LIBRARY, libraryStyleById, type LibraryStyle } from "@/lib/styles/library";

export const PRESET_KINDS = ["format", "look", "starter", "voice"] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];

/** What a card draws. Decorative: the words beside it say what the card is. */
export type PresetArt =
  | { kind: "format"; id: HomeFormatId }
  | { kind: "look"; style: LibraryStyle }
  | { kind: "starter"; template: StudioTemplate }
  | { kind: "voice"; id: string };

export interface PresetCard {
  /** `kind:id`, unique across the gallery. */
  key: string;
  kind: PresetKind;
  id: string;
  title: string;
  /** One honest line: who it is for / what it is. */
  who: string;
  /** The kind's name plus, for a starter, the tool it fills. */
  tag: string;
  /** The link: a channel path with a query, never an absolute URL. */
  href: string;
  art: PresetArt;
  /** Lower-cased, accent-free words the search looks at (all three languages for names). */
  haystack: string;
}

function norm(s: string): string {
  return s.toLocaleLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/ё/g, "е").trim();
}

// ── the links ───────────────────────────────────────────────────────────────

/** `/create?tool=<cap>&template=<id>` — the Studio tool, started from a template. */
export function starterHref(slug: string, tpl: Pick<StudioTemplate, "id" | "capability">): string {
  return channelPath(slug, `/create?tool=${encodeURIComponent(tpl.capability)}&template=${encodeURIComponent(tpl.id)}`);
}

/** `/create?tool=tts&voice=<id>` — Voice-over with that voice picked. */
export function voiceHref(slug: string, voiceId: string): string {
  return channelPath(slug, `/create?tool=tts&voice=${encodeURIComponent(voiceId)}`);
}

/** `/styles?style=<library id>` — the Style Library with that look opened. */
export function lookHref(slug: string, libraryId: string): string {
  return channelPath(slug, `/styles?style=${encodeURIComponent(libraryId)}`);
}

// ── the parsers the links are read with ─────────────────────────────────────

type Query = Record<string, string | string[] | undefined>;

const one = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function templateById(id: unknown): StudioTemplate | null {
  return typeof id === "string" ? (STUDIO_TEMPLATES.find((t) => t.id === id) ?? null) : null;
}

/** The look a /styles link names (`?style=`): a Style Library id this build has, else null. */
export function lookFromQuery(q: Query): LibraryStyle | null {
  return libraryStyleById(one(q.style));
}

/**
 * Adds a gallery link's extras to the prefill the Studio already derived from
 * `?tool=`: a template (only when it is for that very tool, so a stale or
 * hand-edited link cannot switch the tool) and a voice (Voice-over only, and
 * only one the Studio offers). Anything else leaves the prefill as it was.
 * Fills the form; prices and spends nothing.
 */
export function presetPrefill(initial: StudioPrefill | null, q: Query): StudioPrefill | null {
  if (!initial) return initial;
  const tpl = templateById(one(q.template));
  if (tpl && tpl.capability === initial.capability) {
    return { ...initial, ...templatePrefill(tpl), sourceId: initial.sourceId ?? null };
  }
  const voice = one(q.voice);
  if (initial.capability === "tts" && voice && isVoiceId(voice) && STUDIO_VOICES.some((v) => v.id === voice)) {
    return { ...initial, voiceId: voice };
  }
  return initial;
}

// ── the cards ───────────────────────────────────────────────────────────────

/**
 * Every card the gallery shows, in order: formats, looks, starters, voices.
 * Titles and lines come from the dictionaries of the things the cards open,
 * so a card never says what its target does not.
 */
export function buildPresetCards(slug: string, locale: Locale, t: Dictionary): PresetCard[] {
  const cards: PresetCard[] = [];
  const kind = t.presets.cardKind;
  const lang = defaultLanguage(locale);

  for (const f of HOME_FORMATS) {
    const copy = t.home.formats[f.id];
    cards.push({
      key: `format:${f.id}`,
      kind: "format",
      id: f.id,
      title: copy.title,
      who: copy.who,
      tag: kind.format,
      href: runHandoffHref(slug, { topic: copy.starter, seconds: lengthSeconds(f.length), language: lang }),
      art: { kind: "format", id: f.id },
      haystack: norm([f.id, copy.title, copy.who, kind.format].join(" | ")),
    });
  }

  for (const s of STYLE_LIBRARY) {
    cards.push({
      key: `look:${s.id}`,
      kind: "look",
      id: s.id,
      title: s.name[locale] || s.name.en,
      who: s.goodFor[locale] || s.goodFor.en,
      tag: kind.look,
      href: lookHref(slug, s.id),
      art: { kind: "look", style: s },
      // A person may type the English name in a Russian UI: every language's name is searched.
      haystack: norm([s.id.replace(/-/g, " "), s.name.en, s.name.ru, s.name.uz, s.goodFor[locale], kind.look].join(" | ")),
    });
  }

  for (const tpl of STUDIO_TEMPLATES) {
    const copy = t.studioTemplates.items[tpl.id as TemplateId];
    const tool = kindLabel(t, tpl.capability);
    cards.push({
      key: `starter:${tpl.id}`,
      kind: "starter",
      id: tpl.id,
      title: copy.title,
      who: copy.who,
      tag: `${kind.starter} · ${tool}`,
      href: starterHref(slug, tpl),
      art: { kind: "starter", template: tpl },
      haystack: norm([tpl.id.replace(/_/g, " "), copy.title, copy.who, tool, kind.starter].join(" | ")),
    });
  }

  const voiceStyles = t.desk.voiceStyles as Record<string, string>;
  for (const v of STUDIO_VOICES) {
    const style = voiceStyles[v.id] ?? v.style;
    cards.push({
      key: `voice:${v.id}`,
      kind: "voice",
      id: v.id,
      title: v.name,
      who: style,
      tag: kind.voice,
      href: voiceHref(slug, v.id),
      art: { kind: "voice", id: v.id },
      haystack: norm([v.name, style, v.style, kind.voice].join(" | ")),
    });
  }

  return cards;
}

/** The cards a search and a kind filter leave (every word must match; kind null = all kinds). */
export function filterPresets(cards: readonly PresetCard[], query: string, kind: PresetKind | null): PresetCard[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  return cards.filter((c) => (kind === null || c.kind === kind) && words.every((w) => c.haystack.includes(w)));
}

/** The tools a starter or voice card fills, for tests and the desk it lands on. */
export function cardTool(card: Pick<PresetCard, "kind" | "id">): StudioCapability | null {
  if (card.kind === "voice") return "tts";
  if (card.kind === "starter") return templateById(card.id)?.capability ?? null;
  return null;
}
