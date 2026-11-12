"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { EmptyState } from "@/components/ui";
import { DataList } from "@/components/g4/DataList";
import { Figures, Section } from "@/components/g4/Section";
import { ownerTime } from "@/lib/format";
import { formatNumber, formatUsdAmount } from "@/lib/number-format";
import {
  CUSTOMER_SORTS,
  DEFAULT_SORT,
  barPercent,
  customersHref,
  pageCount,
  type CustomerAccount,
  type CustomerDay,
  type CustomerPage,
  type CustomerSort,
  type CustomerTotals,
} from "@/lib/customers";

/**
 * The operator's Customers page (migration 0138): the headline numbers, the last 30 days, then one page of workspaces.
 * The database decides every figure, the order and the page; this only lays them out. Search, sort and paging are links and
 * a GET form, so the address bar is the state and a reload shows the same page. Nothing here writes, grants or spends.
 */
export function CustomersReport({
  totals,
  daily,
  accounts,
  q,
  sort,
  page,
}: {
  totals: CustomerTotals;
  daily: CustomerDay[];
  accounts: CustomerPage;
  q: string;
  sort: CustomerSort;
  page: number;
}) {
  const { t, locale } = useI18n();
  const c = t.customers;
  const path = useChannelPath();
  const base = path("/customers");
  const n = (v: number) => formatNumber(v, locale, 2);
  const usd = (v: number) => formatUsdAmount(v, locale, 2, 2);
  const href = (over: Partial<{ q: string; sort: CustomerSort; page: number }>) => customersHref(base, { q, sort, page, ...over });

  const sortLabel: Record<CustomerSort, string> = {
    spent_total: c.sort_spent_total,
    spent_30d: c.sort_spent_30d,
    balance: c.sort_balance,
    paid: c.sort_paid,
    signup: c.sort_signup,
    activity: c.sort_activity,
  };
  const maxSpent = Math.max(0, ...daily.map((d) => d.creditsSpent));
  const maxSignups = Math.max(0, ...daily.map((d) => d.signups));
  const total = accounts.total;
  const pages = total === null ? null : pageCount(total);

  return (
    <div className="g4-stack">
      <section aria-label={c.title} className="ns-desk flex flex-col gap-6">
        <Figures>
          <Figure label={c.figPeople} value={n(totals.usersTotal)} sub={fmt(c.figNewSub, { d7: n(totals.usersNew7d), d30: n(totals.usersNew30d) })} />
          <Figure
            label={c.figWorkspaces}
            value={n(totals.workspacesTotal)}
            sub={fmt(c.figNewSub, { d7: n(totals.workspacesNew7d), d30: n(totals.workspacesNew30d) })}
          />
          <Figure label={c.figActive} value={n(totals.active30d)} sub={fmt(c.figActiveSub, { n: n(totals.active7d) })} />
          <Figure label={c.figSpent} value={n(totals.creditsSpentTotal)} sub={fmt(c.figSpentSub, { n: n(totals.creditsSpent30d) })} />
        </Figures>
        <Figures>
          <Figure label={c.figBought} value={n(totals.creditsPurchasedTotal)} sub={c.figBoughtSub} />
          <Figure label={c.figGranted} value={n(totals.creditsGrantedTotal)} sub={c.figGrantedSub} />
          <Figure
            label={c.figPaid}
            value={usd(totals.paidUsdTotal)}
            sub={totals.paymentsOtherCurrency > 0 ? fmt(c.figPaidOther, { n: n(totals.paymentsOtherCurrency) }) : c.figPaidSub}
          />
          <Figure label={c.figBalance} value={n(totals.balanceTotal)} sub={fmt(c.figBalanceSub, { n: n(totals.reservedTotal) })} />
        </Figures>
      </section>

      <Section title={c.dailyTitle}>
        <p className="g4-note mb-3">{c.dailyCaption}</p>
        <DataList
          caption={c.dailyCaption}
          rows={[...daily].reverse()}
          rowKey={(d) => d.day}
          columns={[
            { key: "day", label: c.colDay, nowrap: true, render: (d) => <span className="tnum">{d.day}</span> },
            { key: "signups", label: c.colSignups, render: (d) => <Bar value={d.signups} max={maxSignups} text={n(d.signups)} /> },
            { key: "spent", label: c.colSpent, render: (d) => <Bar value={d.creditsSpent} max={maxSpent} text={n(d.creditsSpent)} /> },
            { key: "active", label: c.colActive, align: "end", render: (d) => <span className="tnum">{n(d.activeAccounts)}</span> },
          ]}
        />
      </Section>

      <Section title={c.accountsTitle} right={total !== null ? <span className="g4-muted g4-small tnum">{fmt(c.countLine, { n: n(total) })}</span> : undefined}>
        <form method="get" action={base} role="search" className="mb-4 flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="t-label">{c.searchLabel}</span>
            <input type="search" name="q" defaultValue={q} maxLength={200} placeholder={c.searchPlaceholder} className="ns-field min-w-0" />
          </label>
          {sort !== DEFAULT_SORT && <input type="hidden" name="sort" value={sort} />}
          <button type="submit" className="btn-quiet min-h-11 px-4 text-sm">
            {c.searchSubmit}
          </button>
          {q && (
            <Link href={href({ q: "", page: 1 })} className="btn-quiet min-h-11 px-4 text-sm">
              {c.searchClear}
            </Link>
          )}
        </form>

        <nav aria-label={c.sortLabel} className="ns-tabs mb-4 flex flex-wrap items-center gap-x-2">
          <span className="t-label pr-3">{c.sortLabel}</span>
          {CUSTOMER_SORTS.map((s) => (
            <Link key={s} href={href({ sort: s, page: 1 })} aria-current={s === sort ? "page" : undefined} className="ns-tabs-link">
              {sortLabel[s]}
            </Link>
          ))}
        </nav>

        {accounts.rows.length === 0 ? (
          <div className="panel">
            <EmptyState>
              {page > 1 ? (
                <>
                  {c.pastEnd}{" "}
                  <Link href={href({ page: 1 })} className="underline">
                    {c.firstPage}
                  </Link>
                </>
              ) : q ? (
                fmt(c.noMatch, { q })
              ) : (
                c.empty
              )}
            </EmptyState>
          </div>
        ) : (
          accountsTable(accounts.rows)
        )}

        {pages !== null && pages > 1 && (
          <nav aria-label={c.pager} className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            {page > 1 ? (
              <Link href={href({ page: page - 1 })} rel="prev" className="btn-quiet min-h-11 px-4 text-sm">
                {c.prev}
              </Link>
            ) : null}
            <span className="g4-muted tnum">{fmt(c.pageOf, { page: n(page), pages: n(pages) })}</span>
            {page < pages ? (
              <Link href={href({ page: page + 1 })} rel="next" className="btn-quiet min-h-11 px-4 text-sm">
                {c.next}
              </Link>
            ) : null}
          </nav>
        )}
      </Section>

      <section aria-labelledby="customers-rules" className="flex flex-col gap-2">
        <h2 id="customers-rules" className="t-panel">
          {c.rulesTitle}
        </h2>
        <p className="g4-note">{c.ruleSpent}</p>
        <p className="g4-note">{c.rulePaid}</p>
        <p className="g4-note">{c.ruleGross}</p>
        <p className="g4-note">{c.ruleScope}</p>
      </section>
    </div>
  );

  function accountsTable(rows: CustomerAccount[]) {
    const muted = (text: string) => <div className="g4-muted g4-small">{text}</div>;
    return (
      <DataList
        caption={c.accountsTitle}
        rows={rows}
        rowKey={(r) => r.orgId}
        columns={[
          {
            key: "workspace",
            label: c.colWorkspace,
            render: (r) => (
              <>
                <div className="break-words">{r.name}</div>
                <div className="g4-muted g4-small break-all">{r.ownerEmail ?? c.cellNoEmail}</div>
              </>
            ),
          },
          { key: "plan", label: c.colPlan, render: (r) => <span>{r.planName ?? r.planId ?? "—"}</span> },
          {
            key: "signup",
            label: c.colSignedUp,
            nowrap: true,
            render: (r) => (
              <>
                <div className="tnum">{ownerTime(r.createdAt, locale)}</div>
                {muted(`${c.colLastSignIn}: ${r.lastSignInAt ? ownerTime(r.lastSignInAt, locale) : c.cellNever}`)}
              </>
            ),
          },
          {
            key: "activity",
            label: c.colActivity,
            nowrap: true,
            render: (r) => <span className="tnum">{r.lastActivityAt ? ownerTime(r.lastActivityAt, locale) : c.cellNoActivity}</span>,
          },
          { key: "spent30", label: c.colSpent30d, align: "end", render: (r) => <span className="tnum">{n(r.creditsSpent30d)}</span> },
          { key: "spent", label: c.colSpentTotal, align: "end", render: (r) => <span className="tnum">{n(r.creditsSpent)}</span> },
          {
            key: "balance",
            label: c.colBalance,
            align: "end",
            render: (r) =>
              r.balance === null ? (
                <span className="g4-muted">{c.cellNoAccount}</span>
              ) : (
                <>
                  <div className="tnum">{n(r.balance)}</div>
                  {r.reserved !== null && r.reserved > 0 && muted(fmt(c.cellOnHold, { n: n(r.reserved) }))}
                </>
              ),
          },
          {
            key: "bought",
            label: c.colBought,
            align: "end",
            render: (r) => (
              <>
                <div className="tnum">{n(r.creditsPurchased)}</div>
                {r.creditsGranted > 0 && muted(fmt(c.cellGranted, { n: n(r.creditsGranted) }))}
              </>
            ),
          },
          {
            key: "paid",
            label: c.colPaid,
            align: "end",
            render: (r) => (
              <>
                <div className="tnum">{usd(r.paidUsd)}</div>
                {r.paymentsOtherCurrency > 0 && muted(fmt(c.cellOtherCurrency, { n: n(r.paymentsOtherCurrency) }))}
              </>
            ),
          },
          {
            key: "jobs",
            label: c.colJobs,
            align: "end",
            render: (r) => (
              <>
                <div className="tnum">{n(r.jobsTotal)}</div>
                {r.jobsFailed > 0 && <div className="g4-small text-[var(--color-warn)]">{fmt(c.cellFailed, { n: n(r.jobsFailed) })}</div>}
              </>
            ),
          },
        ]}
      />
    );
  }
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="t-label">{label}</div>
      <div className="t-figure mt-3 tnum">{value}</div>
      {sub && <div className="mt-2 text-sm font-light text-[var(--color-muted)]">{sub}</div>}
    </div>
  );
}

/** A figure with a bar behind it: its length is the share of the list's largest value. Decoration: the figure is the text. */
function Bar({ value, max, text }: { value: number; max: number; text: string }) {
  const pct = barPercent(value, max);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="tnum w-14 shrink-0">{text}</span>
      <span aria-hidden className="block h-1.5 min-w-0 flex-1 rounded-full bg-[var(--color-border)]">
        {pct > 0 && <span className="block h-1.5 rounded-full bg-[var(--color-primary)]" style={{ width: `${pct}%` }} />}
      </span>
    </div>
  );
}
