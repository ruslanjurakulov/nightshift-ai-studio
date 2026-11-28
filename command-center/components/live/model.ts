/**
 * The live canvas's pure values: kinds, states, timings and geometry. No "use client" here on purpose: a server page may
 * import these to prepare a board's data, and a value exported from a client module turns into a client reference on the
 * server (dotting into MEDIA_OF or calling landDelay there throws at request time, and typechecks fine).
 */
export type LiveNodeKind = "script" | "shot" | "character" | "location" | "prop" | "still" | "clip" | "voice" | "music" | "film";
/** The data a card carries, which colours its dot and its connectors (SYSTEM.md §4: type hues are media identity only). */
export type LiveMediaType = "text" | "image" | "video" | "audio";
export type LiveNodeState = "ghost" | "queued" | "working" | "arrived" | "failed" | "disabled" | "insufficient";
export type LivePhase = "queued" | "making" | "storing";

export const MEDIA_OF: Readonly<Record<LiveNodeKind, LiveMediaType>> = {
  script: "text",
  shot: "text",
  character: "image",
  location: "image",
  prop: "image",
  still: "image",
  clip: "video",
  voice: "audio",
  music: "audio",
  film: "video",
};

/** Time between two cards landing (the plan's 60–120 ms band), and the most a card ever waits for its turn. */
export const LAND_STAGGER_MS = 90;
export const LAND_MAX_DELAY_MS = 540;

export function landDelay(order: number | undefined): number {
  if (order == null || !Number.isFinite(order) || order <= 0) return 0;
  return Math.min(Math.floor(order) * LAND_STAGGER_MS, LAND_MAX_DELAY_MS);
}

/** How long the one soft glow stays after a watched job arrives. */
export const LANDED_GLOW_MS = 1200;

export const REVEAL_MS_PER_CHAR = 25;
export const REVEAL_MAX_MS = 600;

/** How long the reveal of `length` characters takes. */
export function revealDuration(length: number): number {
  return Math.min(Math.max(0, length) * REVEAL_MS_PER_CHAR, REVEAL_MAX_MS);
}

/** How many characters are shown `elapsed` ms into the reveal. */
export function revealedCount(length: number, elapsed: number): number {
  const total = revealDuration(length);
  if (total <= 0 || elapsed >= total) return length;
  if (elapsed <= 0) return 0;
  return Math.min(length, Math.floor((elapsed / total) * length));
}

/** 65 → "1:05", 3725 → "1:02:05". Tabular, so the card does not jitter as it ticks. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * A top-up link must stay inside the app: a relative path from our own routes. Anything else (an absolute URL, a
 * protocol-relative "//", a javascript: URL) is refused and the card shows no link rather than a link that leaves.
 */
export function isAppPath(href: string): boolean {
  return /^\/(?!\/)/.test(href) && !/[\s\\]/.test(href);
}
