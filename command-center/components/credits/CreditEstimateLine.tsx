"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { formatCredits, type CreditEstimate } from "@/lib/credits";

type EstimateResponse = {
  supported?: boolean;
  enforced?: boolean;
  exempt?: boolean;
  estimate?: CreditEstimate | null;
  available?: number | null;
};

/**
 * What this run is estimated to cost, shown before Run now is pressed — the
 * same estimate the run route reserves (/api/credits/estimate). Renders
 * nothing before migration 0020, and says "no charge" for the operator's own,
 * exempt organization. An estimate that cannot be made says why instead of
 * showing a number.
 */
export function CreditEstimateLine({ channelId, durationS }: { channelId: string | null; durationS: number | null }) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  const [data, setData] = useState<EstimateResponse | null>(null);

  useEffect(() => {
    if (!channelId) return;
    let live = true;
    const qs = new URLSearchParams({ channel: channelId });
    if (durationS && durationS > 0) qs.set("duration", String(Math.round(durationS)));
    fetch(`/api/credits/estimate?${qs}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live) setData(d);
      })
      .catch(() => {
        if (live) setData(null);
      });
    return () => {
      live = false;
    };
  }, [channelId, durationS]);

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
    const short = data.enforced && data.available !== null && data.available !== undefined && data.available < credits;
    const basis = e.basis === "unknown" ? "" : fmt(t.credits.basis[e.basis], { n: e.sample });
    body = (
      <>
        <span style={{ color: short ? "var(--color-fail)" : "var(--color-fg)" }}>
          {fmt(t.credits.estimateCredits, { n: formatCredits(credits, locale) })}
        </span>
        {basis && <span className="text-[var(--color-muted)]"> · {basis}</span>}
        {e.floorApplied && <span className="text-[var(--color-muted)]"> · {t.credits.floorApplied}</span>}
        {data.available !== null && data.available !== undefined && (
          <span className="text-[var(--color-muted)]">
            {" "}
            · {fmt(t.credits.estimateAvailable, { n: formatCredits(data.available, locale) })}
          </span>
        )}
        {!data.enforced && <span className="text-[var(--color-muted)]"> · {t.credits.estimateNotEnforced}</span>}
      </>
    );
  }

  return (
    <p className="mono flex flex-wrap items-center gap-x-1 text-[11px]" aria-live="polite">
      <span className="text-[var(--color-muted)]">{t.credits.estimateLabel}:</span> {body}
      {!data.exempt && (
        <Link href={path("/credits")} className="ml-2 text-[var(--color-primary)] hover:underline">
          {t.credits.openCredits}
        </Link>
      )}
    </p>
  );
}
