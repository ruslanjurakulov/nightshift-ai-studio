/**
 * Which template tiles may play their preview right now (components/prompt/TemplateTile.tsx).
 *
 * A gallery of looping 480p clips is the page's heaviest thing: every playing <video> holds a decoder, and a phone with a dozen of
 * them stutters, heats up and drains. So a tile only ASKS to play (hovered or focused on a pointer screen; at least 60% on screen on a
 * touch one) and this module decides: one per visual row (the most visible, then the leftmost) and never more than MAX_PLAYING at
 * once. A hovered or focused tile always wins its row, because the person pointed at it.
 */

export const MAX_PLAYING = 4;
/** Tiles whose tops are this close are one visual row (masonry tops never line up exactly). */
const ROW_SLACK_PX = 24;

export type PlayCandidate = {
  id: string;
  /** The tile's top and left in the viewport, px. */
  top: number;
  left: number;
  /** How much of the tile is on screen, 0..1; a hovered/focused tile asks with 2 so it always wins. */
  ratio: number;
};

/** The tiles that may play: at most one per row and `max` in all, the most wanted first. Pure, so it is tested on its own. */
export function pickPlaying(cands: readonly PlayCandidate[], max = MAX_PLAYING): Set<string> {
  const order = [...cands].sort((a, b) => b.ratio - a.ratio || a.top - b.top || a.left - b.left);
  const rows: number[] = [];
  const out = new Set<string>();
  for (const c of order) {
    if (out.size >= max) break;
    if (rows.some((top) => Math.abs(top - c.top) < ROW_SLACK_PX)) continue;
    rows.push(c.top);
    out.add(c.id);
  }
  return out;
}

// ── the page's one coordinator ─────────────────────────────────────────────────
const wants = new Map<string, PlayCandidate>();
const listeners = new Set<() => void>();
let playing = new Set<string>();

/** A tile asks to play (a candidate) or withdraws (null); every tile hears the new decision. */
export function wantPlay(id: string, cand: PlayCandidate | null): void {
  if (cand) wants.set(id, cand);
  else if (!wants.delete(id)) return;
  const next = pickPlaying([...wants.values()]);
  const same = next.size === playing.size && [...next].every((x) => playing.has(x));
  playing = next;
  if (!same) listeners.forEach((l) => l());
}

export function mayPlay(id: string): boolean {
  return playing.has(id);
}

export function onPlayChange(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** For tests: forget every request. */
export function resetPlay(): void {
  wants.clear();
  playing = new Set();
}

/** "9:16" → "9 / 16" for CSS aspect-ratio, so the tile's box is reserved before its poster loads (no layout shift). */
export function aspectCss(aspect: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(aspect ?? "");
  return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? `${m[1]} / ${m[2]}` : "16 / 9";
}
