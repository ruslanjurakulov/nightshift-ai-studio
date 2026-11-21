/**
 * lib/customers.ts — the Customers page's address bar and the shapes it reads (migration 0138).
 *
 * What would break without these: a typed `?page=` or `?sort=` reaching the database as something it refuses (the page
 * would read "failed" for a link anyone can type), a search longer than the database allows, a missing figure drawn as 0,
 * and a malformed row drawn as a workspace.
 */
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_SORTS,
  DEFAULT_SORT,
  MAX_PAGE,
  MAX_SEARCH,
  PAGE_SIZE,
  accountsArgs,
  barPercent,
  coerceAccounts,
  coerceDaily,
  coerceTotals,
  customersHref,
  pageCount,
  parsePage,
  parseSearch,
  parseSort,
} from "../lib/customers";

const totalsRow = {
  users_total: 12, users_new_7d: 3, users_new_30d: 5, workspaces_total: 10, workspaces_new_7d: 2, workspaces_new_30d: 4,
  active_7d: 1, active_30d: 6, credits_spent_total: 320.5, credits_spent_30d: 25, credits_purchased_total: 500,
  credits_granted_total: 150, paid_usd_total: 12, payments_other_currency: 1, balance_total: 625, reserved_total: 5,
};

const accountRow = (over: Record<string, unknown> = {}) => ({
  org_id: "11111111-1111-1111-1111-111111111111", name: "Opslab C1 Studio", owner_email: "c1@example.test",
  created_at: "2026-11-01T10:00:00+00:00", last_sign_in_at: null, last_activity_at: "2026-11-11T10:00:00+00:00",
  credits_spent_30d: 15, credits_spent: 15, balance: 585, reserved: 0, credits_purchased: 500, credits_granted: 100,
  paid_usd: 12, payments_other_currency: 0, plan_id: "free", plan_name: "Free", jobs_total: 4, jobs_failed: 2, total_count: 2,
  ...over,
});

describe("the address bar", () => {
  it("a sort is one the database knows, else the default", () => {
    for (const s of CUSTOMER_SORTS) expect(parseSort(s)).toBe(s);
    expect(parseSort("email")).toBe(DEFAULT_SORT);
    expect(parseSort(undefined)).toBe(DEFAULT_SORT);
    expect(parseSort(["balance", "paid"])).toBe("balance");
    expect(DEFAULT_SORT).toBe("spent_total");
  });

  it("a page is a whole number the database will page to, else page 1", () => {
    expect(parsePage("3")).toBe(3);
    for (const bad of ["0", "-1", "1.5", "abc", "", " 2", "1e3", String(MAX_PAGE + 1), "99999999"]) expect(parsePage(bad)).toBe(1);
    expect(parsePage(String(MAX_PAGE))).toBe(MAX_PAGE);
    // the last page any link can name stays inside the database's offset bound
    expect((MAX_PAGE - 1) * PAGE_SIZE).toBeLessThanOrEqual(1_000_000);
  });

  it("a search is trimmed and cut to what the database accepts, counting characters, not bytes", () => {
    expect(parseSearch("  ali@x  ")).toBe("ali@x");
    expect(parseSearch(undefined)).toBe("");
    const long = "ʻ".repeat(MAX_SEARCH + 50);
    expect(Array.from(parseSearch(long))).toHaveLength(MAX_SEARCH);
  });

  it("asks for one page of PAGE_SIZE rows, and no search as null", () => {
    expect(accountsArgs("", "spent_total", 1)).toEqual({ p_search: null, p_sort: "spent_total", p_limit: PAGE_SIZE, p_offset: 0 });
    expect(accountsArgs("ali", "paid", 3)).toEqual({ p_search: "ali", p_sort: "paid", p_limit: PAGE_SIZE, p_offset: 2 * PAGE_SIZE });
    expect(PAGE_SIZE).toBeLessThanOrEqual(100);
  });

  it("links leave the defaults out and keep the rest", () => {
    expect(customersHref("/c/customers", { q: "", sort: "spent_total", page: 1 })).toBe("/c/customers");
    expect(customersHref("/c/customers", { q: "a b&c", sort: "paid", page: 2 })).toBe("/c/customers?q=a+b%26c&sort=paid&page=2");
  });

  it("counts pages, at least one", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(PAGE_SIZE)).toBe(1);
    expect(pageCount(PAGE_SIZE + 1)).toBe(2);
  });
});

describe("what the database sent", () => {
  it("the headline row is taken whole, or not at all", () => {
    expect(coerceTotals([totalsRow])).toMatchObject({ usersTotal: 12, creditsSpentTotal: 320.5, paymentsOtherCurrency: 1, reservedTotal: 5 });
    // a figure missing is not 0: the page says the read failed instead of drawing a number it cannot stand behind
    expect(coerceTotals([{ ...totalsRow, credits_spent_total: null }])).toBeNull();
    expect(coerceTotals([{ ...totalsRow, paid_usd_total: "abc" }])).toBeNull();
    expect(coerceTotals([])).toBeNull();
    expect(coerceTotals([totalsRow, totalsRow])).toBeNull();
    expect(coerceTotals(null)).toBeNull();
    // numeric columns may arrive as strings
    expect(coerceTotals([{ ...totalsRow, balance_total: "625.00" }])?.balanceTotal).toBe(625);
  });

  it("day rows keep their order and drop what is malformed", () => {
    const rows = coerceDaily([
      { day: "2026-11-10", signups: 1, credits_spent: 4, active_accounts: 1 },
      { day: "nope", signups: 1, credits_spent: 4, active_accounts: 1 },
      { day: "2026-11-11", signups: 0, credits_spent: null, active_accounts: 0 },
      { day: "2026-11-12T00:00:00", signups: 2, credits_spent: "7.5", active_accounts: 2 },
    ]);
    expect(rows).toEqual([
      { day: "2026-11-10", signups: 1, creditsSpent: 4, activeAccounts: 1 },
      { day: "2026-11-12", signups: 2, creditsSpent: 7.5, activeAccounts: 2 },
    ]);
    expect(coerceDaily({})).toEqual([]);
  });

  it("an account keeps an unknown as null, never 0, and carries the count", () => {
    const page = coerceAccounts([accountRow({ balance: null, reserved: null, owner_email: null, plan_id: null, plan_name: null })]);
    expect(page.total).toBe(2);
    const [r] = page.rows;
    expect(r.balance).toBeNull();
    expect(r.reserved).toBeNull();
    expect(r.ownerEmail).toBeNull();
    expect(r.lastSignInAt).toBeNull();
    expect(r.planName).toBeNull();
    expect(r.creditsSpent).toBe(15);
    expect(r.jobsFailed).toBe(2);
  });

  it("a row without its id, name, sign-up or an always-sent figure is not a workspace", () => {
    const page = coerceAccounts([
      accountRow({ org_id: null }),
      accountRow({ name: undefined }),
      accountRow({ created_at: "" }),
      accountRow({ credits_spent: null }),
      accountRow({ jobs_total: "x" }),
      "junk",
      accountRow({ org_id: "22222222-2222-2222-2222-222222222222" }),
    ]);
    expect(page.rows.map((r) => r.orgId)).toEqual(["22222222-2222-2222-2222-222222222222"]);
    expect(coerceAccounts(null)).toEqual({ rows: [], total: null });
    expect(coerceAccounts([])).toEqual({ rows: [], total: null });
  });
});

describe("bars", () => {
  it("are a share of the largest value, and nothing when there is nothing", () => {
    expect(barPercent(5, 10)).toBe(50);
    expect(barPercent(10, 10)).toBe(100);
    expect(barPercent(0, 10)).toBe(0);
    expect(barPercent(0, 0)).toBe(0);
    // a small value above 0 is still visible
    expect(barPercent(0.01, 1000)).toBe(1);
  });
});
