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
