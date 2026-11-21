import { fmt } from "@/lib/i18n";
import type { FilmStudioDictionary } from "@/lib/i18n/film-studio";
import { clock, targetLabel } from "@/lib/films";

/** A film's target length as the length pickers show it: "15 s", "5 min", or m:ss for a length saved off the list. */
export function lengthText(t: FilmStudioDictionary, seconds: number): string {
  const l = targetLabel(seconds);
  if (l.unit === "s") return fmt(t.create.seconds, { n: l.n });
  if (l.unit === "min") return fmt(t.create.minutes, { n: l.n });
  return clock(l.n);
}
