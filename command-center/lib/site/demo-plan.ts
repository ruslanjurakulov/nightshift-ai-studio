/**
 * The landing page's "try it" example, as plain functions.
 *
 * It is a picture of a plan's *shape* with the visitor's own words dropped in:
 * nothing is generated, nothing is sent anywhere, and the page says so next to
 * it (copy: site.try). Keeping the filling-in here, away from the component,
 * is what lets a test pin the two things that would make it dishonest or
 * unsafe: the typed text is only ever inserted as text (never interpreted),
 * and an empty topic never produces a plan.
 */

export type PlanItem = { k: string; v: string };
export type PlanSection = { id: string; name: string; items: readonly PlanItem[] };

/** Long enough for a real topic, short enough that a title built from it still fits a card. */
export const TOPIC_MAX = 90;

/** What the visitor typed, made safe to print: control characters out,
 *  runs of whitespace folded, trimmed, capped. Empty means "no topic". */
export function cleanTopic(raw: string): string {
  const folded = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(folded).slice(0, TOPIC_MAX).join("").trim();
}

/** The sections with `{topic}` replaced. split/join, not String.replace, so a
 *  topic containing "$&" or "$1" is inserted literally. Returns [] for no topic. */
export function buildPlan(sections: readonly PlanSection[], topic: string): PlanSection[] {
  const t = cleanTopic(topic);
  if (!t) return [];
  const fill = (s: string) => s.split("{topic}").join(t);
  return sections.map((s) => ({ ...s, items: s.items.map((i) => ({ k: i.k, v: fill(i.v) })) }));
}

/** The six example frames (components/site/samples.tsx), by id; listed here so this file stays free of image imports. */
export const STILL_IDS = ["silkroad", "library", "moon", "nightmarket", "valley", "lighthouse"] as const;
export type StillId = (typeof STILL_IDS)[number];

/** Words (en, ru, uz) that point at one of the six frames. The first rule that matches wins. */
const STILL_RULES: readonly [StillId, RegExp][] = [
  ["lighthouse", /lighthouse|storm|ship|\bsea\b|ocean|маяк|шторм|корабл|море|mayoq|boʻron|kema|dengiz/i],
  ["moon", /\bmoon\b|\bstars?\b|space|planet|galax|луна|луны|звёзд|звезд|космос|планет|\boy\b|yulduz|kosmos|osmon/i],
  ["silkroad", /silk|caravan|desert|camel|samarkand|history|empire|шёлк|шелк|караван|пустын|самарканд|истори|ipak|karvon|choʻl|samarqand|tarix/i],
  ["library", /librar|book|scroll|ancient|science|writing|библиотек|книг|свит|древн|наук|kutubxona|kitob|qadimiy|\bfan\b/i],
  ["nightmarket", /market|food|bread|cook|street|lantern|dough|рынок|еда|еды|хлеб|тест|готов|улиц|bozor|\bnon\b|xamir|taom|koʻcha/i],
  ["valley", /mountain|river|valley|nature|forest|hike|\bhills?\b|гор[аыуе]|рек[аи]|долин|природ|лес\b|togʻ|daryo|vodiy|tabiat|oʻrmon/i],
];

/**
 * The example frame that stands in for a thumbnail on the plan's last card: the
 * first of six frames whose words the topic touches, else one picked by a
 * fixed hash of the text, so the same topic always shows the same frame. It is
 * a stand-in from a fixed set of six and the page says so beside it
 * (site.try.thumbNote); nothing is generated from the topic.
 */
export function pickStill(topic: string): StillId {
  const t = cleanTopic(topic);
  for (const [id, re] of STILL_RULES) if (re.test(t)) return id;
  let h = 0;
  for (const ch of t) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return STILL_IDS[h % STILL_IDS.length];
}
