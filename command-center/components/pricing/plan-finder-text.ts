import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { formatDay } from "@/lib/date-format";
import { CHANNEL_RENDER, type RateStamp, type StudioRow } from "@/lib/plan-finder";

/**
 * The words /pricing's plan outputs, finder and cost table share, worked out on the server with the page's own
 * formatters (lib/date-format.ts and lib/number-format.ts print the same text on the server and in any browser).
 */

/** "Rate set Nov 3, 2026" (the price list's own date) or "Rate as read on Nov 14, 2026" (the day the page read it). */
export function stampText(t: Dictionary, stamp: RateStamp, locale: Locale): string {
  const d = new Date(stamp.at);
  const date = Number.isFinite(d.getTime()) ? formatDay(d, locale, "UTC") : "—";
  return fmt(stamp.kind === "set" ? t.planFinder.stamp.set : t.planFinder.stamp.read, { date });
}

/** "1080p": the frame a channel video is rendered at, named by its height (lib/plan-finder.ts CHANNEL_RENDER). */
export function renderName(): string {
  return `${CHANNEL_RENDER.height}p`;
}

/** A variant's parts in words: a quality tier and "with sound" are the Models screen's own words; a size stays as named. */
export function settingName(t: Dictionary, parts: readonly string[]): string {
  const c = t.modelDiscovery;
  return parts
    .map((p) => (p in c.quality ? c.quality[p as keyof typeof c.quality] : p in c.sound ? c.sound[p as keyof typeof c.sound] : p))
    .join(" · ");
}

/** "Model, High" / "Model, 1080p · With sound, 5 s" / "Model": the setting a Studio figure was worked out for. */
export function rowName(t: Dictionary, row: StudioRow): string {
  const c = t.planFinder.card;
  const bits = [settingName(t, row.parts), row.kind === "video" && row.seconds !== null ? fmt(c.clip, { s: row.seconds }) : ""].filter(Boolean);
  return bits.length ? fmt(c.withSetting, { model: row.model, setting: bits.join(", ") }) : fmt(c.one, { model: row.model });
}
