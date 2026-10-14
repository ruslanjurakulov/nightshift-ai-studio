"use client";

import { useId, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { parseEmailPrefs, weeklyFromValue, weeklyValue, type EmailPrefs } from "@/lib/email-prefs";

/**
 * Settings → E-mail: whether "your video is ready" e-mails come (on until the
 * person turns them off) and how often the weekly summary does (never, until the
 * person picks a rhythm). Every change is one call to email_prefs_set (migration
 * 0103) under the person's own session, and the screen shows what the database
 * answered, not what was asked: a failed save puts the switch back and says so.
 *
 * The page renders this only while the e-mail worker is reporting (a switch for
 * mail nothing sends would be a promise nobody keeps).
 */
export function EmailNotifications({ initial }: { initial: EmailPrefs }) {
  const { t, locale } = useI18n();
  const e = t.emailNotifications;
  const titleId = useId();
  const readyId = useId();
  const readyHintId = useId();
  const weeklyId = useId();
  const weeklyHintId = useId();
  const [prefs, setPrefs] = useState<EmailPrefs>(initial);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"idle" | "saved" | "failed">("idle");

  async function save(change: { ready?: boolean; weekly?: number }) {
    const supabase = createClient();
    if (!supabase || busy) return;
    setBusy(true);
    setState("idle");
    // The language goes with every save: it is the one the person is reading this page in.
    const { data, error } = await supabase.rpc("email_prefs_set", {
      p_ready: change.ready ?? null,
      p_weekly: change.weekly ?? null,
      p_locale: locale,
    });
    setBusy(false);
    const saved = error ? null : parseEmailPrefs(data);
    if (!saved) {
      setState("failed");
      return;
    }
    setPrefs(saved);
    setState("saved");
  }

  return (
    <section className="panel flex flex-col gap-6 p-5 sm:p-6" aria-labelledby={titleId} aria-busy={busy || undefined}>
      <div>
        <h2 id={titleId} className="t-section">
          {e.title}
        </h2>
        <p className="g5-sub">{e.sub}</p>
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={prefs.ready}
          aria-labelledby={readyId}
          aria-describedby={readyHintId}
          // Not `disabled` while saving: a disabled button drops keyboard focus. save() ignores a second press.
          onClick={() => void save({ ready: !prefs.ready })}
          aria-busy={busy || undefined}
          className="usage-switch"
          data-on={prefs.ready ? "true" : "false"}
        >
          <span id={readyId} className="min-w-0 flex-1 basis-[12rem] text-left text-[15px] font-medium leading-snug">
            {e.readyLabel}
          </span>
          <span aria-hidden className="usage-switch-key">
            <span className="usage-switch-lamp" />
            <span>{busy ? e.saving : prefs.ready ? e.on : e.off}</span>
          </span>
        </button>
        <p id={readyHintId} className="text-sm leading-relaxed text-[var(--color-muted)]">
          {e.readyHint}
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-[var(--ns-rule)] pt-5">
        <label htmlFor={weeklyId} className="text-[15px] font-medium leading-snug">
          {e.weeklyLabel}
        </label>
        <select
          id={weeklyId}
          aria-describedby={weeklyHintId}
          value={weeklyValue(prefs)}
          disabled={busy}
          onChange={(ev) => {
            const n = weeklyFromValue(ev.target.value);
            if (n !== null) void save({ weekly: n });
          }}
          className="ns-field w-full max-w-xs"
        >
          <option value="0">{e.weeklyOff}</option>
          <option value="7">{e.weeklyEvery7}</option>
          <option value="14">{e.weeklyEvery14}</option>
        </select>
        <p id={weeklyHintId} className="text-sm leading-relaxed text-[var(--color-muted)]">
          {e.weeklyHint}
        </p>
      </div>

      <p role="status" className="text-sm text-[var(--color-ok)]" hidden={state !== "saved"}>
        {state === "saved" ? e.saved : null}
      </p>
      <p role="alert" className="text-sm text-[var(--color-fail)]" hidden={state !== "failed"}>
        {state === "failed" ? e.saveFailed : null}
      </p>
    </section>
  );
}
