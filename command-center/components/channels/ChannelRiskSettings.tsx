"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  MAX_SPEND_CEILING_USD,
  effectiveSpendCeiling,
  flagIsOn,
  parseSpendCeiling,
  withSpendCeiling,
} from "@/lib/channelRisk";
import type { ChannelAgentConfig } from "@/lib/types";

type Notice = { kind: "saved" } | { kind: "failed"; detail: string } | null;

/**
 * Three channel settings that only hold things back or switch an extra off, written like the storyboard review switch: the
 * live agent_config is read, one key is merged in, and the whole object is written back (an unreadable config is not written).
 * `spend_ceiling_usd`, `pinned_comment` and `watch_next` are not among the keys channels_config_guard reserves for an
 * administrator (migration 0086/0114/0117), so an editor of the organization may write them; the page offers them to the same
 * people AiDisclosureSettings does.
 *
 * The limit is saved only as a plain amount above 0 (lib/channelRisk.ts): the worker reads 0, a negative or a number it cannot
 * parse as "no limit", so the page refuses those and says why instead of showing a limit that is not enforced. The shown limit
 * is what the worker enforces for the stored value, not the stored text.
 */
export function ChannelRiskSettings({
  channelId,
  agent,
  canEdit,
}: {
  channelId: string;
  agent: ChannelAgentConfig | null | undefined;
  /** May the caller write the channel at all (an editor of its organization)? */
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const uid = useId();
  const r = t.channelRisk;

  const [ceiling, setCeiling] = useState<number | null>(() => effectiveSpendCeiling(agent?.spend_ceiling_usd));
  const [typed, setTyped] = useState(() => {
    const c = effectiveSpendCeiling(agent?.spend_ceiling_usd);
    return c === null ? "" : String(c);
  });
  const [pinned, setPinned] = useState(() => flagIsOn(agent?.pinned_comment));
  const [watch, setWatch] = useState(() => flagIsOn(agent?.watch_next));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /** Reads the live config, lets `change` produce the next one, writes it. Returns whether it was written. */
  async function write(change: (live: Record<string, unknown>) => Record<string, unknown>): Promise<boolean> {
    const supabase = createClient();
    if (!supabase) return false;
    setBusy(true);
    setNotice(null);
    const { data: current, error: readErr } = await supabase
      .from("channels")
      .select("agent_config")
      .eq("channel_id", channelId)
      .maybeSingle();
    if (readErr) {
      setBusy(false);
      setNotice({ kind: "failed", detail: readErr.message });
      return false;
    }
    const merged = change((current?.agent_config as Record<string, unknown> | null) ?? {});
    const { error } = await supabase
      .from("channels")
      .update({ agent_config: merged, updated_at: new Date().toISOString() })
      .eq("channel_id", channelId);
    setBusy(false);
    if (error) {
      setNotice({ kind: "failed", detail: error.message });
      return false;
    }
    setNotice({ kind: "saved" });
    startTransition(() => router.refresh());
    return true;
  }

  async function saveCeiling(raw: string) {
    if (busy || !canEdit) return;
    const parsed = parseSpendCeiling(raw);
    if (!parsed.ok) {
      setProblem(
        parsed.reason === "not_positive"
          ? r.ceilingNotPositive
          : parsed.reason === "too_large"
            ? fmt(r.ceilingTooLarge, { max: MAX_SPEND_CEILING_USD.toLocaleString("en-US") })
            : r.ceilingInvalid,
      );
      return;
    }
    setProblem(null);
    if (await write((live) => withSpendCeiling(live, parsed.value))) {
      setCeiling(parsed.value);
      setTyped(parsed.value === null ? "" : String(parsed.value));
    }
  }

  async function toggle(key: "pinned_comment" | "watch_next") {
    if (busy || !canEdit) return;
    const next = !(key === "pinned_comment" ? pinned : watch);
    if (await write((live) => ({ ...live, [key]: next }))) {
      if (key === "pinned_comment") setPinned(next);
      else setWatch(next);
    }
  }

  const disabled = busy || pending || !canEdit;
  const noAccess = canEdit ? undefined : r.noAccess;
  const ceilingId = `${uid}-ceiling`;

  return (
    <div className="g2-sub-block" aria-labelledby={`${uid}-title`}>
      <div className="g2-sub-head">
        <h3 id={`${uid}-title`} className="g2-label">
          {r.title}
        </h3>
      </div>

      <form
        className="flex flex-col gap-1.5 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          void saveCeiling(typed);
        }}
      >
        <label htmlFor={ceilingId} className="g2-strong">
          {r.ceilingLabel}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id={ceilingId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={typed}
            placeholder={r.ceilingPlaceholder}
            disabled={disabled}
            title={noAccess}
            onChange={(e) => {
              setTyped(e.target.value);
              setProblem(null);
            }}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${ceilingId}-hint`}
            className="ns-field tnum w-40"
          />
          <button type="submit" disabled={disabled} title={noAccess} className="btn-quiet disabled:opacity-50">
            {r.ceilingSave}
          </button>
          {ceiling !== null && (
            <button
              type="button"
              disabled={disabled}
              title={noAccess}
              onClick={() => void saveCeiling("")}
              className="btn-quiet disabled:opacity-50"
            >
              {r.ceilingRemove}
            </button>
          )}
        </div>
        <span id={`${ceilingId}-hint`} className="g2-note">
          {r.ceilingHint}
        </span>
        <span className="g2-note tnum">
          {ceiling === null ? r.ceilingNone : fmt(r.ceilingNow, { amount: ceiling })}
        </span>
        {problem && (
          <p className="g2-fail" role="alert">
            {problem}
          </p>
        )}
      </form>

      <Switch
        id={`${uid}-pinned`}
        label={r.pinnedLabel}
        hint={pinned ? r.pinnedOnHint : r.pinnedOffHint}
        on={pinned}
        word={pinned ? r.on : r.off}
        onClick={() => void toggle("pinned_comment")}
        disabled={disabled}
        title={noAccess}
      />
      <Switch
        id={`${uid}-watch`}
        label={r.watchLabel}
        hint={watch ? r.watchOnHint : r.watchOffHint}
        on={watch}
        word={watch ? r.on : r.off}
        onClick={() => void toggle("watch_next")}
        disabled={disabled}
        title={noAccess}
      />

      <div className="pt-2" role="status" aria-live="polite">
        {busy && <span className="g2-note">{r.saving}</span>}
        {!busy && notice?.kind === "saved" && <span className="g2-ok">{r.saved}</span>}
      </div>
      {notice?.kind === "failed" && (
        <p className="g2-fail tnum" role="alert">
          {r.saveFailed} {notice.detail}
        </p>
      )}
    </div>
  );
}

function Switch({
  id,
  label,
  hint,
  on,
  word,
  onClick,
  disabled,
  title,
}: {
  id: string;
  label: string;
  hint: string;
  on: boolean;
  word: string;
  onClick: () => void;
  disabled: boolean;
  title?: string;
}) {
  return (
    <div className="g2-switchrow">
      <div className="min-w-0 flex-1" style={{ flexBasis: "16rem" }}>
        <div id={`${id}-label`} className="g2-strong">
          {label}
        </div>
        <p className="g2-note mt-1">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-word`}
        onClick={onClick}
        disabled={disabled}
        title={title}
        className="g2-switch"
      >
        <span aria-hidden className="g2-switch-track">
          <span className="g2-switch-thumb" />
        </span>
        <span id={`${id}-word`} className="g2-switch-word">
          {word}
        </span>
      </button>
    </div>
  );
}
