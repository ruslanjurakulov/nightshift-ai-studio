/**
 * The landing's three moving pieces over our own samples (components/site/ShowcaseCarousel.tsx, BeforeAfter.tsx, PromptTicker.tsx):
 * the plain data they are built from, and the arithmetic they share. Kept free of React and of file imports, so it is the same on
 * the server (components/site/landing-samples.tsx builds the props) and in the tests.
 *
 * Nothing here invents a sample: every slide is one entry of lib/site/showcase.json whose files are in the repository, every
 * prompt is that job's own words, and a pair is a clip whose input picture IS another merged sample (the export checked it back to
 * its bytes). A title is the format's (lib/site/formats.ts), a line written for that clip, or the tool's name, never the model's.
 *
 * A slide carries no maker's credit line: the owner's rule (2026-11-13) is that no public surface shows "Powered by" or links to a
 * maker; the "AI-generated" label and the model's name stay, and the credit lives in the signed-in Studio.
 */
import type { ShowcaseEntry, ShowcaseFiles } from "@/lib/site/showcase";

/** One sample as the client pieces need it: plain strings, so it crosses the server/client boundary as it is. */
export interface SampleSlide {
  job: string;
  kind: "video" | "image";
  capability: string;
  title: string;
  /** The job's own words, as stored ("" when the tool took none). */
  prompt: string;
  modelName: string;
  /** lib/site/showcase.ts modelLeftOut: the card then says the model is not (or no longer) in the Studio. */
  leftOut: "preview" | "shut_down" | null;
  /** "Use this prompt" (lib/site/prompt-link.ts promptHref): a link that fills the Studio form and starts nothing; null for a tool the bar has no form for. */
  href: string | null;
  width: number;
  height: number;
  poster: string;
  posterSm: string;
  clip: ShowcaseFiles["clip"];
}

/** How long a picture holds the centre before the next card comes in (its slow zoom runs exactly this long). */
export const STILL_MS = 6000;

/** The capability names a title falls back to, in the page's language. */
export type KindTitles = { t2v: string; i2v: string; t2i: string; other: string };

/**
 * The card's title: the format's name where the sample shows a format, the line written for that clip, or what kind of sample it
 * is. Never the model (a title is read outside the card's credit line) and never the prompt cut short (that is shown beside it).
 */
export function slideTitle(e: Pick<ShowcaseEntry, "jobId" | "capability">, formatTitles: Readonly<Record<string, string>>, titles: Readonly<Record<string, string>>, kinds: KindTitles): string {
  return formatTitles[e.jobId] ?? titles[e.jobId] ?? (e.capability === "t2v" || e.capability === "i2v" || e.capability === "t2i" ? kinds[e.capability] : kinds.other);
}

/**
 * The carousel's order: the samples newest first, with a picture after every two clips, so the stills (all made before the clips)
 * are not one long run at the end. Every sample appears exactly once.
 */
export function carouselOrder<T extends { kind: "video" | "image" }>(items: readonly T[]): T[] {
  const clips = items.filter((s) => s.kind === "video");
  const stills = items.filter((s) => s.kind === "image");
  const out: T[] = [];
  let c = 0;
  let s = 0;
  while (c < clips.length || s < stills.length) {
    for (let k = 0; k < 2 && c < clips.length; k++) out.push(clips[c++]);
    if (s < stills.length) out.push(stills[s++]);
  }
  return out;
}

/** The index `step` cards away from `i` in a ring of `n` (wraps both ways); 0 for an empty ring. */
export function ringIndex(i: number, step: number, n: number): number {
  if (n <= 0) return 0;
  return (((i + step) % n) + n) % n;
}

/** Where card `i` sits relative to the centre card `at` in a ring of `n`: 0 is the centre, -1 the one to its left, and so on. */
export function ringOffset(i: number, at: number, n: number): number {
  if (n <= 0) return 0;
  let d = ringIndex(i, -at, n);
  if (d > n / 2) d -= n;
  return d;
}

/** Seconds as m:ss, rounded up (a clip with 0.2 s to go still has a second left); "" for anything that is not a measured time. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.ceil(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A prompt's first sentence, for the ticker, at most `max` characters and ending on a whole word. `cut` says whether anything was
 * left out, so the ticker can show the ellipsis: a shortened prompt must read as shortened, never as the whole of what was asked.
 */
export function firstSentence(prompt: string, max = 150): { text: string; cut: boolean } {
  const clean = prompt.replace(/\s+/g, " ").trim();
  const m = clean.match(/^.+?[.!?](?=\s|$)/);
  let text = m ? m[0] : clean;
  if (Array.from(text).length > max) {
    const head = Array.from(text).slice(0, max).join("");
    const space = head.search(/\s\S*$/);
    text = (space > 0 ? head.slice(0, space) : head).replace(/[\s,;:–—-]+$/, "");
  }
  return { text, cut: text.length < clean.length };
}

/**
 * The image-to-video pairs: a clip whose input picture is another sample on the list (by its job), with that picture. Only a
 * picture the list itself holds is ever shown as the source (the same rule as the gallery's "Made from this picture").
 */
export function beforeAfterPairs<T extends { e: Pick<ShowcaseEntry, "jobId" | "kind" | "input"> }>(items: readonly T[]): { clip: T; picture: T }[] {
  const byJob = new Map(items.map((it) => [it.e.jobId, it]));
  const out: { clip: T; picture: T }[] = [];
  for (const it of items) {
    if (it.e.kind !== "video" || it.e.input.kind !== "operator_job") continue;
    const pic = byJob.get(it.e.input.jobId);
    if (pic && pic.e.kind === "image") out.push({ clip: it, picture: pic });
  }
  return out;
}

/** The divider's position after a key press (the APG slider keys), kept inside 0..100. null for a key the slider does not use. */
export function sliderKey(value: number, key: string): number | null {
  const step = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -20, PageUp: 20 }[key];
  if (key === "Home") return 0;
  if (key === "End") return 100;
  if (step === undefined) return null;
  return Math.min(100, Math.max(0, value + step));
}
