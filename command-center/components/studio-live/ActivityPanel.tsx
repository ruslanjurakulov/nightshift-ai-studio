"use client";

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import type { Activity, ActivityItem } from "@/lib/studio/liveGraph";
import type { LogFamily, LogLine } from "@/lib/studio/liveLane";
import { utc } from "@/lib/studio/utc";
import { formatDay, formatDayTime } from "@/lib/date-format";
import { pluralText } from "@/lib/plural";

type T = ReturnType<typeof useI18n>["t"];

/** A take's step name, as the board names it: "Scene 3 · picture", "Voice". Anything else is "A step", never a guess. */
function stepName(t: T, it: ActivityItem): string {
  const k = t.studioLive.kinds;
  if (it.kind === "keyframe" && it.scene) return fmt(k.keyframe, { n: it.scene });
  if (it.kind === "clip" && it.scene) return fmt(k.clip, { n: it.scene });
  if (it.kind === "narration") return k.voice;
  return t.studioLive.activity.step;
}

/** One line's sentence. Only closed words: a log word the view has no sentence for is shown as its own code. */
export function activityText(t: T, it: ActivityItem): { text: string; known: boolean } {
  const a = t.studioLive.activity;
  if (it.word === "take_completed") return { text: fmt(a.made, { step: stepName(t, it) }), known: true };
  if (it.word === "take_failed") return { text: fmt(a.failed, { step: stepName(t, it) }), known: true };
  if (it.word === "take_retried") return { text: fmt(a.retried, { step: stepName(t, it) }), known: true };
  const w = a.words[it.word];
  if (!w) return { text: it.word, known: false };
  return { text: w, known: true };
}

/** The take kind a log line's family stands for, so its sentence names the step exactly as the board does (an extend is a clip). */
const FAMILY_KIND: Partial<Record<LogFamily, string>> = { clip: "clip", key: "keyframe", voice: "narration" };
const TAKE_SENTENCE = new Set(["take_completed", "take_failed", "take_retried"]);

/** A line as the sentence builder reads it: only the event word, its scene and the kind its tag was made from. */
const asItem = (l: LogLine): ActivityItem => ({ id: l.id, at: l.at, word: l.word, scene: l.scene, kind: FAMILY_KIND[l.family] ?? null });

/** Does the line's sentence already say its scene ("Scene 2 · clip: done")? Then the spoken tag does not say it again. */
const sentenceSaysScene = (l: LogLine) => TAKE_SENTENCE.has(l.word) && l.scene !== null && (l.family === "clip" || l.family === "key");

/** How a line ended: a failure or a refused start is `bad`, a take that will be tried again is `warn`. The word decides, nothing else. */
export function outcomeOf(word: string): "bad" | "warn" | null {
  if (word.endsWith("_failed") || word === "start_refused") return "bad";
  if (word === "take_retried") return "warn";
  return null;
}

/**
 * The tag said in words ("Clip, scene 3, shot 2"): `clip-03.2` is a code for the eye, not something a screen reader should spell.
 * The shot is said only when the visible tag shows it (`.2`), and the scene only when the sentence after it does not.
 */
export function tagName(t: T, l: LogLine, sceneSaid = false): string {
  const g = t.studioLive.activity.tags;
  switch (l.family) {
    case "clip": {
      const shot = l.shot !== null && /\.\d+$/.test(l.tag) ? l.shot : null;
      if (sceneSaid || l.scene === null) return shot !== null && l.scene !== null ? fmt(g.clipShotOnly, { shot }) : g.clip;
      return shot === null ? fmt(g.clipScene, { n: l.scene }) : fmt(g.clipShot, { n: l.scene, shot });
    }
    case "key":
      return sceneSaid || l.scene === null ? g.key : fmt(g.keyScene, { n: l.scene });
    case "voice":
      return g.voice;
    case "asm":
      return g.asm;
    case "seg":
      return g.seg;
    case "film":
      return g.film;
    default:
      // A take of a kind this build has no family for keeps its own (validated) kind word as the tag.
      return l.tag === "log" ? g.log : fmt(g.logCode, { code: l.tag });
  }
}

const reducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The most lines drawn at once: a long run must not cost a render per poll for rows nobody scrolls to. The rest are counted. */
export const MAX_DRAWN = 500;

type Arrived = { ids: ReadonlySet<string>; still: boolean };
const NONE: Arrived = { ids: new Set(), still: false };

/**
 * The lines that arrived since the previous reading of the same plan, decided before paint (a layout effect), so a new line is never
 * painted once without its mark. The first reading after mount (a refresh included) and the first reading of another plan mark
 * nothing: a restore must never replay the whole log as news. Under reduced motion the mark is `still`: a static bar, no animation
 * (SYSTEM §5: motion never carries the meaning alone), kept until the next reading.
 */
function useArrived(ids: readonly string[] | null, plan: string | null): Arrived {
  const seen = useRef<{ plan: string | null; ids: Set<string> } | null>(null);
  const [arrived, setArrived] = useState<Arrived>(NONE);
  const joined = ids ? ids.join("\n") : null;
  useLayoutEffect(() => {
    if (ids === null) return;
    const before = seen.current && seen.current.plan === plan ? seen.current.ids : null;
    const next = before ? ids.filter((id) => !before.has(id)) : [];
    setArrived((prev) => (next.length === 0 && prev.ids.size === 0 ? prev : { ids: new Set(next), still: reducedMotion() }));
    seen.current = { plan, ids: new Set(before ? [...before, ...ids] : ids) };
    // `joined` names the set of ids: a new array with the same lines is not a new reading worth marking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, plan]);
  // A switch of plan shows the new plan's lines with no mark in the same paint, before the effect has caught up.
  return seen.current && seen.current.plan !== plan ? NONE : arrived;
}

type Mark = "arriving" | "still" | null;

/** One line, redrawn only when its own line, time text or mark changes (a poll that adds one line redraws one row). */
const LogRow = memo(function LogRow({ line, time, mark, t }: { line: LogLine; time: string; mark: Mark; t: T }) {
  const { text, known } = activityText(t, asItem(line));
  const outcome = outcomeOf(line.word);
  const cls = mark === "arriving" ? "is-new is-arriving" : mark === "still" ? "is-new is-still" : undefined;
  return (
    <li className={cls} data-testid="live-activity-item" data-word={line.word} data-family={line.family} data-outcome={outcome ?? undefined}>
      <time className="lv-log-time ds-mono" dateTime={utc(line.at).toISOString()}>{time}</time>
      <span className="lv-tag ds-t-label" data-family={line.family} data-testid="live-activity-tag" title={line.tag}>
        <span className="lv-tag-code" aria-hidden="true">{line.tag}</span>
        {/* The full stop is for a screen reader: time, tag and sentence must not run together into one phrase. */}
        <span className="sr-only">{`${tagName(t, line, sentenceSaysScene(line))}. `}</span>
      </span>
      {known ? <span className="lv-log-text">{text}</span> : <code className="lv-log-text">{text}</code>}
    </li>
  );
});

/**
 * What happened, newest first, from the plan's own log: film_events for a project (film_json's newest 50, with the total), the
 * run's system_events for a channel video. Read-only. Steps that write no event are named in a line of their own, not invented,
 * and a log cut by its reader says how many earlier events are not shown.
 *
 * A project's lines (`lines`, from logLines) are drawn in the reference log style: a mono time, a tag per worker family made from
 * the row itself (`clip-03.2`, `key-03`, `voice`, `asm`, `seg`), and the sentence, with a divider where the day changes. One line
 * per recorded row; the worker's id, credits and free text in `detail` never reach this component, because logLines does not copy
 * them.
 */
export function ActivityPanel({
  activity,
  run,
  lines = null,
  plan = null,
  stale = false,
}: {
  activity: Activity;
  run: boolean;
  lines?: LogLine[] | null;
  plan?: string | null;
  /** The last read failed and these lines are the previous answer's (useLiveGraph). */
  stale?: boolean;
}) {
  const { t, locale } = useI18n();
  const a = t.studioLive.activity;
  const log = !run && lines !== null;
  const lang = locale === "uz" ? "uz-Latn-UZ" : locale;
  const clock = useMemo(() => new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }), [lang]);
  const today = new Date().toDateString();
  // One time rule for both logs. `dated`: a line from another day says its date in its own cell (a run's log); the project's log
  // says the day once, in a divider, and every time cell is HH:MM:SS. Uzbek month names from the app's own table (Pixel).
  const stamp = (d: Date, dated: boolean) => (dated && d.toDateString() !== today ? formatDayTime(d, locale) : clock.format(d));

  const items = useMemo(() => [...activity.items].reverse(), [activity.items]);
  const drawn = useMemo(() => (log ? [...lines].reverse().slice(0, MAX_DRAWN) : []), [log, lines]);
  const count = log ? drawn.length : activity.items.length;
  // Counted against what is drawn: a row the log could not read, or one past the drawing cap, is one more not shown, never a gap.
  const notDrawn = log ? lines.length - drawn.length : 0;
  const hidden = Math.max(notDrawn, activity.total !== null ? activity.total - count : 0);
  const arrived = useArrived(log ? lines.map((l) => l.id) : null, plan);
  // "Nothing recorded yet" is never said beside "N not shown": something was recorded.
  const empty = count === 0 && hidden === 0;

  // The list scrolls inside the panel: while more lines sit below the edge it fades there, so no row reads as cut in half.
  const listRef = useRef<HTMLOListElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = listRef.current;
    setMore(!!el && el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  }, []);
  useLayoutEffect(measure, [measure, drawn, items]);

  let rows: React.ReactNode = null;
  if (log) {
    const out: React.ReactNode[] = [];
    let day: string | null = today;
    for (const l of drawn) {
      const d = utc(l.at);
      const k = d.toDateString();
      // Newest first: a divider above the first line not of today, then wherever the day changes going down.
      if (k !== day) {
        out.push(
          <li key={`day:${k}:${l.id}`} className="lv-log-day" data-testid="live-activity-day">
            {formatDay(d, locale)}
          </li>,
        );
        day = k;
      }
      const mark: Mark = arrived.ids.has(l.id) ? (arrived.still ? "still" : "arriving") : null;
      out.push(<LogRow key={l.id} line={l} time={stamp(d, false)} mark={mark} t={t} />);
    }
    rows = out;
  }

  return (
    <section className={`lv-activity${log ? " is-log" : ""}`} aria-labelledby="lv-activity-title" data-testid="live-activity" data-stale={stale ? "" : undefined}>
      <h2 id="lv-activity-title" className="ds-t-heading-sm">{a.title}</h2>
      {/* Visible only: LiveView's own polite region already says these words, and a second region would say them twice. */}
      {stale ? <p className="lv-stale" data-testid="live-activity-stale">{t.studioLive.stale}</p> : null}
      {empty ? (
        <p className="lv-muted" data-testid="live-activity-empty">{a.empty}</p>
      ) : count === 0 ? null : log ? (
        // Scrollable at 320px: focusable and named, so a keyboard can scroll it in every browser (Pixel).
        <ol ref={listRef} onScroll={measure} className="lv-activity-list lv-log" data-more={more ? "" : undefined} tabIndex={0} aria-labelledby="lv-activity-title">
          {rows}
        </ol>
      ) : (
        <ol className="lv-activity-list" tabIndex={0} aria-labelledby="lv-activity-title">
          {items.map((it) => {
            const { text, known } = activityText(t, it);
            const at = utc(it.at);
            return (
              <li key={it.id} data-testid="live-activity-item" data-word={it.word}>
                <time dateTime={at.toISOString()}>{stamp(at, true)}</time>
                {known ? <span>{text}</span> : <code>{text}</code>}
              </li>
            );
          })}
        </ol>
      )}
      {hidden > 0 ? <p className="lv-muted" data-testid="live-activity-earlier">{pluralText(a.earlier, hidden, locale)}</p> : null}
      {activity.cut ? <p className="lv-muted" data-testid="live-activity-cut">{a.cut}</p> : null}
      <p className="lv-muted" data-testid="live-activity-unreported">{run ? a.notReportedRun : a.notReportedFilm}</p>
    </section>
  );
}
