/**
 * Where the landing's prompt bar (components/landing/PromptBar.tsx) sends a visitor: the Studio form with the tool and their words,
 * and, signed out, sign-up first with that form as `next` (the same way a sample's "Try this prompt" goes, lib/site/showcase-link.ts).
 * It is a link and nothing more: the form is filled, and nothing is priced, held or started until the person presses Generate there
 * and sees the price (CLAUDE.md #3). No model is named: the visitor picked none, and the Studio shows which one it will use.
 *
 * Kept free of the Studio's own modules (the bar is client code and those pull in the model tables); the Studio cleans and bounds
 * the words again when it reads them from the link (lib/creative/improve prefillFromImprove), so this only has to keep the link
 * short and free of control characters. tests/site-prompt-bar.test.ts holds the constants below equal to the Studio's.
 */
import { STUDIO_NEXT_PREFIX, fitsAfterSignup } from "@/lib/safe-redirect";

/** The tools the bar offers: both take their words from a link (lib/creative/improve LINK_PROMPT_TOOLS). */
export const PROMPT_TOOLS = ["t2v", "t2i"] as const;
export type PromptTool = (typeof PROMPT_TOOLS)[number];

/** lib/creative/improve IMPROVE_PROMPT_MAX: the most the Studio box takes from a link. */
export const PROMPT_MAX = 1000;
/** lib/public-paths SIGNUP_PATH. */
const SIGNUP = "/signup";

// C0/C1 controls, bidi overrides and isolates, zero-width marks: never carried in a link (the Studio strips them too).
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** The words as the link carries them: hidden characters out, runs of space folded, at most `max` characters, ending on a whole word. */
export function linkWords(raw: string, max: number = PROMPT_MAX): string {
  const clean = raw.replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  const head = chars.slice(0, Math.max(0, max)).join("");
  const space = head.search(/\s\S*$/);
  return (space > 0 ? head.slice(0, space) : head).trim();
}

function studio(tool: PromptTool, words: string): string {
  const q = new URLSearchParams({ tool });
  if (words) q.set("prompt", words);
  return `${STUDIO_NEXT_PREFIX}?${q.toString()}`;
}

/** The bar's destination; null for empty words (the bar then asks for some instead of opening an empty form). */
export function promptHref(tool: PromptTool, raw: string, signedIn: boolean): string | null {
  if (!(PROMPT_TOOLS as readonly string[]).includes(tool)) return null;
  const words = linkWords(raw);
  if (!words) return null;
  if (signedIn) return studio(tool, words);
  // Signed out, the whole form must still fit through the callback and /welcome: cut the words (on a word) until it does.
  let lo = 0;
  let hi = Array.from(words).length;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = studio(tool, linkWords(words, mid));
    if (fitsAfterSignup(p)) {
      best = p;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best ? `${SIGNUP}?next=${encodeURIComponent(best)}` : SIGNUP;
}
