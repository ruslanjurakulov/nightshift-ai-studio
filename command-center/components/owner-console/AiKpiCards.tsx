import Link from "next/link";
import { Activity, Gauge, UserPlus, Wallet, type LucideIcon } from "lucide-react";
import type { OwnerConsoleDictionary } from "@/lib/i18n/owner-console/en";
import type { AiKpis, KpiCard, KpiHint, RunwayValue } from "@/lib/owner-console/ai-kpis";
import { fill, int, usd } from "@/lib/owner-analytics/format";
import { AsOf, Tag, whyText } from "./OwnerFacts";
import { KpiRetry } from "./KpiRetry";

/**
 * The four live cards above the owner's Nightshift AI. Server-safe and data-free: the page reads the figures (owner only) and
 * passes them in. Every value carries the word its source gives it (measured / estimated); an unknown says why in words and shows
 * no number; a failed read says so with "Try again". The tint of a card is never the only signal: the words say it too.
 */

type A = OwnerConsoleDictionary["assistant"];
type F = OwnerConsoleDictionary["facts"];
type Tone = "warn" | "fail" | undefined;

function Shell({ icon: Icon, label, tone, children }: { icon: LucideIcon; label: string; tone?: Tone; children: React.ReactNode }) {
  return (
    <div className="ai-kpi" data-tone={tone}>
      <dt className="ai-kpi-label">
        <span className="ai-kpi-ic" aria-hidden>
          <Icon size={16} />
        </span>
        {label}
      </dt>
      {children}
    </div>
  );
}

function hintText(h: KpiHint, k: A["kpi"]): string {
  if (h.kind === "truncated") return k.truncated;
  return fill(h.kind === "refused" ? k.refused : k.unjudged, { n: h.n });
}

/** The parts every card shares: unknown, error, or a value with its tag and hint. */
function Body<T>({ card, a, f, value }: { card: KpiCard<T>; a: A; f: F; value: (v: T) => React.ReactNode }) {
  if (card.state === "error") {
    return (
      <dd className="ai-kpi-body">
        <span className="oc-why">{a.kpi.error}</span>
        <KpiRetry label={f.retry} busy={a.kpi.retrying} />
      </dd>
    );
  }
  if (card.state === "unknown") {
    return (
      <dd className="ai-kpi-body">
        <span className="oc-fact">
          <Tag state="unknown" f={f} /> <span className="oc-why">{whyText(card.why, f)}</span>
        </span>
      </dd>
    );
  }
  return (
    <>
      <dd className="ai-kpi-body">
        <span className="oc-fact">
          {value(card.value)} <Tag state={card.state} f={f} />
        </span>
      </dd>
      {card.hint && <dd className="ai-kpi-hint">{hintText(card.hint, a.kpi)}</dd>}
    </>
  );
}

function runwayLine(v: RunwayValue, k: A["kpi"]): string {
  if (v.runsOut === "empty") return k.empty;
  if (v.runsOut === "never") return k.never;
  return v.runsOut === null ? "" : fill(k.runsOut, { day: v.runsOut });
}

export function AiKpiCards({ kpis, asOf, a, f, locale }: { kpis: AiKpis; asOf: string; a: A; f: F; locale: string }) {
  const k = a.kpi;
  const rw = kpis.runway;
  const runwayTone: Tone = rw.state === "estimated" || rw.state === "measured" ? (rw.value.runsOut === "empty" ? "fail" : rw.value.due ? "warn" : undefined) : undefined;
  const failedTone: Tone = kpis.failed24h.state === "measured" && kpis.failed24h.value > 0 ? "warn" : undefined;
  return (
    <section className="ai-kpis-wrap" aria-labelledby="ai-kpis-h">
      <h2 id="ai-kpis-h" className="sr-only">
        {k.title}
      </h2>
      <dl className="ai-kpis">
        <Shell icon={Wallet} label={k.revenueToday}>
          <Body card={kpis.revenueToday} a={a} f={f} value={(v) => <span className="ai-kpi-val">{usd(v, locale)}</span>} />
        </Shell>
        <Shell icon={UserPlus} label={k.signups24h}>
          <Body card={kpis.signups24h} a={a} f={f} value={(v) => <span className="ai-kpi-val">{int(v, locale)}</span>} />
        </Shell>
        <Shell icon={Activity} label={k.failed24h} tone={failedTone}>
          <Body card={kpis.failed24h} a={a} f={f} value={(v) => <span className="ai-kpi-val">{int(v, locale)}</span>} />
        </Shell>
        <Shell icon={Gauge} label={k.runway} tone={runwayTone}>
          {(rw.state === "estimated" || rw.state === "measured") && rw.value.name === null ? (
            // No provider tracked is a fact about the registry, not an estimate: no tag.
            <dd className="ai-kpi-body">
              <span className="oc-why">{k.noProvider}</span>
            </dd>
          ) : (
            <Body
              card={rw}
              a={a}
              f={f}
              value={(v) => (
                <span className="ai-kpi-runway">
                  <span className="ai-kpi-val ai-kpi-name">{v.name}</span>
                  <span className="ai-kpi-sub">{runwayLine(v, k)}</span>
                  <span className="ai-kpi-sub">{fill(v.due ? k.due : k.lasts, { days: v.days })}</span>
                </span>
              )}
            />
          )}
        </Shell>
      </dl>
      <AsOf iso={asOf} f={f} />
    </section>
  );
}

/** While the figures load: the same four frames, so nothing jumps when they arrive. Announced once, politely. */
export function AiKpiSkeleton({ a }: { a: A }) {
  const k = a.kpi;
  const labels: Array<[LucideIcon, string]> = [
    [Wallet, k.revenueToday],
    [UserPlus, k.signups24h],
    [Activity, k.failed24h],
    [Gauge, k.runway],
  ];
  return (
    <section className="ai-kpis-wrap" aria-busy="true" aria-labelledby="ai-kpis-h">
      <h2 id="ai-kpis-h" className="sr-only">
        {k.title}
      </h2>
      <p className="sr-only" role="status">
        {k.loading}
      </p>
      <dl className="ai-kpis">
        {labels.map(([icon, label]) => (
          <Shell key={label} icon={icon} label={label}>
            <dd className="ai-kpi-body" aria-hidden>
              <span className="ai-skel ai-skel-val" />
              <span className="ai-skel ai-skel-tag" />
            </dd>
          </Shell>
        ))}
      </dl>
    </section>
  );
}

/** The figures could not be read for this session at all: the reason and the way out, in one card, instead of four errors. */
export function AiKpiUnavailable({ kind, a, f, verifyHref }: { kind: "second_factor" | "failed"; a: A; f: F; verifyHref: string }) {
  return (
    <section className="ai-kpis-wrap" aria-labelledby="ai-kpis-h">
      <h2 id="ai-kpis-h" className="sr-only">
        {a.kpi.title}
      </h2>
      <div className="ai-kpi-down" role="alert">
        <p className="m-0 oc-note">{kind === "second_factor" ? f.needsSecondFactor : f.loadFailed}</p>
        {kind === "second_factor" ? (
          <Link className="btn-quiet" href={verifyHref}>
            {f.verify}
          </Link>
        ) : (
          <KpiRetry label={f.retry} busy={a.kpi.retrying} />
        )}
      </div>
    </section>
  );
}
