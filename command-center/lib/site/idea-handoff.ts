/**
 * The landing's "Write your idea" box (components/landing/home/IdeaBox.tsx) hands the visitor's words to the Studio, through sign-up
 * when signed out. Nothing runs, is priced or reaches a model on the way: the Studio fills its box and the person presses send there
 * (CLAUDE.md rule 3).
 *
 * The words do not travel in the address. A `next` through the auth callback and /welcome is at most 512 characters
 * (lib/safe-redirect.ts), and an idea of 2000 characters in Cyrillic is about 12,000 once encoded; an address is also kept in history,
 * proxies and server logs. So the words stay in THIS browser's own storage (first party, never sent anywhere, never to analytics),
 * for two hours, and the address carries only `idea=1`. The Studio takes them once: read and deleted together, so a reload or a
 * second tab never fills a box with them again. Storage that is off or full is not a dead end: the box then sends the words in the
 * address instead, cut to what fits (lib/site/prompt-link.ts, the landing prompt bar's way).
 *
 * Kept free of the Studio's modules (the box is client code on the landing and must stay small for its first paint).
 */
import { STUDIO_NEXT_PREFIX } from "@/lib/safe-redirect";

/** The most the box takes, and the most the Studio is handed. */
export const IDEA_MAX = 2000;
/** Long enough to confirm an e-mail address; short enough that a shared computer does not keep it for the next person. */
export const IDEA_TTL_MS = 2 * 60 * 60 * 1000;
export const IDEA_KEY = "ns.idea.v1";
/** `?idea=1` on the Studio's address: "the words are kept in this browser". Read by the create page. */
export const IDEA_PARAM = "idea";
/** Where the words go: the Studio form in the all-channels workspace, the one `next` sign-up carries through /welcome. */
export const IDEA_NEXT = `${STUDIO_NEXT_PREFIX}?${IDEA_PARAM}=1`;
/** lib/public-paths SIGNUP_PATH. */
const SIGNUP = "/signup";

/** Signed out (or not known): sign-up, then the Studio. A signed-in visitor is sent straight on by the middleware. */
export const IDEA_HREF = `${SIGNUP}?next=${encodeURIComponent(IDEA_NEXT)}`;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// Controls (except the line break), bidi overrides and isolates, zero-width marks: never kept, never shown back.
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * The words as kept: hidden characters out, line breaks kept (an idea can have paragraphs) but at most one empty line in a row,
 * spaces folded, at most IDEA_MAX characters ending on a whole word. Empty when nothing is left.
 */
export function ideaWords(raw: string): string {
  const clean = raw
    .replace(/\r\n?/g, "\n")
    .replace(HIDDEN, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chars = Array.from(clean);
  if (chars.length <= IDEA_MAX) return clean;
  const head = chars.slice(0, IDEA_MAX).join("");
  const space = head.search(/\s\S*$/);
  return (space > 0 ? head.slice(0, space) : head).trim();
}

/** This browser's storage, or null where it is off (private windows, blocked site data): reading the property can throw. */
export function localStore(): Store | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Keep the words for the Studio. False when they could not be kept (no storage, full, refused): the caller sends them another way. */
export function stashIdea(raw: string, store: Store | null = localStore(), now: number = Date.now()): boolean {
  const text = ideaWords(raw);
  if (!text || !store) return false;
  try {
    store.setItem(IDEA_KEY, JSON.stringify({ text, at: now }));
    return store.getItem(IDEA_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * The kept words, once: they are deleted as they are read, whatever they turn out to be. Null when there are none, they are older
 * than IDEA_TTL_MS (or dated in the future), the record is not one this module wrote, or storage cannot be read. The caller shows
 * an empty box then, never an error: the visitor can type again.
 */
export function takeIdea(store: Store | null = localStore(), now: number = Date.now()): string | null {
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(IDEA_KEY);
    store.removeItem(IDEA_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object") return null;
  const { text, at } = rec as { text?: unknown; at?: unknown };
  if (typeof text !== "string" || typeof at !== "number" || !Number.isFinite(at)) return null;
  if (at > now || now - at > IDEA_TTL_MS) return null;
  const words = ideaWords(text);
  return words || null;
}
