/**
 * Where the landing's prompt bar (components/landing/PromptBar.tsx) sends a visitor: the Studio form with their words, and, signed
 * out, sign-up first with that form as `next` (the same way a sample's "Try this prompt" goes, lib/site/showcase-link.ts). It is a
 * link and nothing more: the form is filled, and nothing is priced, held or started until the person presses Generate there and
 * sees the price (CLAUDE.md #3). No model is named: the visitor picked none, and the Studio shows which one it will use.
 *
 * There is no "what to make" key: what the visitor attached decides it. Nothing attached is a clip from the words (t2v). A picture
 * or a video is kept in this browser (lib/site/pending-attachment.ts) and the link opens the Studio's composer with `attach=pending`:
 * the Studio uploads the file into the person's library and opens the tool for its kind (lib/creative/attach.ts toolForAttachment).
 *
 * Kept free of the Studio's own modules (the bar is client code and those pull in the model tables); the Studio cleans and bounds
 * the words again when it reads them from the link (lib/creative/improve prefillFromImprove, lib/creative/attach pendingWords), so
 * this only has to keep the link short and free of control characters. tests/site-ai-media.test.tsx holds the constants below
 * equal to the Studio's.
 */
import { STUDIO_NEXT_PREFIX, fitsAfterSignup } from "@/lib/safe-redirect";

/** The tools a link from the public site may fill with words (lib/creative/improve LINK_PROMPT_TOOLS). The bar itself uses t2v. */
export const PROMPT_TOOLS = ["t2v", "t2i"] as const;
export type PromptTool = (typeof PROMPT_TOOLS)[number];
/** What the bar makes when nothing is attached: a clip from the words. */
export const TEXT_TOOL: PromptTool = "t2v";

/** lib/creative/improve IMPROVE_PROMPT_MAX: the most the Studio box takes from a link. */
export const PROMPT_MAX = 1000;
/** lib/public-paths SIGNUP_PATH. */
const SIGNUP = "/signup";

/** `?attach=pending`: the Studio looks for the file kept in this browser (lib/site/pending-attachment.ts). Read by the create page. */
export const PENDING_PARAM = "attach";
export const PENDING_VALUE = "pending";

// C0/C1 controls, bidi overrides and isolates, zero-width marks: never carried in a link (the Studio strips them too).
const HIDDEN = /[\u0000-\u001f\u007f-\u009f؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** The words as the link carries them: hidden characters out, runs of space folded, at most `max` characters, ending on a whole word. */
export function linkWords(raw: string, max: number = PROMPT_MAX): string {
  const clean = raw.replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  const head = chars.slice(0, Math.max(0, max)).join("");
  const space = head.search(/\s\S*$/);
  return (space > 0 ? head.slice(0, space) : head).trim();
}

type Form = { tool: PromptTool } | { pending: true };

function studio(form: Form, words: string): string {
  const q = new URLSearchParams("tool" in form ? { tool: form.tool } : { [PENDING_PARAM]: PENDING_VALUE });
  if (words) q.set("prompt", words);
  return `${STUDIO_NEXT_PREFIX}?${q.toString()}`;
}

/** The bar's destination with nothing attached; null for empty words (the bar then asks for some instead of opening an empty form). */
export function promptHref(tool: PromptTool, raw: string, signedIn: boolean): string | null {
  if (!(PROMPT_TOOLS as readonly string[]).includes(tool)) return null;
  const words = linkWords(raw);
  if (!words) return null;
  return viaSignup({ tool }, words, signedIn);
}

/**
 * The bar's destination once a file is kept in this browser: the Studio's composer, which picks the file up and opens the tool for
 * it, with the words so far (none is fine: the file is what it is for), through sign-up when signed out.
 */
export function attachedHref(raw: string, signedIn: boolean): string {
  return viaSignup({ pending: true }, linkWords(raw), signedIn);
}

function viaSignup(form: Form, words: string, signedIn: boolean): string {
  if (signedIn) return studio(form, words);
  // Signed out, the whole form must still fit through the callback and /welcome: cut the words (on a word) until it does.
  let lo = 0;
  let hi = Array.from(words).length;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = studio(form, linkWords(words, mid));
    if (fitsAfterSignup(p)) {
      best = p;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best ? `${SIGNUP}?next=${encodeURIComponent(best)}` : SIGNUP;
}
