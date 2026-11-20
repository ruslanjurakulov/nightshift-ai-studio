import "server-only";
import Link from "next/link";
import type { ReactNode } from "react";
import { getDictionary } from "@/lib/i18n/server";
import type { Dictionary } from "@/lib/i18n";
import { getChannelPath } from "@/lib/channels-path-server";
import { EXPORT_REAUTH_MINUTES, ownerAccess, presentMode, type Access, type ReadFailure } from "@/lib/server/owner-analytics";
import { parseSelection, selectionQuery, tashkentDay, type PeriodSelection } from "@/lib/owner-analytics/period";
import { delta } from "@/lib/owner-analytics/period";
import { fill, pct } from "@/lib/owner-analytics/format";
import { PeriodPicker, PresentToggle, ExportButtons, RetryButton } from "./Controls";

export type Section = "overview" | "revenue" | "users" | "usage" | "costs" | "runway" | "forecast";
const SECTIONS: Array<{ key: Section; path: string; label: keyof Dictionary["ownerAnalytics"] }> = [
  { key: "overview", path: "owner-analytics", label: "tabOverview" },
  { key: "revenue", path: "owner-analytics/revenue", label: "tabRevenue" },
  { key: "users", path: "owner-analytics/users", label: "tabUsers" },
  { key: "usage", path: "owner-analytics/usage", label: "tabUsage" },
  { key: "costs", path: "owner-analytics/costs", label: "tabCosts" },
  { key: "runway", path: "owner-analytics/runway", label: "tabRunway" },
  { key: "forecast", path: "owner-analytics/forecast", label: "tabForecast" },
];

export interface HubContext {
  t: Dictionary;
  d: Dictionary["ownerAnalytics"];
  locale: string;
  sel: PeriodSelection & { fellBack: boolean };
  query: string;
  present: boolean;
  now: Date;
}

type Params = Record<string, string | string[] | undefined>;

/** Who is asking and for which period. `access` other than "owner" means: render HubState and read nothing. */
export async function hubContext(params: Params): Promise<{ access: Access; ctx: HubContext }> {
  const { t, locale } = await getDictionary();
  const now = new Date();
  const sel = parseSelection(params, now);
  const access = await ownerAccess();
  return {
    access,
    ctx: { t, d: t.ownerAnalytics, locale, sel, query: selectionQuery(sel), present: await presentMode(), now },
  };
}

/**
 * What the page says when it shows no figures. A customer who types the URL learns nothing but "not available": no title, no
 * description of what the page holds (the same as the margin page).
 */
/** The page the owner is on, for "sign in again and come back here". Only a path of ours: never a full URL. */
async function currentPath(): Promise<string> {
  const path = await getChannelPath();
  return path("owner-analytics");
}

export async function HubState({ state, ctx }: { state: Access | ReadFailure; ctx: HubContext }) {
  const { d } = ctx;
  const text =
    state === "missing"
      ? d.notEnabled
      : state === "not_configured"
        ? d.notConfigured
      : state === "signed_out" || state === "session"
        ? d.sessionEnded
        : state === "error"
          ? d.readFailed
          : d.forbidden;
  const showChrome = state === "missing" || state === "error" || state === "session" || state === "signed_out";
  return (
    <div className="oa" role={state === "error" ? "alert" : undefined}>
      {showChrome && <h1>{d.title}</h1>}
      <div className="oa-card">
        <p className="oa-note">{text}</p>
        {(state === "error" || state === "session" || state === "signed_out") && (
          <div className="oa-export">
            {state === "error" ? (
              <RetryButton label={d.retry} />
            ) : (
              <Link href={`/login?next=${encodeURIComponent(await currentPath())}`} className="oa-chip">
                {d.signInAgain}
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export async function HubFrame({ ctx, section, children }: { ctx: HubContext; section: Section; children: ReactNode }) {
  const { d, sel } = ctx;
  const path = await getChannelPath();
  return (
    <div className="oa">
      <div className="oa-head">
        <div>
          <h1>{d.title}</h1>
          <p className="oa-note">{d.subtitle}</p>
        </div>
        <PresentToggle on={ctx.present} />
      </div>
      <nav className="oa-tabs" aria-label={d.title}>
        {SECTIONS.map((s) => (
          <Link key={s.key} href={`${path(s.path)}?${ctx.query}`} aria-current={s.key === section ? "page" : undefined}>
            {d[s.label]}
          </Link>
        ))}
      </nav>
      <PeriodPicker
        preset={sel.current.preset}
        startDay={sel.current.startDay}
        endDay={sel.current.endDay}
        compare={sel.compare}
        includeInternal={sel.includeInternal}
        maxDay={tashkentDay(ctx.now)}
      />
      <p className="oa-note">
        {sel.current.startDay} — {sel.current.endDay} · {d.timezoneNote}
        {sel.previous && ` · ${d.previous}: ${sel.previous.startDay} — ${sel.previous.endDay}`}
      </p>
      {sel.fellBack && (
        <p className="oa-note" data-tone="warn" role="status">
          {d.rangeFellBack}
        </p>
      )}
      {ctx.present && <p className="oa-present-banner">{d.presentOn}</p>}
      {sel.includeInternal && (
        <p className="oa-note" data-tone="warn" role="status">
          {d.includedInternal}
        </p>
      )}
      {children}
    </div>
  );
}

/** One headline figure. `value` null means unknown, and the card says so in words, with the reason under it. */
export function Kpi({
  label,
  value,
  previous,
  format,
  ctx,
  note,
  badge,
  unknownText,
  invert,
  previousIncomplete,
}: {
  label: string;
  value: number | null;
  previous?: number | null;
  format: (n: number) => string;
  ctx: HubContext;
  note?: string;
  badge?: string;
  unknownText?: string;
  /** For figures where up is bad (refunds, churn). */
  invert?: boolean;
  /** The previous period's figure is incomplete: no change is computed from it. */
  previousIncomplete?: boolean;
}) {
  const ch = ctx.sel.previous && previous !== undefined ? delta(value, previous) : null;
  const dir = ch === null || ch === 0 ? undefined : (ch > 0) !== Boolean(invert) ? "up" : "down";
  // A previous value measured as 0 is a value: "up from 0" or "no change", never "no previous value".
  const deltaText =
    ch !== null
      ? fill(ctx.d.vsPrevious, { pct: pct(ch, ctx.locale, true) })
      : previous === 0 && value !== null
        ? value === 0
          ? ctx.d.noChange
          : ctx.d.fromZero
        : previousIncomplete
          ? ctx.d.previousIncomplete
          : ctx.d.noPrevious;
  return (
    <div className="oa-kpi">
      <div className="oa-kpi-label">
        {label}
        {badge && <span className="oa-badge" data-tone="warn">{badge}</span>}
      </div>
      <div className="oa-kpi-value" data-unknown={value === null || undefined}>
        {value === null ? (unknownText ?? ctx.d.unknown) : format(value)}
      </div>
      {ctx.sel.previous && (previous !== undefined || previousIncomplete) && (
        <div className="oa-kpi-delta" data-dir={dir}>
          {deltaText}
        </div>
      )}
      {note && <div className="oa-note">{note}</div>}
    </div>
  );
}

export function CardHead({ title, what, ctx, note }: { title: string; what?: string; ctx: HubContext; note?: string }) {
  return (
    <div className="oa-card-head">
      <div>
        <h2>{title}</h2>
        {note && <p className="oa-note">{note}</p>}
      </div>
      {what && <ExportButtons what={what} query={ctx.query} reauthMinutes={EXPORT_REAUTH_MINUTES} title={title} />}
    </div>
  );
}
