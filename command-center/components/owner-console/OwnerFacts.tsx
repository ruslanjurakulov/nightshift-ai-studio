import Link from "next/link";
import type { OwnerConsoleDictionary } from "@/lib/i18n/owner-console/en";
import type { Fact } from "@/lib/owner-console/facts-types";
import type { When } from "@/lib/owner-console/facts-view";
import { fill, tashkentDateTime } from "@/lib/owner-analytics/format";

/**
 * The pieces every Owner Console page draws its figures with. Server-safe and data-free: a page reads the owner's facts on
 * the server (owner-only) and passes values in. Every figure carries its tag — measured, estimated or unknown with the
 * reason in words — because "we measured this" and "we assumed this" must survive into what the owner reads.
 */

type F = OwnerConsoleDictionary["facts"];

/** The facts builder explains an unknown in English for the owner's AI; the console says it in the owner's language. */
export function whyText(why: string, f: F): string {
  const w = why.toLowerCase();
  if (w.includes("migration")) return f.why.migration;
  if (w.includes("second factor")) return f.why.secondFactor;
  if (w.includes("not configured")) return f.why.notConfigured;
  if (w.includes("no subscription")) return f.why.noSubscription;
  if (w.includes("fewer than")) return f.why.churnBase;
  if (w.includes("subscription payment")) return f.why.mrrIncomplete;
  if (w.includes("had no amount")) return f.why.paymentNoAmount;
  if (w.includes("14 days")) return f.why.pace;
  if (w.includes("no reading")) return f.why.left;
  if (w.includes("read failed") || w.includes("empty answer")) return f.why.readFailed;
  return f.why.other;
}

export function Tag({ state, f }: { state: "measured" | "estimated" | "unknown"; f: F }) {
  return <span className={`oc-tag oc-tag-${state}`}>{f.tag[state]}</span>;
}

/** A figure with its tag; an unknown says why, in words, and never shows a number. */
export function FactValue<T>({ fact, f, format }: { fact: Fact<T>; f: F; format: (v: T) => string }) {
  if (fact.state === "unknown") {
    return (
      <span className="oc-fact">
        <Tag state="unknown" f={f} /> <span className="oc-why">{whyText(fact.why, f)}</span>
      </span>
    );
  }
  return (
    <span className="oc-fact">
      <span className="oc-val">{format(fact.value)}</span> <Tag state={fact.state} f={f} />
    </span>
  );
}

/** A plain count from the database: null is "unknown", never 0. */
export function Count({ n, f, format }: { n: number | null; f: F; format: (v: number) => string }) {
  return n === null ? <Tag state="unknown" f={f} /> : <span className="oc-val">{format(n)}</span>;
}

export function Kpi({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="oc-kpi">
      <dt className="oc-kpi-label">{label}</dt>
      <dd className="oc-kpi-value">{children}</dd>
      {hint && <dd className="oc-kpi-hint">{hint}</dd>}
    </div>
  );
}

export function Kpis({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <dl className="oc-kpis" aria-label={label}>
      {children}
    </dl>
  );
}

/** A block the database could not give: the reason, and nothing drawn in its place. */
export function Gap({ why, f }: { why: string; f: F }) {
  return (
    <p className="oc-note" role="status">
      <Tag state="unknown" f={f} /> {whyText(why, f)}
    </p>
  );
}

export function AsOf({ iso, f }: { iso: string; f: F }) {
  return <p className="oc-asof">{fill(f.asOf, { time: tashkentDateTime(iso) })}</p>;
}

/** The facts could not be built for this session: say which, and the way out. Nothing else is drawn. */
export function FactsUnavailable({ kind, f, verifyHref, retryHref }: { kind: "second_factor" | "failed"; f: F; verifyHref: string; retryHref: string }) {
  return (
    <section className="oc-card" role="alert">
      <p className="oc-note">{kind === "second_factor" ? f.needsSecondFactor : f.loadFailed}</p>
      <div className="oc-actions">
        {kind === "second_factor" ? (
          <Link className="btn-quiet" href={verifyHref}>
            {f.verify}
          </Link>
        ) : (
          <a className="btn-quiet" href={retryHref}>
            {f.retry}
          </a>
        )}
      </div>
    </section>
  );
}

/** A table that scrolls inside its card at phone width instead of pushing the page sideways. */
export function Table({ caption, head, children }: { caption: string; head: string[]; children: React.ReactNode }) {
  return (
    <div className="oc-table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="oc-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A time from the facts: the database's "none" is a dash; a missing key or text that is not a time is "unknown". */
export function when(w: When, f: F): React.ReactNode {
  if (w === null) return f.none;
  if (w === undefined || w === "invalid") return <Tag state="unknown" f={f} />;
  return tashkentDateTime(w);
}
