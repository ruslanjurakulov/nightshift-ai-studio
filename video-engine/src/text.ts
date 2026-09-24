/** Small, pure text helpers shared by the graphic components. */

/** "the_light_goes_dark" -> "The Light Goes Dark". */
export const humanize = (name?: string | null): string =>
  (name ?? "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

/** Strip [SFX:..]/[MUSIC:..]/[PAUSE:..]/[VOICE:..] cue tags. */
export const cleanNarration = (text?: string | null): string =>
  (text ?? "")
    .replace(/\[(SFX|MUSIC|PAUSE|VOICE):[^\]]*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

export type Stat = { value: number; decimals: number; prefix: string; suffix: string };

/**
 * The first statistic in a text: "$5 million" -> {prefix:"$", value:5,
 * suffix:" million"}, "40%" -> {value:40, suffix:"%"}. null when none.
 */
export const parseStat = (text?: string | null): Stat | null => {
  const m = /([$€£])?\s?(\d[\d,]*(?:\.\d+)?)\s*(%|percent|per cent|million|billion|trillion|thousand|times)?/i.exec(
    text ?? "",
  );
  if (!m) return null;
  const raw = m[2].replace(/,/g, "");
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
  const unit = (m[3] ?? "").toLowerCase();
  const suffix = unit === "%" || unit === "percent" || unit === "per cent" ? "%" : unit ? ` ${unit}` : "";
  return { value, decimals, prefix: m[1] ?? "", suffix };
};

/** The first quotation of 4+ words, without its quote marks. null when none. */
export const extractQuote = (text?: string | null): string | null => {
  const m = /["“]((?:[^"”]+?\s+){3,}[^"”]+?)["”]/.exec(text ?? "");
  return m ? m[1].trim() : null;
};
