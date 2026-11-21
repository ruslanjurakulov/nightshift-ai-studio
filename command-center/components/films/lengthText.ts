import { fmt } from "@/lib/i18n";
import type { FilmStudioDictionary } from "@/lib/i18n/film-studio";
import { targetLabel } from "@/lib/films";

/** Explicit units let the native picker announce an off-list length as a duration. */
export function lengthText(t: FilmStudioDictionary, seconds: number): string {
  const length = targetLabel(seconds);
  if (length.unit === "s") return fmt(t.create.seconds, { n: length.n });
  if (length.unit === "min") return fmt(t.create.minutes, { n: length.n });
  return fmt(t.create.minutesAndSeconds, { minutes: Math.floor(length.n / 60), seconds: length.n % 60 });
}
