/**
 * Guides over the editor's preview: where a short-form app draws its own interface over a 9:16 video, the
 * title- and action-safe areas, and centre and thirds lines. They are drawn on the preview only: nothing here
 * is a document field, and the export never sees them.
 *
 * The app areas are APPROXIMATE and say so in the UI. No app publishes one fixed layout for posts (they change
 * with the device and over time), so these are the vertical-video templates the platforms give advertisers,
 * read 2026-11 from secondary write-ups of them, as fractions of a 1080 x 1920 frame:
 *  - Reels: Meta's 9:16 safe zone, 14 % top, 35 % bottom, 6 % each side.
 *  - YouTube Shorts: Google's vertical video ad template, 288 px top, 672 px bottom, 48 px left, 192 px right.
 *  - TikTok: the in-feed ad template, 240 px top, 660 px bottom, 120 px each side, and 300 px on the right from
 *    840 px down (the button column).
 * Title and action safe are SMPTE ST 2046-1's: action 93 % and title (graphics) 90 % of each side.
 */
import type { EditorModel } from "@/lib/editor";

export const GUIDE_APPS = ["shorts", "tiktok", "reels"] as const;
export type GuideApp = (typeof GUIDE_APPS)[number];

/** A rectangle as fractions of the frame (0..1 from the top-left). */
export interface GuideRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const W = 1080;
const H = 1920;
/** The parts of a 9:16 frame each app covers with its own interface. */
const APP_AREAS: Record<GuideApp, GuideRect[]> = {
  reels: [
    { x: 0, y: 0, w: 1, h: 0.14 },
    { x: 0, y: 0.65, w: 1, h: 0.35 },
    { x: 0, y: 0.14, w: 0.06, h: 0.51 },
    { x: 0.94, y: 0.14, w: 0.06, h: 0.51 },
  ],
  shorts: [
    { x: 0, y: 0, w: 1, h: 288 / H },
    { x: 0, y: (H - 672) / H, w: 1, h: 672 / H },
    { x: 0, y: 288 / H, w: 48 / W, h: (H - 288 - 672) / H },
    { x: (W - 192) / W, y: 288 / H, w: 192 / W, h: (H - 288 - 672) / H },
  ],
  tiktok: [
    { x: 0, y: 0, w: 1, h: 240 / H },
    { x: 0, y: (H - 660) / H, w: 1, h: 660 / H },
    { x: 0, y: 240 / H, w: 120 / W, h: (H - 240 - 660) / H },
    { x: (W - 120) / W, y: 240 / H, w: 120 / W, h: (840 - 240) / H },
    { x: (W - 300) / W, y: 840 / H, w: 300 / W, h: (H - 840 - 660) / H },
  ],
};

/** SMPTE ST 2046-1: the share of each side inside which action (93 %) and titles (90 %) are kept. */
export const ACTION_SAFE = 0.93;
export const TITLE_SAFE = 0.9;

/** Is the frame 9:16 (to within a pixel or so), the shape the app areas are drawn for? */
export function isVerticalNineSixteen(frame: Pick<EditorModel, "width" | "height">): boolean {
  if (!(frame.width > 0 && frame.height > 0)) return false;
  return Math.abs(frame.width / frame.height - 9 / 16) < 0.005;
}

/** The app areas to draw for this frame: none unless it is 9:16. */
export function appAreas(frame: Pick<EditorModel, "width" | "height">, app: GuideApp | null): GuideRect[] {
  if (!app || !isVerticalNineSixteen(frame)) return [];
  return APP_AREAS[app];
}

/** A centred rectangle covering `share` of each side. */
export function safeRect(share: number): GuideRect {
  const m = (1 - share) / 2;
  return { x: m, y: m, w: share, h: share };
}

/** Which guides a person has switched on (per viewer, kept in this browser only). */
export interface GuideChoice {
  app: GuideApp | null;
  safe: boolean;
  grid: boolean;
}
export const GUIDES_OFF: GuideChoice = { app: null, safe: false, grid: false };
const STORE = "ns-editor-guides";

/** The saved choice, or all off when there is none or the browser will not say (private window, tests). */
export function loadGuides(): GuideChoice {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORE);
    if (!raw) return GUIDES_OFF;
    const v = JSON.parse(raw) as Partial<GuideChoice>;
    return {
      app: (GUIDE_APPS as readonly unknown[]).includes(v.app) ? (v.app as GuideApp) : null,
      safe: v.safe === true,
      grid: v.grid === true,
    };
  } catch {
    return GUIDES_OFF;
  }
}

export function saveGuides(g: GuideChoice): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(g));
  } catch {
    /* a convenience only: the guides still work for this page */
  }
}
