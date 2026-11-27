/**
 * The words a public media card shows on hover (components/site/media-card.css): one short visual line, as Kling's cards read
 * ("Registan at blue hour."), never the whole generation prompt. The prompt travels only in the card's Studio link
 * (lib/site/showcase-link.ts tryHref), where the form needs it (owner decision 22 Nov).
 */
import type { Locale } from "@/lib/i18n/core";
import { CARD_LINE_MAX, type ShowcaseEntry } from "@/lib/site/showcase";
import { cutWords } from "@/lib/site/showcase-link";

/** A card's line and the language it is written in (a screen reader pronounces it by `lang`). */
export type CardWords = { text: string; lang: string; source: "cardLine" | "prompt" };

// A full stop after one of these does not end the sentence: "St. Petersburg at dusk." is one sentence, not "St.".
const ABBREVIATIONS = /(?:^|\s)(?:St|Dr|Mr|Mrs|Ms|vs|e\.g|i\.e|etc)\.$/i;

/**
 * The prompt's first sentence, cut on a word to CARD_LINE_MAX characters, with an ellipsis where it was cut (never after a
 * dangling comma or dash). It is the sample's own words, so nothing is invented; CSS still clamps it to one line. A stop-gap: it
 * goes away as samples exported with a `cardLine` replace the older ones.
 */
export function firstSentence(prompt: string): string {
  const words = prompt.replace(/\s+/g, " ").trim();
  if (!words) return "";
  let head = words;
  const stop = /[.!?。](?=\s|$)/gu;
  for (let m = stop.exec(words); m; m = stop.exec(words)) {
    const upTo = words.slice(0, m.index + 1);
    if (m[0] === "." && ABBREVIATIONS.test(upTo)) continue;
    head = upTo;
    break;
  }
  const cut = cutWords(head, CARD_LINE_MAX);
  if (cut === head) return cut;
  return `${cut.replace(/[\s,;:—–-]+$/u, "")}…`;
}

/**
 * The card's line in this language: the export's `cardLine` when it has one (in the page's language), else the prompt's first
 * sentence (the prompts are written in English, so marked `en`), else "".
 */
export function cardWords(e: Pick<ShowcaseEntry, "cardLine" | "prompt">, locale: Locale): CardWords {
  const own = e.cardLine?.[locale];
  if (own) return { text: own, lang: locale, source: "cardLine" };
  return { text: firstSentence(e.prompt), lang: "en", source: "prompt" };
}
