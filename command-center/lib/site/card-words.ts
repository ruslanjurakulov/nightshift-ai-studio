/**
 * The words a public media card shows on hover (components/site/media-card.css): one short visual line, as Kling's cards read
 * ("Registan at blue hour."), never the whole generation prompt. The prompt travels only in the card's Studio link
 * (lib/site/showcase-link.ts tryHref), where the form needs it (owner decision 22 Nov).
 */
import type { Locale } from "@/lib/i18n/core";
import { CARD_LINE_MAX, type ShowcaseEntry } from "@/lib/site/showcase";
import { cutWords } from "@/lib/site/showcase-link";

/**
 * The prompt's first sentence, cut on a word to CARD_LINE_MAX characters. It is the sample's own words, so nothing is invented;
 * CSS still clamps it to one line. A stop-gap: it goes away as samples exported with a `cardLine` replace the older ones.
 */
export function firstSentence(prompt: string): string {
  const words = prompt.replace(/\s+/g, " ").trim();
  if (!words) return "";
  const m = /^(.+?[.!?。])(?=\s|$)/u.exec(words);
  const head = m ? m[1] : words;
  const cut = cutWords(head, CARD_LINE_MAX);
  return cut.length < head.length ? `${cut}…` : cut;
}

/** The card's line in this language: the export's `cardLine` when it has one, else the prompt's first sentence, else "". */
export function cardWords(e: Pick<ShowcaseEntry, "cardLine" | "prompt">, locale: Locale): string {
  return e.cardLine?.[locale] ?? firstSentence(e.prompt);
}
