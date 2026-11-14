"use client";

import { fmt } from "@/lib/i18n";
import type { FilmStudioDictionary } from "@/lib/i18n/film-studio";
import { clock, type SceneDraft } from "@/lib/films";

/** Where the ruler labels go: every 30 s on a short project, every minute or two on a long one, so they never crowd. */
export function rulerMarks(total: number): number[] {
  if (total <= 0) return [];
  const step = total <= 150 ? 30 : total <= 600 ? 60 : 120;
  const out: number[] = [];
  for (let s = 0; s < total; s += step) out.push(s);
  return out;
}

/**
 * The holographic timeline: one block per scene, as wide as its planned length, in the strip (a hologram, because nothing is shot),
 * and the narration under it. A block selects its scene. There is no voice waveform, music or subtitle track yet, because nothing has
 * been narrated or scored: an empty track drawn as a waveform would read as a measurement (rule 5).
 */
export function FilmTimeline({
  t,
  scenes,
  selected,
  target,
  max,
  onSelect,
}: {
  t: FilmStudioDictionary;
  scenes: readonly SceneDraft[];
  selected: string | null;
  /** The project's target length and the database's ceiling, in seconds: the total is always read against both. */
  target: number;
  max: number;
  onSelect: (key: string) => void;
}) {
  const total = scenes.reduce((s, x) => s + x.plannedSeconds, 0);
  const label = fmt(t.timeline.label, { n: scenes.length, planned: clock(total) });
  return (
    <section className="fs-timeline fs-glass" aria-label={label} data-testid="fs-timeline">
      <div className="fs-tl-head">
        <b>{t.timeline.heading}</b>
        <span className="tnum" data-over={total > max ? "true" : undefined} data-testid="fs-total">
          {fmt(t.timeline.total, { planned: clock(total), max: clock(max), target: clock(target) })}
        </span>
        {total > target && total <= max && <span>{t.canvas.overTarget}</span>}
      </div>
      {scenes.length === 0 ? (
        <div className="fs-tl-empty">{t.timeline.empty}</div>
      ) : (
        <div className="fs-tl-body">
          <span aria-hidden="true" />
          <div className="fs-ruler" aria-hidden="true">
            {rulerMarks(total).map((m) => (
              <span key={m} style={{ left: `${(m / total) * 100}%` }}>
                {clock(m)}
              </span>
            ))}
          </div>
          <span className="fs-tl-label">{t.timeline.picture}</span>
          <div className="fs-strip">
            {scenes.map((s, i) => (
              <button
                key={s.key}
                type="button"
                className="fs-block fs-holo"
                style={{ flex: `${s.plannedSeconds} 1 0` }}
                aria-current={s.key === selected ? "true" : undefined}
                aria-label={`${fmt(t.canvas.sceneN, { n: i + 1 })}, ${clock(s.plannedSeconds)}`}
                onClick={() => onSelect(s.key)}
                tabIndex={-1}
              >
                <span aria-hidden="true">{i + 1}</span>
              </button>
            ))}
          </div>
          <span className="fs-tl-label">{t.timeline.narration}</span>
          <div className="fs-narr" aria-hidden="true">
            {scenes.map((s) => (
              <span key={s.key} className="fs-narr-block" data-empty={s.narration.trim() ? undefined : "true"} style={{ flex: `${s.plannedSeconds} 1 0` }}>
                {s.narration.trim()}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
