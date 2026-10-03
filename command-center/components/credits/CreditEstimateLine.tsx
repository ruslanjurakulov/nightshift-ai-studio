"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { formatCredits, type CreditEstimate } from "@/lib/credits";
import { ErrorState } from "@/components/ReadError";
import { ExtraOffLink } from "@/components/usage/ExtraOffLink";

type EstimateResponse = {
  supported?: boolean;
  enforced?: boolean;
  exempt?: boolean;
  estimate?: CreditEstimate | null;
  available?: number | null;
  /** The balance read errored: `available` is unknown, not 0 and not "no account". */
  balanceFailed?: boolean;
  /** 0094: extra credits are off, so a run can use only `spendable` (plan and bonus credits). */
  extraOff?: boolean;
  spendable?: number;
};

/**
 * What this run is estimated to cost, shown before Run now is pressed — the
 * same estimate the run route reserves (/api/credits/estimate). Renders
 * nothing before migration 0020, and says "no charge" for the operator's own,
 * exempt organization. An estimate that cannot be made says why instead of
 * showing a number. A read that FAILED (a 5xx or no answer) is not any of
 * those: it shows the read-error state with Retry, never a hidden line, a
 * "price gap" or a number; an unreadable balance reads "unknown" with Retry.
 */
export function CreditEstimateLine({ channelId, durationS }: { channelId: string | null; durationS: number | null }) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  const [data, setData] = useState<EstimateResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt((n) => n + 1);

  useEffect(() => {
    if (!channelId) return;
    let live = true;
    setFailed(false);
    const qs = new URLSearchParams({ channel: channelId });
    if (durationS && durationS > 0) qs.set("duration", String(Math.round(durationS)));
    fetch(`/api/credits/estimate?${qs}`, { cache: "no-store" })
      .then(async (r) => {
        // 4xx (unauthorized, channel not found…) keeps hiding the line; a 5xx is a failed read.
        if (r.status >= 500) return "failed" as const;
        return r.ok ? ((await r.json()) as EstimateResponse) : null;
      })
      .then((d) => {
        if (!live) return;
        setFailed(d === "failed");
        setData(d === "failed" ? null : d);
      })
      .catch(() => {
        if (!live) return;
        setFailed(true);
        setData(null);
      });
    return () => {
      live = false;
    };
  }, [channelId, durationS, attempt]);

  if (channelId && failed) {
    return (
      <div className="text-[11px]" aria-live="polite">
        <ErrorState compact message={t.credits.estimateReadFailed} onRetry={retry} />
      </div>
    );
  }
  if (!channelId || !data?.supported) return null;

  let body: React.ReactNode;
  if (data.exempt) {
    body = <span className="text-[var(--color-muted)]">{t.credits.estimateExempt}</span>;
  } else if (!data.estimate || data.estimate.credits === null) {
    const gap = data.estimate?.gap ? t.credits.gap[data.estimate.gap] : "";
    body = <span className="text-[var(--color-warn)]">{gap || t.credits.estimateUnavailable}</span>;
  } else {
    const e = data.estimate;
    const credits = e.credits ?? 0;
    // With extra credits off, what a run can use is the spendable part of the balance.
    const usable = data.extraOff && typeof data.spendable === "number" ? Math.min(data.spendable, data.available ?? data.spendable) : data.available;
    const short = data.enforced && usable !== null && usable !== undefined && usable < credits;
    const basis = e.basis === "unknown" ? "" : fmt(t.credits.basis[e.basis], { n: e.sample });
    body = (
      <>
        <span style={{ color: short ? "var(--color-fail)" : "var(--color-fg)" }}>
          {fmt(t.credits.estimateCredits, { n: formatCredits(credits, locale) })}
        </span>
        {basis && <span className="text-[var(--color-muted)]"> · {basis}</span>}
        {e.floorApplied && <span className="text-[var(--color-muted)]"> · {t.credits.floorApplied}</span>}
        {data.balanceFailed ? (
          <span className="text-[var(--color-warn)]" data-balance-unknown>
            {" "}
            · {t.credits.availableUnknown}{" "}
            <button type="button" onClick={retry} className="tap-link text-[var(--color-primary)] hover:underline">
              {t.common.retry}
            </button>
          </span>
        ) : (
          usable !== null &&
          usable !== undefined && (
            <span className="text-[var(--color-muted)]">
              {" "}
              · {fmt(data.extraOff ? t.usage.estimate.availableOff : t.credits.estimateAvailable, { n: formatCredits(usable, locale) })}
              {data.extraOff && short && (
                <>
                  {" "}
                  <ExtraOffLink />
                </>
              )}
            </span>
          )
        )}
        {!data.enforced && <span className="text-[var(--color-muted)]"> · {t.credits.estimateNotEnforced}</span>}
      </>
    );
  }

  return (
    <p className="mono flex flex-wrap items-center gap-x-1 text-[11px]" aria-live="polite">
      <span className="text-[var(--color-muted)]">{t.credits.estimateLabel}:</span> {body}
      {!data.exempt && (
        <Link href={path("/credits")} className="tap-link ml-2 text-[var(--color-primary)] hover:underline">
          {t.credits.openCredits}
        </Link>
      )}
    </p>
  );
}
