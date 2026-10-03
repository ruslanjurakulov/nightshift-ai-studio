"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Coins } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { formatCredits } from "@/lib/credits";
import {
  formatPercent,
  planAllowance,
  relativeUntil,
  usageLimits,
  USAGE_LINKS,
  type FreeGap,
  type PlanAllowance,
  type UsageSummary,
} from "@/lib/usage";
import { Chip } from "@/components/ui/Chip";
import { Meter } from "@/components/ui/Meter";
import { Timecode } from "@/components/ui/Timecode";
import { entitlementText } from "@/components/pricing/PlanMatrix";
import { pluralForm } from "@/components/credits/Equivalents";
import { useDay } from "@/components/usage/useDay";

/**
 * The Usage page: how much of the plan's credits this billing period has been
 * used, the plan's other real limits, and the extra-credits switch with the
 * balance behind it. Every figure is the workspace's own, read through
 * usage_summary() (migration 0094); a state the data does not support is
 * written as that state (expired, not yet added, Free), never as 0% or a
 * made-up meter. There are no weekly or per-session meters: the platform has
 * none.
 *
 * Nothing here spends or buys: "Buy credits" and "Upgrade plan" are links to
 * the Credits page, where the terms and the price are on screen before any
 * checkout. The one write is the switch, through set_use_extra_credits(),
 * which the database only allows the person who runs the workspace.
 */
export function UsageView({
  summary,
  nowMs,
  orgId,
  canChange,
  canBuy,
  canUpgrade,
  gaps,
}: {
  summary: UsageSummary;
  /** The server's clock, so server and browser agree on "in 21 days". */
  nowMs: number;
  orgId: string;
  /** The person who runs this workspace (the database re-checks). */
  canChange: boolean;
  /** The Credits page offers top-up packs here. */
  canBuy: boolean;
  /** A plan above this one is on the Credits page's plan cards, and this workspace is out of room (or on Free). */
  canUpgrade: boolean;
  /** What Free does not include, from the price list. */
  gaps: FreeGap[];
}) {
  const allowance = planAllowance(summary);
  const limits = usageLimits(summary);
  const showLimits = limits.runs !== null || limits.priority !== null || limits.api !== null;
  return (
    <div className="flex max-w-[44rem] flex-col gap-4">
      {allowance.kind === "free" ? (
        <FreePlan summary={summary} gaps={gaps} canUpgrade={canUpgrade} />
      ) : (
        <PlanCredits summary={summary} allowance={allowance} nowMs={nowMs} />
      )}
      {showLimits && allowance.kind !== "free" && <PlanLimits summary={summary} />}
      <ExtraCredits
        summary={summary}
        orgId={orgId}
        canChange={canChange}
        canBuy={canBuy}
        canUpgrade={canUpgrade && allowance.kind !== "free"}
      />
    </div>
  );
}

/** A "{n} …" sentence with its figure in the counter face; {unit} is the credit word for that number. */
function withFigure(template: string, n: number, locale: string, unit: string) {
  const [before, after = ""] = template.replace("{unit}", unit).split("{n}");
  return (
    <>
      {before}
      <span className="t-figure">
        <Timecode value={n} locale={locale} />
      </span>
      {after}
    </>
  );
}

function unitOf(n: number, locale: string, forms: Parameters<typeof pluralForm>[0]): string {
  return pluralForm(forms, n, locale);
}

// ── plan credits ─────────────────────────────────────────────────────────────

function PlanCredits({ summary, allowance, nowMs }: { summary: UsageSummary; allowance: PlanAllowance; nowMs: number }) {
  const { t, locale } = useI18n();
  const u = t.usage;
  const forms = t.shell.creditUnit;
  const titleId = useId();
  const day = useDay();
  const planName = summary.plan?.name ?? t.common.unknown;
  const status = summary.subscription ? t.plans.status[summary.subscription.status] : null;

  return (
    <section id="plan" className="panel flex scroll-mt-24 flex-col gap-5 p-5 sm:p-6" aria-labelledby={titleId}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 id={titleId} className="t-section">
            {u.plan.title}
          </h2>
          <p className="text-[14px] font-light text-[var(--color-muted)]">{u.plan.lead}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Chip plain tone="lit">
            {planName}
          </Chip>
          {status && summary.subscription?.status !== "active" && (
            <Chip plain tone={summary.subscription?.status === "past_due" ? "warn" : undefined}>
              {status}
            </Chip>
          )}
        </div>
      </div>

      {allowance.kind === "period" && <Period summary={summary} allowance={allowance} nowMs={nowMs} />}

      {allowance.kind === "ended" && (
        <p className="text-[14px] leading-relaxed" role="status">
          {fmt(u.plan.ended, { date: day(allowance.endedAt) })}
        </p>
      )}
      {allowance.kind === "none" && (
        <p className="text-[14px] leading-relaxed" role="status">
          {u.plan.none}
        </p>
      )}

      {summary.bonus.available > 0 && (
        <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">
          {fmt(u.plan.bonus, {
            n: formatCredits(summary.bonus.available, locale),
            unit: unitOf(summary.bonus.available, locale, forms),
          })}
        </p>
      )}
    </section>
  );
}

function Period({
  summary,
  allowance,
  nowMs,
}: {
  summary: UsageSummary;
  allowance: Extract<PlanAllowance, { kind: "period" }>;
  nowMs: number;
}) {
  const { t, locale } = useI18n();
  const u = t.usage;
  const forms = t.shell.creditUnit;
  const day = useDay();
  const pct = formatPercent(allowance.percent, locale);
  const used = formatCredits(allowance.spent, locale);
  const total = formatCredits(allowance.granted, locale);
  const heldN = allowance.held;
  const rel = relativeUntil(allowance.periodEnd, nowMs, locale);
  const date = allowance.periodEnd ? day(allowance.periodEnd) : null;
  const when = date ? `${fmt(allowance.ends ? u.plan.ends : u.plan.renews, { date })}${rel ? ` · ${rel}` : ""}` : null;
  const outOfPlan = allowance.left <= 0;
  const [before, after = ""] = u.plan.usedPercent.split("{pct}");

  // What happens now that the period's credits are gone: said plainly, with the
  // switch's consequence, never a bar alone.
  let ranOut: string | null = null;
  if (outOfPlan) {
    const extra = summary.extra.available > 0;
    if (summary.spendableNow > 0) ranOut = `${u.plan.usedUp} ${summary.extraEnabled && extra ? u.plan.usedUpOn : ""}`.trim();
    else ranOut = `${u.plan.usedUp} ${summary.extraEnabled || !extra ? u.plan.usedUpNone : u.plan.usedUpOff}`;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <p className="flex flex-wrap items-baseline gap-x-2" data-plan-used>
          <span className="t-figure" style={{ color: outOfPlan ? "var(--color-warn)" : "var(--color-fg)" }}>
            {before}
            <span className="ns-tc">{pct}</span>
            {after}
          </span>
        </p>
        {/* The period's credits as a ladder: lit = used, hatched = on hold for runs
            in progress, outlined = left. Drawn from the real figures only. */}
        <Meter
          className="usage-meter"
          value={allowance.spent}
          held={allowance.held}
          max={allowance.granted}
          segments={20}
          size="lg"
          label={u.plan.meterLabel}
          valueText={`${fmt(u.plan.usedPercent, { pct })}: ${fmt(u.plan.usedOf, { used, total, unit: unitOf(allowance.granted, locale, forms) })}`}
        />
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[13px]">
          <span>
            <Timecode value={allowance.spent} locale={locale} /> / <Timecode value={allowance.granted} locale={locale} />{" "}
            <span className="text-[var(--color-muted)]">{unitOf(allowance.granted, locale, forms)}</span>
          </span>
          <span className="text-[var(--color-muted)]">
            {fmt(u.plan.left, { n: formatCredits(allowance.left, locale), unit: unitOf(allowance.left, locale, forms) })}
          </span>
        </div>
      </div>

      {ranOut && (
        <div role="status" className="flex flex-col items-start gap-1 rounded-[var(--ns-r-key)] border border-[var(--color-warn)] p-3 text-[13px] leading-relaxed" data-plan-ran-out>
          <p>{ranOut}</p>
          {!summary.extraEnabled && summary.extra.available > 0 && (
            <a href="#extra" className="tap-link text-[var(--color-primary)] underline underline-offset-2">
              {u.refusal.turnOn}
            </a>
          )}
        </div>
      )}

      {heldN > 0 && (
        <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">
          {fmt(u.plan.held, { n: formatCredits(heldN, locale), unit: unitOf(heldN, locale, forms) })}
        </p>
      )}

      {when && (
        <div className="flex flex-col gap-0.5 border-t border-[var(--color-border)] pt-3">
          <p className="text-[14px]" data-plan-when>
            {when}
          </p>
          <p className="text-[12px] text-[var(--color-muted)]">{u.plan.carry}</p>
        </div>
      )}
    </div>
  );
}

// ── the plan's other limits ──────────────────────────────────────────────────

function PlanLimits({ summary }: { summary: UsageSummary }) {
  const { t } = useI18n();
  const u = t.usage;
  const limits = usageLimits(summary);
  const titleId = useId();
  return (
    <section id="limits" className="panel flex scroll-mt-24 flex-col gap-4 p-5 sm:p-6" aria-labelledby={titleId}>
      <h2 id={titleId} className="t-section">
        {u.limits.title}
      </h2>
      <ul className="flex flex-col">
        {limits.runs && (
          <li className="flex flex-col gap-2 border-t border-[var(--color-border)] py-3 first:border-t-0 first:pt-0">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-[14px]">{u.limits.runs}</span>
              <span className="text-[14px] font-medium" data-runs-now>
                {fmt(u.limits.runsNow, { active: limits.runs.active, limit: limits.runs.limit })}
              </span>
            </div>
            {/* One cell per run the plan starts at once, each a fixed width: a plan of 2 is two cells, not two
                slabs across the page. */}
            <div style={{ maxWidth: `${Math.max(1, Math.min(limits.runs.limit, 12)) * 44}px` }}>
              <Meter
                className="usage-meter"
                value={Math.min(limits.runs.active, limits.runs.limit)}
                max={limits.runs.limit}
                segments={Math.max(1, Math.min(limits.runs.limit, 12))}
                size="lg"
                label={u.limits.meterLabel}
                valueText={fmt(u.limits.runsNow, { active: limits.runs.active, limit: limits.runs.limit })}
              />
            </div>
            <p className="text-[12px] leading-relaxed text-[var(--color-muted)]">{u.limits.runsHint}</p>
          </li>
        )}
        {limits.priority !== null && (
          <li className="flex items-baseline justify-between gap-4 border-t border-[var(--color-border)] py-3 first:border-t-0 first:pt-0">
            <span className="text-[14px]">{u.limits.priority}</span>
            <span className="text-[14px] font-medium">{entitlementText("queue_priority", "int", limits.priority, t)}</span>
          </li>
        )}
        {limits.api !== null && (
          <li className="flex items-baseline justify-between gap-4 border-t border-[var(--color-border)] py-3 first:border-t-0 first:pt-0">
            <span className="text-[14px]">{u.limits.api}</span>
            <span className="text-[14px] font-medium">{entitlementText("api_access", "bool", limits.api, t)}</span>
          </li>
        )}
      </ul>
    </section>
  );
}

// ── the Free plan ────────────────────────────────────────────────────────────

function FreePlan({ summary, gaps, canUpgrade }: { summary: UsageSummary; gaps: FreeGap[]; canUpgrade: boolean }) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  const u = t.usage;
  const titleId = useId();
  const left = summary.bonus.available;
  const gapText = (g: FreeGap): string => {
    const label = u.free.gap[g.key];
    return g.key === "concurrency" ? fmt(label, { free: g.free ?? "", best: g.best ?? "" }) : label;
  };
  return (
    <section id="plan" className="panel flex scroll-mt-24 flex-col gap-5 p-5 sm:p-6" aria-labelledby={titleId}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 id={titleId} className="t-section">
            {u.free.title}
          </h2>
          <p className="text-[14px] font-light text-[var(--color-muted)]">{u.free.lead}</p>
        </div>
        <Chip plain tone="lit" className="shrink-0">
          {summary.plan?.name ?? t.common.unknown}
        </Chip>
      </div>
      <div className="flex flex-col gap-1">
        {left > 0 ? (
          <p className="flex flex-wrap items-baseline gap-x-1.5 text-[15px]" data-free-left>
            {withFigure(u.free.left, left, locale, unitOf(left, locale, t.shell.creditUnit))}
          </p>
        ) : (
          <p className="text-[14px]" role="status">
            {u.free.leftNone}
          </p>
        )}
      </div>
      {gaps.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-[13px] font-medium">{u.free.notIncluded}</h3>
          <ul className="flex flex-col gap-1.5 text-[13px] text-[var(--color-muted)]">
            {gaps.map((g) => (
              <li key={g.key} className="flex items-start gap-2">
                <span aria-hidden className="mt-[7px] block size-1.5 shrink-0 rounded-[1px] bg-[var(--color-muted)]" />
                <span>{gapText(g)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {canUpgrade && (
        <Link href={path(USAGE_LINKS.upgrade)} className="btn-primary self-start text-[13px]">
          {u.free.upgrade}
          <ArrowUpRight className="size-3.5" aria-hidden />
        </Link>
      )}
    </section>
  );
}

// ── extra credits ────────────────────────────────────────────────────────────

function ExtraCredits({
  summary,
  orgId,
  canChange,
  canBuy,
  canUpgrade,
}: {
  summary: UsageSummary;
  orgId: string;
  canChange: boolean;
  canBuy: boolean;
  canUpgrade: boolean;
}) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  const router = useRouter();
  const u = t.usage;
  const forms = t.shell.creditUnit;
  const titleId = useId();
  const labelId = useId();
  const hintId = useId();
  const [on, setOn] = useState(summary.extraEnabled);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // A refresh brings the saved value back: the page is the database's, not ours.
  useEffect(() => setOn(summary.extraEnabled), [summary.extraEnabled]);

  async function flip() {
    const supabase = createClient();
    if (!supabase || busy || !canChange) return;
    const next = !on;
    setBusy(true);
    setFailed(false);
    setOn(next);
    const { data, error } = await supabase.rpc("set_use_extra_credits", { p_org: orgId, p_on: next });
    const saved = !error && data && typeof data === "object" && (data as Record<string, unknown>).use_extra_credits === next;
    setBusy(false);
    if (!saved) {
      setOn(!next);
      setFailed(true);
      return;
    }
    router.refresh();
  }

  const day = useDay();
  const extra = summary.extra.available;
  const spendable = summary.spendableNow;
  const expiry = summary.extra.soonestExpiry ? fmt(u.extra.expires, { date: day(summary.extra.soonestExpiry) }) : null;
  return (
    <section id="extra" className="panel flex scroll-mt-24 flex-col gap-5 p-5 sm:p-6" aria-labelledby={titleId}>
      <div className="flex flex-col gap-1.5">
        <h2 id={titleId} className="t-section">
          {u.extra.title}
        </h2>
        <p className="text-[14px] font-light text-[var(--color-muted)]">{u.extra.lead}</p>
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          onClick={flip}
          // Not `disabled` while saving: a disabled button drops keyboard focus, and the person is left
          // at the top of the page. flip() ignores a second press until the first has been saved.
          disabled={!canChange}
          aria-busy={busy || undefined}
          className="usage-switch"
          data-on={on ? "true" : "false"}
        >
          <span id={labelId} className="min-w-0 text-left text-[15px] font-medium leading-snug">
            {u.extra.toggleLabel}
          </span>
          <span aria-hidden className="usage-switch-key">
            <span className="usage-switch-lamp" />
            <span>{busy ? u.extra.saving : on ? u.extra.on : u.extra.off}</span>
          </span>
        </button>
        <p id={hintId} className="text-[13px] leading-relaxed text-[var(--color-muted)]">
          {u.extra.toggleHint}
        </p>
        {!canChange && <p className="text-[12px] text-[var(--color-muted)]">{u.extra.adminOnly}</p>}
        <p role="alert" className="text-[13px] text-[var(--color-fail)]" hidden={!failed}>
          {failed ? u.extra.saveFailed : null}
        </p>
      </div>

      <dl className="flex flex-col gap-1 rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-4">
        <dt className="text-[12px] text-[var(--color-muted)]">{u.extra.balance}</dt>
        <dd className="flex flex-wrap items-baseline gap-x-2">
          <span className="t-figure" data-extra-balance>
            <Timecode value={extra} locale={locale} />
          </span>
          <span className="text-[14px] text-[var(--color-muted)]">{unitOf(extra, locale, forms)}</span>
        </dd>
        {extra > 0 && <dd className="text-[12px] text-[var(--color-muted)]">{expiry ?? u.extra.noExpiry}</dd>}
        {extra <= 0 && <dd className="text-[13px] text-[var(--color-muted)]">{u.extra.none}</dd>}
        {extra > 0 && !on && <dd className="text-[13px]">{u.extra.waitingOff}</dd>}
      </dl>

      <p className="text-[13px] text-[var(--color-muted)]" data-spendable>
        {fmt(u.extra.spendable, { n: formatCredits(spendable, locale), unit: unitOf(spendable, locale, forms) })}
      </p>

      {(canBuy || canUpgrade) && (
        <div className="flex flex-wrap gap-2">
          {canBuy && (
            <Link href={path(USAGE_LINKS.buy)} className="btn-primary text-[13px]">
              <Coins className="size-3.5" aria-hidden />
              {u.extra.buy}
            </Link>
          )}
          {canUpgrade && (
            <Link href={path(USAGE_LINKS.upgrade)} className={`${canBuy ? "btn-quiet" : "btn-primary"} text-[13px]`}>
              {u.extra.upgrade}
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
