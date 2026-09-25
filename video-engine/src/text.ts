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


// Pronouns and determiners are not an attribution: `He wrote "..."` names no one.
const NOT_A_NAME = new Set(["he", "she", "they", "it", "we", "i", "you", "one", "someone", "the", "a", "an", "this", "that"]);
const SPEECH = "said|says|wrote|writes|recalled|declared|told|added|noted|warned|insisted|replied";
const NAME = "(?:[A-Z][\\w.'’-]*)(?:\\s+[A-Z][\\w.'’-]*){0,3}|the\\s+[a-z]+(?:\\s+[a-z]+)?";
const AFTER_RE = new RegExp(`^[,]?\\s*(?:${SPEECH})\\s+(${NAME})`);
const BEFORE_RE = new RegExp(`(${NAME})\\s+(?:${SPEECH})[,:]?\\s*$`);

const asAttribution = (raw?: string | null): string | null => {
  const name = (raw ?? "").trim().replace(/[.,;:]+$/, "");
  if (!name || NOT_A_NAME.has(name.toLowerCase())) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
};

export type Quote = { text: string; attribution: string | null };

/**
 * The first quotation of 4+ words plus, when the narration names its speaker
 * right next to it (`"..." wrote Moore` / `Moore wrote: "..."`), who said it.
 * A pronoun is not a speaker: no attribution rather than a guessed one.
 */
export const extractQuoteParts = (text?: string | null, maxWords = 45): Quote | null => {
  const src = text ?? "";
  const m = /["“]((?:[^"”]+?\s+){3,}[^"”]+?)["”]/.exec(src);
  if (!m) return null;
  const words = m[1].trim().split(/\s+/);
  const body = words.length > maxWords ? `${words.slice(0, maxWords).join(" ")}…` : words.join(" ");
  const after = AFTER_RE.exec(src.slice(m.index + m[0].length));
  const before = BEFORE_RE.exec(src.slice(0, m.index));
  return { text: body, attribution: asAttribution(after?.[1]) ?? asAttribution(before?.[1]) };
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december"];

export type TimelineEvent = {
  /** What the marker shows: "1900", "Dec 1900" or "1950s". */
  date: string;
  /** Sort key: year, then month (0 = no month). */
  year: number;
  month: number;
  /** The clause the date sits in, minus the date phrase; may be empty. */
  label: string;
};

// A year is 1000–2099, optionally a decade ("1950s"). Not part of a longer
// number ("1,900", "19000"), not money ("$1900"), not a quantity ("1500 miles").
const YEAR_RE = new RegExp(
  String.raw`(?<![\d$€£,.])(?:\b(${MONTHS.join("|")})\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?)?\b(1\d{3}|20\d{2})(s)?\b(?![.,]\d)` +
    String.raw`(?!\s*(?:%|percent|per cent|miles?|kilomet|km|metres?|meters?|feet|foot|tons?|tonnes?|people|men|women|soldiers|dollars|pounds|years? (?:ago|old)))`,
  "gi",
);
// The date phrase removed from the clause that becomes the event label.
const LEAD_RE = /\b(?:in|by|around|circa|since|until|from|during|on|of|at)?\s*(?:the\s+)?(?:early|late|mid-?)?\s*$/i;

const clip = (text: string, maxWords: number): string => {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length > maxWords ? `${words.slice(0, maxWords).join(" ")}…` : words.join(" ");
};

/**
 * Dated events in narration order → sorted by date, one per distinct date,
 * at most `max`. Deterministic; [] when the text names no year.
 */
export const extractTimeline = (text?: string | null, max = 5, labelWords = 7): TimelineEvent[] => {
  const src = cleanNarration(text);
  const seen = new Set<string>();
  const events: TimelineEvent[] = [];
  // Clauses: a date's label is the clause it sits in, so two dates in one
  // sentence ("built in 1899, dark by 1900") get their own words.
  const clauses = src.split(/(?<=[.!?])\s+|\s*[;:—–]\s*|,\s+(?=(?:and\s+|but\s+|then\s+)?[a-z])/);
  for (const clause of clauses) {
    YEAR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = YEAR_RE.exec(clause)) !== null) {
      const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0;
      const year = Number(m[2]);
      const date = `${month ? `${m[1].charAt(0).toUpperCase()}${m[1].slice(1, 3).toLowerCase()} ` : ""}${m[2]}${m[3] ? "s" : ""}`;
      if (seen.has(date)) continue;
      seen.add(date);
      const before = clause.slice(0, m.index).replace(LEAD_RE, "");
      const rest = `${before} ${clause.slice(m.index + m[0].length)}`
        .replace(/\s+/g, " ")
        .replace(/^[\s,;:.–—-]+|[\s,;:.–—-]+$/g, "")
        .replace(/^(?:and|but|then|so)\s+/i, "")
        .trim();
      const label = clip(rest, labelWords);
      events.push({ date, year, month, label: label ? label.charAt(0).toUpperCase() + label.slice(1) : "" });
    }
  }
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.year - b.e.year || a.e.month - b.e.month || a.i - b.i)
    .slice(0, max)
    .map(({ e }) => e);
};

/** The first sentence of the narration, at most `maxWords` words. */
export const firstSentence = (text?: string | null, maxWords = 28): string => {
  const src = cleanNarration(text);
  const s = src.split(/(?<=[.!?])\s+/)[0] ?? "";
  return clip(s.trim(), maxWords);
};
