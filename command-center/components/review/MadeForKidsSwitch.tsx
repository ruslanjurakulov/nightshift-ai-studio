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
 * YouTube's "made for kids" switch (migration 0140, lib/madeForKids.ts). Controlled: the caller owns the value and decides
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
 * The review panel's switch: what this video declares (videos.made_for_kids, 0140), saved through set_video_made_for_kids.
 * The database decides again (who may, the confirmation, a public video, a live approval); this only saves a press that would
 * come back refused, and says why.
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
  const [value, setValue] = useState<boolean | null>(view.value);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);
  const blocker = madeForKidsBlocker(video, { approvalLive, access });

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
      setValue(next);
      setMessage({ tone: "ok", text: m.saved });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const note = blocker
    ? m.blockers[blocker]
    : !view.recorded
      ? m.notRecorded
      : view.confirmedOff && video.made_for_kids_off_at
        ? fmt(m.confirmedOff, { when: video.made_for_kids_off_at.slice(0, 10) })
        : undefined;

  return (
    <div className="stack gap-2 rounded-[16px] border border-[var(--color-border)] p-4" data-testid="review-made-for-kids">
      <MadeForKidsSwitch
        id={`mfk-${video.video_id}`}
        checked={value}
        kids={view.kids}
        disabled={blocker !== null}
        busy={busy}
        note={note}
        onChange={(next, confirmedOff) => void save(next, confirmedOff)}
      />
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
