/**
 * A model sample's "Try it" (components/site/ShowcaseGallery.tsx): a link into the Studio with the sample's tool, model and
 * words in the form. It is a link and nothing more: the form is filled, nothing is priced, held or started until the person
 * presses Generate there and sees the price (CLAUDE.md #3). The panel keeps the model only if it offers it to that workspace
 * (lib/models-discovery prefillModel), and shows which model and price it will use before anything runs.
 *
 * Signed out, the link is sign-up with the Studio form as `next`: lib/safe-redirect.ts afterSignupPath carries it through the
 * e-mail confirmation and /welcome, and only a same-origin Studio path survives that (anything else falls back to /welcome).
 */
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { MODEL_ID_RE } from "@/lib/models-admin";
import { STUDIO_TOOL_CAPS } from "@/lib/models-discovery";
import { cleanLinkPrompt, isLinkPromptTool } from "@/lib/creative/improve";
import { fitsAfterSignup } from "@/lib/safe-redirect";
import { SIGNUP_PATH } from "@/lib/public-paths";

type Sample = { capability: string; modelId: string; prompt: string };

/** The Studio form for a sample, under the all-channels workspace, with its words cut to `max` characters; null for a tool the Studio has no form for. */
function studioPath(s: Sample, max: number): string | null {
  if (!(STUDIO_TOOL_CAPS as readonly string[]).includes(s.capability) || !MODEL_ID_RE.test(s.modelId)) return null;
  const q = new URLSearchParams({ tool: s.capability, model: s.modelId });
  const words = isLinkPromptTool(s.capability) ? cleanLinkPrompt(s.capability, s.prompt) : "";
  const cut = cutWords(words, max);
  if (cut) q.set("prompt", cut);
  return `/${ALL_CHANNELS_SLUG}/create?${q.toString()}`;
}

/** At most `max` characters of the words, ending on a whole word where there is one, never half a character. */
export function cutWords(words: string, max: number): string {
  const chars = Array.from(words);
  if (chars.length <= max) return words;
  const head = chars.slice(0, Math.max(0, max)).join("");
  const space = head.search(/\s\S*$/);
  return (space > 0 ? head.slice(0, space) : head).trim();
}

/** The Studio form for a signed-in visitor: the whole of the words the Studio box takes from a link (lib/creative/improve). */
export function studioTryHref(s: Sample): string | null {
  return studioPath(s, Number.MAX_SAFE_INTEGER);
}

/**
 * Sign-up, then the Studio form. The words are cut (on a word) until the form still fits through the callback and /welcome; a sample
 * whose form would not fit even with no words gets sign-up with the tool and model alone.
 */
export function signupTryHref(s: Sample): string | null {
  const full = studioPath(s, Number.MAX_SAFE_INTEGER);
  if (!full) return null;
  let path: string = full;
  if (!fitsAfterSignup(path)) {
    // Binary search on the number of characters: the encoded length grows with each one, by a different amount per script.
    let lo = 0;
    let hi = Array.from(s.prompt).length;
    let best: string | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = studioPath(s, mid);
      if (p && fitsAfterSignup(p)) {
        best = p;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (!best) return SIGNUP_PATH;
    path = best;
  }
  return `${SIGNUP_PATH}?next=${encodeURIComponent(path)}`;
}

export function tryHref(s: Sample, signedIn: boolean): string | null {
  return signedIn ? studioTryHref(s) : signupTryHref(s);
}
