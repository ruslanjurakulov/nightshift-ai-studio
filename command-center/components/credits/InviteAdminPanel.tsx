"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { coerceInviteAdmin, dailyExposure, parseInviteSettings, type InviteAdmin } from "@/lib/friend-invites";

/**
 * The operator's side of Invite friends (migration 0092): the switch (off until
 * the operator turns it on), the numbers, the worst case one day can pay, and
 * counts. Saved by set_friend_invite_settings(), which refuses anyone but a
 * platform owner/admin — this panel is only offered to them, and hiding it was
 * never the protection.
 */
export function InviteAdminPanel({ admin }: { admin: InviteAdmin }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const c = t.invite;
  const [state, setState] = useState(admin);
  const [enabled, setEnabled] = useState(admin.enabled);
  const [required, setRequired] = useState(String(admin.requiredJoins));
  const [reward, setReward] = useState(String(admin.rewardCredits));
  const [dailyCap, setDailyCap] = useState(String(admin.dailyRewardCap));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const parsed = parseInviteSettings({ required, reward, dailyCap });
  const exposure = parsed ? parsed.dailyCap * parsed.reward : dailyExposure(state);

  async function save() {
    const supabase = createClient();
    if (!supabase || busy) return;
    if (!parsed) {
      setMsg({ ok: false, text: c.adminSaveFailed });
      return;
    }
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.rpc("set_friend_invite_settings", {
      p_enabled: enabled,
      p_required_joins: parsed.required,
      p_reward_credits: parsed.reward,
      p_daily_reward_cap: parsed.dailyCap,
      p_link_hourly_cap: null,
    });
    setBusy(false);
    const next = error ? null : coerceInviteAdmin(data);
    if (!next) {
      setMsg({ ok: false, text: c.adminSaveFailed });
      return;
    }
    setState(next);
    setMsg({ ok: true, text: c.adminSaved });
    router.refresh();
  }

  const inputClass =
    "min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]";
  const count = (label: string, value: number | string) => (
    <div className="flex flex-col gap-0.5 rounded-lg border border-[var(--color-border)] p-3">
      <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
      <dd className="tnum text-base text-[var(--color-fg)]">{value}</dd>
    </div>
  );

  return (
    <section className="panel flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="invite-admin-title" data-invite-admin>
      <h2 id="invite-admin-title" className="t-section">
        {c.adminTitle}
      </h2>
      <p className="max-w-[64ch] text-xs leading-relaxed text-[var(--color-muted)]">{c.adminHint}</p>

      <label className="flex min-h-11 items-center gap-3 text-sm text-[var(--color-fg)]">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-6 accent-[var(--ns-amber)]" />
        <span>
          {c.adminSwitch}: <strong>{enabled ? c.adminOn : c.adminOff}</strong>
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          {c.adminRequired}
          <input inputMode="numeric" value={required} onChange={(e) => setRequired(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          {c.adminReward}
          <input inputMode="decimal" value={reward} onChange={(e) => setReward(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          {c.adminDailyCap}
          <input inputMode="numeric" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} className={inputClass} />
        </label>
      </div>

      <p className="text-xs text-[var(--color-muted)]" data-invite-exposure>
        {fmt(c.adminExposure, {
          n: formatCredits(exposure, locale),
          cap: parsed ? parsed.dailyCap : state.dailyRewardCap,
          reward: formatCredits(parsed ? parsed.reward : state.rewardCredits, locale),
        })}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={busy} className="btn-primary min-h-11 px-5 text-sm disabled:opacity-40">
          {busy ? c.adminSaving : c.adminSave}
        </button>
        {msg && (
          <p role="status" className="text-xs" style={{ color: msg.ok ? "var(--color-ok)" : "var(--color-fail)" }}>
            {msg.text}
          </p>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {count(c.adminLinks, state.links)}
        {count(c.adminJoins, state.joins)}
        {count(c.adminRewards, state.rewards)}
        {count(c.adminCreditsToday, formatCredits(state.creditsToday, locale))}
        {count(c.adminWaiting, state.pending)}
      </dl>
      <p className="text-xs text-[var(--color-muted)]">{fmt(c.adminToday, { n: state.rewardsToday, cap: state.dailyRewardCap })}</p>
    </section>
  );
}
