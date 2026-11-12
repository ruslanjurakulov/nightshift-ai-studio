/**
 * 1440p and 4K exports (migration 0132): the paid frames, their tiers and their length caps, and the server's quote.
 *
 * The twin of modules/hires_export.py (the worker) and of 0132's editor_export_hires_terms (the database); a parity test
 * (tests/test_editor_hires_export_migration.py) compares the three. Tiers are by PIXELS, so a frame and its 9:16 twin
 * are one tier: up to 1920x1080 free; up to 2560x1440 the 1440p tier; up to 3840x2160 the 4K tier.
 *
 * Why the caps: the media worker renders ONE export at a time for every organization, and a 4K render takes several
 * times its own length. Why paid: the owner's decision (2026-11-11): credits in proportion to render time, exports up
 * to 1080p stay free, and nothing above 1080p is free (a project whose own frame is bigger is exported in a paid size:
 * `aboveFree`). A price is shown only when the server computed it (quote_editor_export); nothing here prices.
 */

import { isExportPresetId, type ExportPresetId } from "@/lib/editorExportPresets";

export const FREE_MAX_PX = 1920 * 1080;
export const TIER_1440P_MAX_PX = 2560 * 1440;
export const TIER_2160P_MAX_PX = 3840 * 2160;

export type HiresTier = "1440p" | "2160p";

/** The longest paid export of each tier, in seconds of output (0132 and modules/hires_export.py MAX_S). */
export const HIRES_MAX_S: Readonly<Record<HiresTier, number>> = { "1440p": 300, "2160p": 180 };
/** The fastest frame rate of each tier (0132 and modules/hires_export.py MAX_FPS). 4K is 30 at most: a cross-faded 9:16
 *  4K60 render ran out of the worker's memory limit (measured). A 60 fps project is refused for 4K, never rendered at 30. */
export const HIRES_MAX_FPS: Readonly<Record<HiresTier, number>> = { "1440p": 60, "2160p": 30 };

/** The paid frames, each a frame and its 9:16 twin: schemas/export_presets.json after the five free ones, value for
 *  value (tests/editor-export-presets.test.ts). Never offered by the format picker: a project's own frame is exported
 *  free, so a 4K project frame would be a free 4K export. */
export const HIRES_EXPORT_PRESETS = [
  { id: "youtube_1440p", width: 2560, height: 1440, fps: 30, maxDurationS: 300 },
  { id: "vertical_1440p", width: 1440, height: 2560, fps: 30, maxDurationS: 300 },
  { id: "youtube_2160p", width: 3840, height: 2160, fps: 30, maxDurationS: 180 },
  { id: "vertical_2160p", width: 2160, height: 3840, fps: 30, maxDurationS: 180 },
] as const;

export type HiresPreset = (typeof HIRES_EXPORT_PRESETS)[number];
export type HiresPresetId = HiresPreset["id"];

export function isHiresPresetId(v: unknown): v is HiresPresetId {
  return typeof v === "string" && HIRES_EXPORT_PRESETS.some((p) => p.id === v);
}

export function hiresPresetById(v: unknown): HiresPreset | null {
  return HIRES_EXPORT_PRESETS.find((p) => p.id === v) ?? null;
}

/** "1440p" / "2160p" for a paid frame, null for a free one (or for anything that is not two positive integers, or a
 *  frame above 4K, which is never sold). */
export function hiresTier(width: unknown, height: unknown): HiresTier | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  const w = width as number;
  const h = height as number;
  if (w <= 0 || h <= 0) return null;
  const px = w * h;
  if (px <= FREE_MAX_PX) return null;
  if (px <= TIER_1440P_MAX_PX) return "1440p";
  if (px <= TIER_2160P_MAX_PX) return "2160p";
  return null;
}

/** Is a picture of this size above 1080p (more than 1920x1080 pixels either way up), so never exported free? Anything
 *  that is not two positive integers counts as above (the render would refuse it anyway). */
export function aboveFree(width: unknown, height: unknown): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return true;
  const w = width as number;
  const h = height as number;
  if (w <= 0 || h <= 0) return true;
  return w * h > FREE_MAX_PX;
}

/** Is a video of `lengthS` seconds over the paid frame's cap? false for a free frame. */
export function overHiresCap(width: number, height: number, lengthS: number): boolean {
  const tier = hiresTier(width, height);
  if (!tier) return false;
  return !Number.isFinite(lengthS) || lengthS > HIRES_MAX_S[tier] + 1e-9;
}

/** Is a project at `fps` too fast for the paid frame (4K: over 30)? false for a free frame. */
export function overHiresFps(width: number, height: number, fps: number): boolean {
  const tier = hiresTier(width, height);
  if (!tier) return false;
  return !Number.isFinite(fps) || fps > HIRES_MAX_FPS[tier];
}

/** A frame the server can quote (0136): the project's own ("project"), a free format, or a paid one. Up to 1080p a frame
 *  is free while its price is NULL (the quote then says so) and sold by the minute once the owner sets it. */
export type QuotableFrame = "project" | ExportPresetId | HiresPresetId;
export type QuoteTier = HiresTier | "1080p";

export function isQuotableFrame(v: unknown): v is QuotableFrame {
  return v === "project" || isExportPresetId(v) || isHiresPresetId(v);
}

/** What the server quoted for one sold frame (quote_editor_export, 0132 / 0136), as the quote route sends it on. */
export interface HiresQuote {
  frame: QuotableFrame;
  tier: QuoteTier;
  durationS: number;
  minutes: number;
  maxS: number;
  tooLong: boolean;
  /** The tier's fastest rate, and whether the saved version is faster (4K: 30). */
  maxFps: number;
  tooFast: boolean;
  /** The saved version's frame rate as the database read it (null when it is not a number). */
  fps: number | null;
  onSale: boolean;
  /** Credits per started minute; null = not on sale. */
  creditsPerMinute: number | null;
  /** The charge: what the video costs when it is done (the price per minute x the minutes, NOT raised to the platform's
   *  job minimum); the number the person confirms. null = not on sale. */
  credits: number | null;
  /** What Export holds while the video waits and renders: the charge raised to the platform's job minimum. The rest is
   *  given back when the video is done, all of it if it fails. null = not on sale. */
  hold: number | null;
  /** The saved version has a speed curve. */
  speedCurve: boolean;
  /** The database sells a speed curve at its rendered length (0136, editor_doc_rendered_length). A database that says
   *  nothing (0132 alone) does not: there, a curve is not sold (hires_speed_curve). */
  curveSold: boolean;
  /** The organization's available credits; null in the operator's exempt organization (nothing is held there). */
  available: number | null;
  exempt: boolean;
  /** May this member spend the organization's credits (editor or above)? */
  mayPay: boolean;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** The database's answer (snake_case jsonb) or the route's (camelCase) as a quote, or null when it is not one: a
 *  quote that is half understood is never shown as a price. */
export function parseHiresQuote(raw: unknown): HiresQuote | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const frame = r.frame;
  const tier = r.tier;
  if (!isQuotableFrame(frame) || (tier !== "1440p" && tier !== "2160p" && tier !== "1080p")) return null;
  // A paid frame is never the 1080p tier, and a frame up to 1080p never a paid tier.
  if (isHiresPresetId(frame) !== (tier !== "1080p")) return null;
  if (r.paid === false) return null;
  const durationS = num(r.duration_s ?? r.durationS);
  const minutes = num(r.minutes);
  const maxS = num(r.max_s ?? r.maxS);
  const maxFps = num(r.max_fps ?? r.maxFps);
  const cpm = r.credits_per_minute ?? r.creditsPerMinute;
  const credits = r.credits;
  const hold = r.hold;
  const available = r.available;
  const onSale = r.on_sale ?? r.onSale;
  if (durationS === null || minutes === null || maxS === null || maxFps === null || typeof onSale !== "boolean") return null;
  const creditsPerMinute = cpm === null ? null : num(cpm);
  const creditsN = credits === null ? null : num(credits);
  const holdN = hold === null || hold === undefined ? null : num(hold);
  if (onSale && (creditsPerMinute === null || creditsN === null || holdN === null || holdN < creditsN)) return null;
  return {
    frame,
    tier,
    durationS,
    minutes,
    maxS,
    tooLong: Boolean(r.too_long ?? r.tooLong),
    maxFps,
    tooFast: Boolean(r.too_fast ?? r.tooFast),
    fps: r.fps === null || r.fps === undefined ? null : num(r.fps),
    onSale,
    creditsPerMinute: onSale ? creditsPerMinute : null,
    credits: onSale ? creditsN : null,
    hold: onSale ? holdN : null,
    speedCurve: Boolean(r.speed_curve ?? r.speedCurve),
    curveSold: (r.curve_sold ?? r.curveSold) === true,
    available: available === null || available === undefined ? null : num(available),
    exempt: Boolean(r.exempt),
    mayPay: Boolean(r.may_pay ?? r.mayPay),
  };
}

/** The quote route's answer: a sold frame's quote, or `free` (a frame up to 1080p while its price is NULL). null = not understood. */
export type ExportQuote = { free: true; frame: QuotableFrame } | { free: false; quote: HiresQuote };

export function parseExportQuote(raw: unknown, frame: QuotableFrame): ExportQuote | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { free?: unknown; frame?: unknown; quote?: unknown };
  // Only a frame up to 1080p can be free; a paid one is never.
  if (r.free === true) return r.frame === frame && !isHiresPresetId(frame) ? { free: true, frame } : null;
  const quote = parseHiresQuote(r.quote);
  return quote && quote.frame === frame ? { free: false, quote } : null;
}

/** Why Export cannot spend on this quote now, or null when it can: the word the editor shows a sentence for. */
export function quoteBlocker(
  q: HiresQuote,
): "not_on_sale" | "hires_speed_curve" | "hires_too_long" | "hires_fps" | "forbidden" | "insufficient_credits" | null {
  if (!q.onSale) return "not_on_sale";
  if (q.speedCurve && !q.curveSold) return "hires_speed_curve";
  if (q.tooLong) return "hires_too_long";
  if (q.tooFast) return "hires_fps";
  if (!q.mayPay) return "forbidden";
  // The HOLD must be available (reserve_credits holds it), not only the charge.
  if (!q.exempt && q.available !== null && q.hold !== null && q.available < q.hold) return "insufficient_credits";
  return null;
}
