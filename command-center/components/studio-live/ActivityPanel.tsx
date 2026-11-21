"use client";

import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import type { Activity, ActivityItem } from "@/lib/studio/liveGraph";

type T = ReturnType<typeof useI18n>["t"];

/** Event times are text, often a naive utcnow().isoformat(): read without an offset they would be local time (as LiveView.utc). */
const utc = (ts: string) => new Date(/([zZ]|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts}Z`);

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

/**
 * What happened, newest first, from the plan's own log: film_events for a project (film_json's newest 50, with the total), the
 * run's system_events for a channel video. Read-only. Steps that write no event are named in a line of their own, not invented,
 * and a log cut by its reader says how many earlier events are not shown.
 */
export function ActivityPanel({ activity, run }: { activity: Activity; run: boolean }) {
  const { t, locale } = useI18n();
  const a = t.studioLive.activity;
  const items = [...activity.items].reverse();
  const hidden = activity.total !== null ? Math.max(0, activity.total - activity.items.length) : 0;
  const lang = locale === "uz" ? "uz-Latn-UZ" : locale;
  return (
    <section className="lv-activity" aria-labelledby="lv-activity-title" data-testid="live-activity">
      <h2 id="lv-activity-title">{a.title}</h2>
      {items.length === 0 ? (
        <p className="lv-muted" data-testid="live-activity-empty">{a.empty}</p>
      ) : (
        <ol className="lv-activity-list">
          {items.map((it) => {
            const { text, known } = activityText(t, it);
            const at = utc(it.at);
            return (
              <li key={it.id} data-testid="live-activity-item" data-word={it.word}>
                <time dateTime={at.toISOString()}>{at.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                {known ? <span>{text}</span> : <code>{text}</code>}
              </li>
            );
          })}
        </ol>
      )}
      {hidden > 0 ? <p className="lv-muted" data-testid="live-activity-earlier">{fmt(a.earlier, { n: hidden })}</p> : null}
      <p className="lv-muted" data-testid="live-activity-unreported">{run ? a.notReportedRun : a.notReportedFilm}</p>
    </section>
  );
}
