"use client";

import { fmt } from "@/lib/i18n";
import type { FilmStudioDictionary } from "@/lib/i18n/film-studio";
import { STATIONS, stationStates, type Film } from "@/lib/films";

/**
 * The station track: Idea · Storyboard · Sound · Shoot · Assemble · Handoff, on one line. It is a map of where the project is, not
 * a set of buttons: a station lights only from the project's real state (lib/films stationStates), the current one carries the amber
 * mark (`aria-current="step"`), and a station this release has no code for is dimmed with its reason in its accessible name.
 */
export function StationTrack({ t, film }: { t: FilmStudioDictionary; film: Pick<Film, "status"> }) {
  const states = stationStates();
  return (
    <nav className="fs-track" aria-label={t.stations.label} data-status={film.status}>
      <ol>
        {STATIONS.map((s, i) => {
          const st = states[s];
          const name = t.stations[s];
          const label = fmt(st === "done" ? t.stations.done : st === "current" ? t.stations.current : t.stations.later, { station: name });
          // The segment into a station is lit only when that station is done or current: light flows up to where the project is.
          const lit = i > 0 && st !== "later";
          return (
            <li key={s} data-lit={lit ? "true" : undefined}>
              <span className="fs-node" data-s={st} aria-current={st === "current" ? "step" : undefined} title={st === "later" ? label : undefined}>
                <span className="fs-dot" aria-hidden="true" />
                <span aria-hidden="true">{name}</span>
                <span className="fs-sr">{label}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
