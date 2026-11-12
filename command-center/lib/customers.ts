/**
 * The operator's Customers page (migration 0138): the shapes the page reads, and the rules for its address bar. Pure: no
 * server imports.
 *
 * The database decides every number (operator_customer_totals, operator_customer_daily, operator_customer_accounts);
 * this file only refuses to invent one. A value the database did not send is null here and is worded by the page ("—",
 * "never"), never read as 0 (CLAUDE.md #5). Sorting, searching and paging happen in the database: the page asks for one
 * page and draws it, so nothing here sorts or filters rows.
 */

export const CUSTOMER_SORTS = ["spent_total", "spent_30d", "balance", "paid", "signup", "activity"] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];
export const DEFAULT_SORT: CustomerSort = "spent_total";

/** Rows per page; the database allows at most 100. */
export const PAGE_SIZE = 50;
/** The database refuses an offset above 1,000,000; a page past it is the last one it would answer. */
export const MAX_PAGE = Math.floor(1_000_000 / PAGE_SIZE) + 1;
/** The database refuses a search longer than this. */
export const MAX_SEARCH = 200;
/** Days in the day-by-day list (the database allows 1 to 90). */
export const DAILY_DAYS = 30;

type Raw = string | string[] | undefined;
const first = (v: Raw): string | undefined => (Array.isArray(v) ? v[0] : v);

/** The sort a `?sort=` names; anything else is the default. */
export function parseSort(raw: Raw): CustomerSort {
  const v = first(raw);
  return (CUSTOMER_SORTS as readonly string[]).includes(v ?? "") ? (v as CustomerSort) : DEFAULT_SORT;
}

/** The page a `?page=` names, 1-based; anything that is not a whole number from 1 to MAX_PAGE is page 1. */
export function parsePage(raw: Raw): number {
  const v = first(raw);
  if (!v || !/^\d{1,7}$/.test(v)) return 1;
  const n = Number(v);
  return n >= 1 && n <= MAX_PAGE ? n : 1;
}

/** The search a `?q=` names: trimmed, at most MAX_SEARCH characters (cut, so the database never refuses it), "" for none. */
export function parseSearch(raw: Raw): string {
  return Array.from((first(raw) ?? "").trim()).slice(0, MAX_SEARCH).join("").trim();
}

/** What operator_customer_accounts() takes for a page. */
export function accountsArgs(q: string, sort: CustomerSort, page: number) {
  return { p_search: q === "" ? null : q, p_sort: sort, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE };
}

/** How many pages `total` matching workspaces fill; at least 1, so "page 1 of 1" reads for an empty list. */
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / PAGE_SIZE));
}

/** The page's own address with these values; the default sort, page 1 and an empty search are left out. */
export function customersHref(base: string, v: { q: string; sort: CustomerSort; page: number }): string {
  const p = new URLSearchParams();
  if (v.q) p.set("q", v.q);
  if (v.sort !== DEFAULT_SORT) p.set("sort", v.sort);
  if (v.page > 1) p.set("page", String(v.page));
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A known number, or null: null, undefined, "" and anything not finite never become 0. */
function known(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export interface CustomerTotals {
  usersTotal: number;
  usersNew7d: number;
  usersNew30d: number;
  workspacesTotal: number;
  workspacesNew7d: number;
  workspacesNew30d: number;
  active7d: number;
  active30d: number;
  creditsSpentTotal: number;
  creditsSpent30d: number;
  creditsPurchasedTotal: number;
  creditsGrantedTotal: number;
  paidUsdTotal: number;
  paymentsOtherCurrency: number;
  balanceTotal: number;
  reservedTotal: number;
}

const TOTAL_FIELDS: [keyof CustomerTotals, string][] = [
  ["usersTotal", "users_total"],
  ["usersNew7d", "users_new_7d"],
  ["usersNew30d", "users_new_30d"],
  ["workspacesTotal", "workspaces_total"],
  ["workspacesNew7d", "workspaces_new_7d"],
  ["workspacesNew30d", "workspaces_new_30d"],
  ["active7d", "active_7d"],
  ["active30d", "active_30d"],
  ["creditsSpentTotal", "credits_spent_total"],
  ["creditsSpent30d", "credits_spent_30d"],
  ["creditsPurchasedTotal", "credits_purchased_total"],
  ["creditsGrantedTotal", "credits_granted_total"],
  ["paidUsdTotal", "paid_usd_total"],
  ["paymentsOtherCurrency", "payments_other_currency"],
  ["balanceTotal", "balance_total"],
  ["reservedTotal", "reserved_total"],
];

/**
 * The one row of operator_customer_totals(). The database always sends every figure (a sum of nothing is its 0), so a row
 * missing any of them is not a row this page can stand behind: null, and the page says the read failed.
 */
export function coerceTotals(data: unknown): CustomerTotals | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!isObj(row) || (Array.isArray(data) && data.length !== 1)) return null;
  const out = {} as CustomerTotals;
  for (const [key, col] of TOTAL_FIELDS) {
    const n = known(row[col]);
    if (n === null) return null;
    out[key] = n;
  }
  return out;
}

export interface CustomerDay {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  signups: number;
  creditsSpent: number;
  activeAccounts: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The rows of operator_customer_daily(), oldest first as the database sends them; a malformed row is dropped, not guessed. */
export function coerceDaily(data: unknown): CustomerDay[] {
  if (!Array.isArray(data)) return [];
  const out: CustomerDay[] = [];
  for (const r of data) {
    if (!isObj(r)) continue;
    const day = typeof r.day === "string" ? r.day.slice(0, 10) : "";
    const signups = known(r.signups);
    const creditsSpent = known(r.credits_spent);
    const activeAccounts = known(r.active_accounts);
    if (!DAY_RE.test(day) || signups === null || creditsSpent === null || activeAccounts === null) continue;
    out.push({ day, signups, creditsSpent, activeAccounts });
  }
  return out;
}

export interface CustomerAccount {
  orgId: string;
  name: string;
  /** null: the workspace has no member row with an address. */
  ownerEmail: string | null;
  createdAt: string;
  /** null: never signed in, as far as the sign-in service recorded. */
  lastSignInAt: string | null;
  /** null: no capture and no generation yet. */
  lastActivityAt: string | null;
  creditsSpent30d: number;
  creditsSpent: number;
  /** null: the workspace has no credit account yet (it never held a credit). */
  balance: number | null;
  reserved: number | null;
  creditsPurchased: number;
  creditsGranted: number;
  paidUsd: number;
  /** Completed payments in a currency other than USD: counted, never added to paidUsd. */
  paymentsOtherCurrency: number;
  planId: string | null;
  planName: string | null;
  jobsTotal: number;
  jobsFailed: number;
}

export interface CustomerPage {
  rows: CustomerAccount[];
  /** Workspaces matching the search, across every page; null when this page came back empty and so carried no count. */
  total: number | null;
}

const COUNT_FIELDS = [
  ["creditsSpent30d", "credits_spent_30d"],
  ["creditsSpent", "credits_spent"],
  ["creditsPurchased", "credits_purchased"],
  ["creditsGranted", "credits_granted"],
  ["paidUsd", "paid_usd"],
  ["paymentsOtherCurrency", "payments_other_currency"],
  ["jobsTotal", "jobs_total"],
  ["jobsFailed", "jobs_failed"],
] as const;

/** The rows of operator_customer_accounts(); a row without its id, name, sign-up or one of its always-sent figures is dropped. */
export function coerceAccounts(data: unknown): CustomerPage {
  if (!Array.isArray(data)) return { rows: [], total: null };
  const rows: CustomerAccount[] = [];
  let total: number | null = null;
  for (const r of data) {
    if (!isObj(r)) continue;
    const orgId = text(r.org_id);
    const name = typeof r.name === "string" ? r.name : null;
    const createdAt = text(r.created_at);
    if (!orgId || name === null || !createdAt) continue;
    const counts: Partial<Record<(typeof COUNT_FIELDS)[number][0], number>> = {};
    let ok = true;
    for (const [key, col] of COUNT_FIELDS) {
      const n = known(r[col]);
      if (n === null) ok = false;
      else counts[key] = n;
    }
    if (!ok) continue;
    total = known(r.total_count) ?? total;
    rows.push({
      orgId,
      name,
      ownerEmail: text(r.owner_email),
      createdAt,
      lastSignInAt: text(r.last_sign_in_at),
      lastActivityAt: text(r.last_activity_at),
      balance: known(r.balance),
      reserved: known(r.reserved),
      planId: text(r.plan_id),
      planName: text(r.plan_name),
      ...(counts as Record<(typeof COUNT_FIELDS)[number][0], number>),
    });
  }
  return { rows, total };
}

/** A bar's length, 0-100 (percent of the largest value in the list); 0 when nothing in the list is above 0. */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(100, Math.max(1, Math.round((value / max) * 100)));
}
