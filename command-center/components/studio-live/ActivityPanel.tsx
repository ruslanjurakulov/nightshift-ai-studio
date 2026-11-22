"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import type { Activity, ActivityItem } from "@/lib/studio/liveGraph";
import type { LogFamily, LogLine } from "@/lib/studio/liveLane";
import { utc } from "@/lib/studio/utc";
import { formatDayTime } from "@/lib/date-format";

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

/** A line as the sentence builder reads it: only the event word, its scene and the kind its tag was made from. */
const asItem = (l: LogLine): ActivityItem => ({ id: l.id, at: l.at, word: l.word, scene: l.scene, kind: FAMILY_KIND[l.family] ?? null });

/** The tag said in words ("Clip, scene 3, shot 2"): `clip-03.2` is a code for the eye, not something a screen reader should spell. */
export function tagName(t: T, l: LogLine): string {
  const g = t.studioLive.activity.tags;
  switch (l.family) {
    case "clip":
      if (l.scene === null) return g.clip;
      return l.shot === null ? fmt(g.clipScene, { n: l.scene }) : fmt(g.clipShot, { n: l.scene, shot: l.shot });
    case "key":
      return l.scene === null ? g.key : fmt(g.keyScene, { n: l.scene });
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

/**
 * The lines that arrived since the previous reading of the same plan. The first reading after mount (a refresh included) and the
 * first reading of another plan mark nothing: a restore must never replay the whole log as news. Under reduced motion nothing is
 * marked at all, so no animation class reaches the DOM.
 */
function useArrived(ids: readonly string[] | null, plan: string | null): ReadonlySet<string> {
  const seen = useRef<{ plan: string | null; ids: Set<string> } | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(() => new Set());
  const joined = ids ? ids.join("\n") : null;
  useEffect(() => {
    if (ids === null) return;
    const before = seen.current && seen.current.plan === plan ? seen.current.ids : null;
    const next = before && !reducedMotion() ? ids.filter((id) => !before.has(id)) : [];
    setArrived((prev) => (next.length === 0 && prev.size === 0 ? prev : new Set(next)));
    seen.current = { plan, ids: new Set(before ? [...before, ...ids] : ids) };
    // `joined` names the set of ids: a new array with the same lines is not a new reading worth marking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, plan]);
  return arrived;
}

/**
 * What happened, newest first, from the plan's own log: film_events for a project (film_json's newest 50, with the total), the
 * run's system_events for a channel video. Read-only. Steps that write no event are named in a line of their own, not invented,
 * and a log cut by its reader says how many earlier events are not shown.
 *
 * A project's lines (`lines`, from logLines) are drawn in the reference log style: a mono time, a tag per worker family made from
 * the row itself (`clip-03.2`, `key-03`, `voice`, `asm`, `seg`), and the sentence. One line per recorded row; the worker's id,
 * credits and free text in `detail` never reach this component, because logLines does not copy them.
 */
export function ActivityPanel({ activity, run, lines = null, plan = null }: { activity: Activity; run: boolean; lines?: LogLine[] | null; plan?: string | null }) {
  const { t, locale } = useI18n();
  const a = t.studioLive.activity;
  const log = !run && lines !== null;
  const items = [...activity.items].reverse();
  const shownLines = log ? [...lines].reverse() : [];
  const count = log ? lines.length : activity.items.length;
  // Counted against what is drawn: a row the log could not read is one more event not shown, never a silent gap.
  const hidden = activity.total !== null ? Math.max(0, activity.total - count) : 0;
  const arrived = useArrived(log ? lines.map((l) => l.id) : null, plan);
  const lang = locale === "uz" ? "uz-Latn-UZ" : locale;
  const today = new Date().toDateString();
  // A line from another day says its date: a plan from yesterday must not read as today's (Pixel).
  const when = (d: Date) =>
    d.toDateString() === today
      ? d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      : // Uzbek month names from the app's own table: stock Intl prints "M11" for uz (Pixel).
        formatDayTime(d, locale);
  const runWhen = (d: Date) =>
    d.toDateString() === today ? d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : formatDayTime(d, locale);
  const empty = log ? shownLines.length === 0 : items.length === 0;
  return (
    <section className={`lv-activity${log ? " is-log" : ""}`} aria-labelledby="lv-activity-title" data-testid="live-activity">
      <h2 id="lv-activity-title">{a.title}</h2>
      {empty ? (
        <p className="lv-muted" data-testid="live-activity-empty">{a.empty}</p>
      ) : log ? (
        // Scrollable at 320px: focusable and named, so a keyboard can scroll it in every browser (Pixel).
        <ol className="lv-activity-list lv-log" tabIndex={0} aria-labelledby="lv-activity-title">
          {shownLines.map((l) => {
            const { text, known } = activityText(t, asItem(l));
            const at = utc(l.at);
            return (
              <li
                key={l.id}
                className={arrived.has(l.id) ? "is-new" : undefined}
                data-testid="live-activity-item"
                data-word={l.word}
                data-family={l.family}
              >
                <time className="lv-log-time ds-mono" dateTime={at.toISOString()}>{when(at)}</time>
                <span className="lv-tag ds-t-label" data-family={l.family} data-testid="live-activity-tag">
                  <span aria-hidden="true">{l.tag}</span>
                  <span className="sr-only">{tagName(t, l)}</span>
                </span>
                {known ? <span className="lv-log-text">{text}</span> : <code className="lv-log-text">{text}</code>}
              </li>
            );
          })}
        </ol>
      ) : (
        <ol className="lv-activity-list" tabIndex={0} aria-labelledby="lv-activity-title">
          {items.map((it) => {
            const { text, known } = activityText(t, it);
            const at = utc(it.at);
            return (
              <li key={it.id} data-testid="live-activity-item" data-word={it.word}>
                <time dateTime={at.toISOString()}>{runWhen(at)}</time>
                {known ? <span>{text}</span> : <code>{text}</code>}
              </li>
            );
          })}
        </ol>
      )}
      {hidden > 0 ? <p className="lv-muted" data-testid="live-activity-earlier">{fmt(a.earlier, { n: hidden })}</p> : null}
      {activity.cut ? <p className="lv-muted" data-testid="live-activity-cut">{a.cut}</p> : null}
      <p className="lv-muted" data-testid="live-activity-unreported">{run ? a.notReportedRun : a.notReportedFilm}</p>
    </section>
  );
}
