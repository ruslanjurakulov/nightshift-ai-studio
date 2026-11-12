"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  errorFromRpc,
  madeForKidsBlocker,
  madeForKidsError,
  madeForKidsView,
  needsConfirm,
  type MadeForKidsFields,
} from "@/lib/madeForKids";

/**
 * YouTube's "made for kids" switch (migration 0141, lib/madeForKids.ts). Controlled: the caller owns the value and decides
 * what a change does (the Create form keeps it for the run; the review panel saves it, below).
 *
 * Kids content starts ON. Turning it OFF does not happen on the first press: the switch asks, in words, and only an explicit
 * "Yes, it is not made for kids" calls `onChange(false, true)`. Turning it on, or changing a video that is not kids content,
 * needs no confirmation. `checked === null` is "not recorded" and is drawn as neither on nor off (an unknown is not a no).
 */
export function MadeForKidsSwitch({
  id,
  checked,
  kids,
  disabled = false,
  busy = false,
  note,
  onChange,
}: {
  id: string;
  checked: boolean | null;
  kids: boolean;
  disabled?: boolean;
  busy?: boolean;
  /** One more line under the help (why it is locked, what was recorded); none when undefined. */
  note?: string;
  onChange: (next: boolean, confirmedOff: boolean) => void;
}) {
  const { t } = useI18n();
  const m = t.madeForKids;
  const [asking, setAsking] = useState(false);
  const off = disabled || busy;

  function press() {
    if (off) return;
    const next = checked !== true;
    if (needsConfirm({ kids }, next)) {
      setAsking(true);
      return;
    }
    onChange(next, false);
  }

  return (
    <div className="stack gap-2" data-testid="made-for-kids">
      <div className="flex items-start gap-3">
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={checked === null ? "mixed" : checked}
          aria-describedby={`${id}-help`}
          aria-disabled={off || undefined}
          disabled={disabled}
          onClick={press}
          className="mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-[var(--color-border)] p-0.5 transition-colors disabled:opacity-40"
          style={{
            background: checked === true ? "var(--color-primary)" : "var(--color-panel-2)",
            justifyContent: checked === true ? "flex-end" : checked === null ? "center" : "flex-start",
          }}
        >
          <span aria-hidden className="block size-4 rounded-full bg-[var(--color-fg)]" />
        </button>
        <label htmlFor={id} className="text-sm font-medium text-[var(--color-fg)]">
          {m.label}
        </label>
      </div>
      <p id={`${id}-help`} className="m-0 text-xs leading-relaxed text-[var(--color-muted)]">
        {m.help}
        {kids ? ` ${m.kidsNote}` : ""}
      </p>
      {note && (
        <p data-testid="made-for-kids-note" className="m-0 text-xs leading-relaxed text-[var(--color-muted)]">
          {note}
        </p>
      )}
      {asking && (
        <div
          role="alertdialog"
          aria-labelledby={`${id}-confirm-title`}
          aria-describedby={`${id}-confirm-body`}
          data-testid="made-for-kids-confirm"
          className="stack gap-2 rounded-[16px] border p-4"
          style={{ borderColor: "color-mix(in srgb, var(--color-warn) 45%, transparent)" }}
        >
          <p id={`${id}-confirm-title`} className="m-0 text-sm font-semibold text-[var(--color-fg)]">
            {m.confirmTitle}
          </p>
          <p id={`${id}-confirm-body`} className="m-0 text-xs leading-relaxed text-[var(--color-fg)]">
            {m.confirmBody}
          </p>
          <div className="flex flex-wrap gap-2">
            {/* The safe answer is the one that takes focus: Enter keeps it on. */}
            <button
              type="button"
              autoFocus
              onClick={() => setAsking(false)}
              className="btn-sky is-solid pill px-5 py-2 text-sm"
            >
              {m.confirmNo}
            </button>
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                onChange(false, true);
              }}
              className="btn-sky is-quiet pill px-5 py-2 text-sm"
            >
              {m.confirmYes}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The review panel's audience question: "Is this video made for kids?" with two explicit answers, as YouTube Studio asks before
 * a video goes public (the owner's decision on PR #699). Nothing is pre-selected until a person has answered: the pipeline's
 * detection (videos.made_for_kids before anyone answered) is shown as a hint beside the question, never as a chosen option.
 * Approving waits for the answer (lib/videoApproval.ts, and approve_video_publish refuses `audience_unanswered`). "No" on
 * detected kids content asks for the confirmation first. Each answer is saved through set_video_made_for_kids (migration 0141),
 * which records who answered and when; the database decides again (who may, the confirmation, a public video, a live approval).
 */
export function ReviewMadeForKids({
  video,
  access,
  approvalLive,
}: {
  video: MadeForKidsFields & { video_id: string; privacy?: string | null };
  access: "ok" | "not_admin" | "not_member";
  approvalLive: boolean;
}) {
  const { t } = useI18n();
  const m = t.madeForKids;
  const router = useRouter();
  const view = madeForKidsView(video);
  // The chosen answer: a person's, or none. The detection never fills it.
  const [choice, setChoice] = useState<boolean | null>(view.answered ? view.value : null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);
  const blocker = madeForKidsBlocker(video, { approvalLive, access });
  const locked = blocker !== null || busy;
  const id = `mfk-${video.video_id}`;

  async function save(next: boolean, confirmedOff: boolean) {
    if (busy || blocker) return;
    setBusy(true);
    setMessage(null);
    try {
      const supabase = createClient();
      if (!supabase) {
        setMessage({ tone: "fail", text: m.errors.failed });
        return;
      }
      const { data, error } = await supabase.rpc("set_video_made_for_kids", {
        p_video_id: video.video_id,
        p_made_for_kids: next,
        p_confirm_off: confirmedOff,
      });
      if (error) {
        setMessage({ tone: "fail", text: m.errors[errorFromRpc(error)] });
        return;
      }
      const out = (data ?? null) as { ok?: unknown; error?: unknown } | null;
      if (!out || out.ok !== true) {
        setMessage({ tone: "fail", text: m.errors[madeForKidsError(out?.error)] });
        return;
      }
      setChoice(next);
      setMessage({ tone: "ok", text: m.saved });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function pick(next: boolean) {
    if (locked || next === choice) return;
    // "No" for what the system takes for kids content: in so many words first.
    if (needsConfirm(view, next)) {
      setAsking(true);
      return;
    }
    void save(next, false);
  }

  const hint = !view.recorded ? m.hintUnknown : view.value ? m.hintKids : m.hintNotKids;
  const note = blocker
    ? m.blockers[blocker]
    : choice === null
      ? m.unanswered
      : view.confirmedOff && video.made_for_kids_off_at
        ? fmt(m.confirmedOff, { when: video.made_for_kids_off_at.slice(0, 10) })
        : view.answered && video.made_for_kids_answered_at
          ? fmt(m.answeredOn, { when: video.made_for_kids_answered_at.slice(0, 10) })
          : undefined;

  return (
    <div className="stack gap-2 rounded-[16px] border border-[var(--color-border)] p-4" data-testid="review-made-for-kids">
      <p id={`${id}-q`} className="m-0 text-sm font-medium text-[var(--color-fg)]">
        {m.question}
      </p>
      <div role="radiogroup" aria-labelledby={`${id}-q`} aria-describedby={`${id}-help`} aria-required="true" className="flex flex-wrap gap-2">
        {([true, false] as const).map((value) => (
          <button
            key={String(value)}
            type="button"
            role="radio"
            aria-checked={choice === value}
            aria-disabled={locked || undefined}
            disabled={blocker !== null}
            onClick={() => pick(value)}
            className={`pill px-5 py-2 text-sm disabled:opacity-40 ${choice === value ? "btn-sky is-solid" : "btn-sky is-quiet"}`}
          >
            {value ? m.yes : m.no}
          </button>
        ))}
      </div>
      <p data-testid="made-for-kids-hint" className="m-0 text-xs text-[var(--color-muted)]">
        {hint} · {m.hintNote}
      </p>
      <p id={`${id}-help`} className="m-0 text-xs leading-relaxed text-[var(--color-muted)]">
        {m.help}
      </p>
      {note && (
        <p data-testid="made-for-kids-note" className="m-0 text-xs leading-relaxed text-[var(--color-muted)]">
          {note}
        </p>
      )}
      {asking && (
        <div
          role="alertdialog"
          aria-labelledby={`${id}-confirm-title`}
          aria-describedby={`${id}-confirm-body`}
          data-testid="made-for-kids-confirm"
          className="stack gap-2 rounded-[16px] border p-4"
          style={{ borderColor: "color-mix(in srgb, var(--color-warn) 45%, transparent)" }}
        >
          <p id={`${id}-confirm-title`} className="m-0 text-sm font-semibold text-[var(--color-fg)]">
            {m.confirmTitle}
          </p>
          <p id={`${id}-confirm-body`} className="m-0 text-xs leading-relaxed text-[var(--color-fg)]">
            {m.confirmBody}
          </p>
          <div className="flex flex-wrap gap-2">
            {/* The safe answer takes focus: Enter does not declare a kids video "not for kids". */}
            <button type="button" autoFocus onClick={() => setAsking(false)} className="btn-sky is-solid pill px-5 py-2 text-sm">
              {m.confirmBack}
            </button>
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                void save(false, true);
              }}
              className="btn-sky is-quiet pill px-5 py-2 text-sm"
            >
              {m.confirmYes}
            </button>
          </div>
        </div>
      )}
      {busy && <p className="m-0 text-xs text-[var(--color-muted)]">{m.saving}</p>}
      {message && (
        <p
          role={message.tone === "fail" ? "alert" : "status"}
          data-testid="made-for-kids-message"
          className={`m-0 text-xs ${message.tone === "fail" ? "text-[var(--color-fail)]" : "text-[var(--color-ok)]"}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
