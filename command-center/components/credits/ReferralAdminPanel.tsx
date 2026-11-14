"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { coerceReferralAdmin, ownerRefusal, parseReferralSettings, type ReferralAdmin } from "@/lib/referrals";

/** YYYY-MM-DD HH:MM UTC: the same text on the server and in the browser. */
function utcStamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The operator's side of the referral programme (migration 0165): the reward's own switch (off until the operator turns it
 * on), 0092's old sign-up reward as a switch of its own, the numbers, the worst case one day can pay, whether the settle job
 * is scheduled and how its last run went, and platform-wide counts. Saved by set_referral_settings(), which goes through
 * owner_guard (the second factor when the gate is on, a rate limit) and writes the audit trail — this panel is only offered to
 * a platform owner/admin, and hiding it was never the protection.
 */
export function ReferralAdminPanel({ admin }: { admin: ReferralAdmin }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const c = t.referral;
  const [state, setState] = useState(admin);
  const [enabled, setEnabled] = useState(admin.enabled);
  const [milestone, setMilestone] = useState(admin.milestoneEnabled);
  const [form, setForm] = useState({
    credits: String(admin.credits),
    minCredits: String(admin.minCredits),
    holdDays: String(admin.holdDays),
    qualifyDays: String(admin.qualifyDays),
    monthlyCap: String(admin.monthlyCap),
    dailyCap: String(admin.dailyCap),
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const parsed = parseReferralSettings(form);
  const cap = parsed ? parsed.dailyCap : state.dailyCap;
  const each = parsed ? parsed.credits : state.credits;

  async function save() {
    const supabase = createClient();
    if (!supabase || busy) return;
    if (!parsed) {
      setMsg({ ok: false, text: c.adminSaveFailed });
      return;
    }
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.rpc("set_referral_settings", {
      p_enabled: enabled,
      p_milestone_enabled: milestone,
      p_credits: parsed.credits,
      p_min_credits: parsed.minCredits,
      p_hold_days: parsed.holdDays,
      p_qualify_days: parsed.qualifyDays,
      p_monthly_cap: parsed.monthlyCap,
      p_daily_cap: parsed.dailyCap,
    });
    setBusy(false);
    const refusal = error ? null : ownerRefusal(data);
    if (refusal) {
      setMsg({ ok: false, text: refusal === "mfa_required" ? c.adminMfa : refusal === "rate_limited" ? c.adminRateLimited : c.adminSaveFailed });
      return;
    }
    const next = error ? null : coerceReferralAdmin(data);
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
  const field = (key: keyof typeof form, label: string, mode: "numeric" | "decimal") => (
    <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
      {label}
      <input inputMode={mode} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} className={inputClass} />
    </label>
  );
  const count = (label: string, value: number | string) => (
    <div className="flex flex-col gap-0.5 rounded-lg border border-[var(--color-border)] p-3">
      <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
      <dd className="tnum text-base text-[var(--color-fg)]">{value}</dd>
    </div>
  );
  const run = state.lastRun;

  return (
    <section className="panel flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="referral-admin-title" data-referral-admin>
      <h2 id="referral-admin-title" className="t-section">
        {c.adminTitle}
      </h2>
      <p className="max-w-[64ch] text-xs leading-relaxed text-[var(--color-muted)]">{c.adminHint}</p>

      {!state.schedule && (
        <p role="alert" className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--color-fail)", color: "var(--color-fail)" }} data-referral-no-schedule>
          {c.adminNoSchedule}
        </p>
      )}
      <p className="text-xs text-[var(--color-muted)]" data-referral-last-run>
        {run
          ? fmt(run.failed > 0 ? c.adminLastRunFailed : c.adminLastRun, { at: utcStamp(run.at), links: run.links, failed: run.failed })
          : c.adminNoRun}{" "}
        {state.runsFailed24h > 0 && <span style={{ color: "var(--color-fail)" }}>{fmt(c.adminRunsFailed, { n: state.runsFailed24h })}</span>}
      </p>

      <label className="flex min-h-11 items-center gap-3 text-sm text-[var(--color-fg)]">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-6 accent-[var(--ns-amber)]" />
        <span>
          {c.adminSwitch}: <strong>{enabled ? c.adminOn : c.adminOff}</strong>
        </span>
      </label>
      <label className="flex min-h-11 items-center gap-3 text-sm text-[var(--color-fg)]">
        <input type="checkbox" checked={milestone} onChange={(e) => setMilestone(e.target.checked)} className="size-6 shrink-0 accent-[var(--ns-amber)]" />
        <span>{c.adminMilestone}</span>
      </label>

      <div className="grid gap-3 sm:grid-cols-3">
        {field("credits", c.adminCredits, "decimal")}
        {field("minCredits", c.adminMin, "decimal")}
        {field("holdDays", c.adminHold, "numeric")}
        {field("qualifyDays", c.adminQualify, "numeric")}
        {field("monthlyCap", c.adminMonthly, "numeric")}
        {field("dailyCap", c.adminDaily, "numeric")}
      </div>

      <p className="text-xs text-[var(--color-muted)]" data-referral-exposure>
        {fmt(c.adminExposure, { n: formatCredits(cap * each, locale), cap, credits: formatCredits(each, locale) })}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={busy} className="btn-quiet min-h-11 px-5 text-sm disabled:opacity-40">
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
        {count(c.adminHeld, state.held)}
        {count(c.adminDue, state.due)}
        {count(c.adminPaid, state.paid)}
        {count(c.adminPaidToday, `${state.paidToday} / ${state.dailyCap}`)}
        {count(c.adminCreditsMonth, formatCredits(state.creditsMonth, locale))}
        {count(c.adminVoid, state.voidRefunded + state.voidSamePayer + state.voidMember)}
        {count(c.adminClawed, state.clawed)}
        {count(c.adminOwed, formatCredits(state.clawOwed, locale))}
      </dl>
      {state.reversedByEvent > 0 && (
        <p role="alert" className="text-xs" style={{ color: "var(--color-fail)" }} data-referral-by-event>
          {fmt(c.adminByEvent, { n: state.reversedByEvent })}
        </p>
      )}
    </section>
  );
}
