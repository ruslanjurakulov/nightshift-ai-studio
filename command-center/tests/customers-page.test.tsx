/**
 * The Customers page (migration 0138), rendered against a scripted Supabase.
 *
 * What would break without these: a customer reaching other people's addresses and spend through the page, a failed or
 * partial read drawn as numbers, a deployment without 0138 reported as broken instead of "not applied", a hold counted as
 * a spend on screen, a payment in another currency drawn as dollars, and the search / sort / page in the address bar not
 * reaching the database (or reaching it as something it refuses).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { esc } from "./helpers/supabaseStub";
import { NAV_GROUPS, isOperatorOnlySection, navGroupsFor, sectionAllowed, CUSTOMER_SECTIONS } from "../lib/navigation";
import { PAGE_SIZE } from "../lib/customers";

vi.mock("server-only", () => ({}));

type Res = { data: unknown; error: null | { code?: string; message?: string } };
const state = vi.hoisted(() => ({
  operator: true,
  totals: { data: [] as unknown, error: null } as { data: unknown; error: null | { code?: string; message?: string } },
  daily: { data: [] as unknown, error: null } as { data: unknown; error: null | { code?: string; message?: string } },
  accounts: { data: [] as unknown, error: null } as { data: unknown; error: null | { code?: string; message?: string } },
  calls: [] as { fn: string; args: unknown }[],
}));

vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/i18n/public-context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/chronos/customers" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: unknown) => {
      state.calls.push({ fn, args });
      if (fn === "operator_customer_totals") return state.totals;
      if (fn === "operator_customer_daily") return state.daily;
      if (fn === "operator_customer_accounts") return state.accounts;
      return { data: null, error: null };
    },
  }),
  getUser: async () => ({ id: "u1", email: "me@example.com" }),
}));
vi.mock("@/lib/auth/org-roles", () => ({ isOperator: async () => state.operator }));

const totalsRow = (over: Record<string, unknown> = {}) => ({
  users_total: 1234, users_new_7d: 3, users_new_30d: 5, workspaces_total: 1100, workspaces_new_7d: 2, workspaces_new_30d: 4,
  active_7d: 1, active_30d: 6, credits_spent_total: 320.5, credits_spent_30d: 25, credits_purchased_total: 500,
  credits_granted_total: 150, paid_usd_total: 12, payments_other_currency: 0, balance_total: 625, reserved_total: 5, ...over,
});
const day = (d: string, spent: number, signups = 0) => ({ day: d, signups, credits_spent: spent, active_accounts: spent > 0 ? 1 : 0 });
const account = (over: Record<string, unknown> = {}) => ({
  org_id: "11111111-1111-1111-1111-111111111111", name: "Opslab C1 Studio", owner_email: "c1@example.test",
  created_at: "2026-11-01T10:00:00+00:00", last_sign_in_at: null, last_activity_at: "2026-11-11T10:00:00+00:00",
  credits_spent_30d: 15, credits_spent: 17, balance: 585, reserved: 5, credits_purchased: 500, credits_granted: 100,
  paid_usd: 12, payments_other_currency: 0, plan_id: "pro", plan_name: "Pro", jobs_total: 4, jobs_failed: 2, total_count: 1, ...over,
});

async function page(params: Record<string, string> = {}): Promise<string> {
  const mod = await import("../app/(app)/[channel]/customers/page");
  const el = (await mod.default({ searchParams: Promise.resolve(params) })) as ReactElement;
  return renderToStaticMarkup(el);
}
const has = (html: string, text: string) => html.includes(esc(text));
const ok = (data: unknown): Res => ({ data, error: null });

beforeEach(() => {
  state.operator = true;
  state.totals = ok([totalsRow()]);
  state.daily = ok([day("2026-11-11", 4, 1), day("2026-11-12", 8)]);
  state.accounts = ok([account()]);
  state.calls.length = 0;
});

describe("who may open it", () => {
  it("is an operator-only section in the operator's rail, never a customer's", () => {
    expect(isOperatorOnlySection("customers")).toBe(true);
    expect(sectionAllowed("customers", false)).toBe(false);
    expect(sectionAllowed("customers", true)).toBe(true);
    expect(CUSTOMER_SECTIONS).not.toContain("customers");
    expect(NAV_GROUPS.flatMap((g) => g.items).some((i) => i.href === "/customers" && i.key === "customers")).toBe(true);
    expect(navGroupsFor(true).flatMap((g) => g.items).some((i) => i.key === "customers")).toBe(true);
    expect(navGroupsFor(false).flatMap((g) => g.items).some((i) => i.key === "customers")).toBe(false);
  });

  it("a customer who reaches the URL gets the refusal and the database is never asked", async () => {
    state.operator = false;
    const html = await page();
    expect(has(html, en.customers.forbidden)).toBe(true);
    expect(html).not.toContain(en.customers.title);
    expect(html).not.toContain(esc(en.customers.subtitle));
    expect(state.calls).toEqual([]);
    expect(html).not.toContain("c1@example.test");
  });

  it("when the database itself refuses (42501) the page says so, not 'empty'", async () => {
    state.accounts = { data: null, error: { code: "42501", message: "not available" } };
    const html = await page();
    expect(has(html, en.customers.forbidden)).toBe(true);
    expect(has(html, en.customers.empty)).toBe(false);
    expect(html).not.toContain("1,234");
  });
});

describe("what it asks for", () => {
  it("the address bar reaches the database as it is: search, sort and the page's offset", async () => {
    await page({ q: "  c1@  ", sort: "paid", page: "3" });
    const call = state.calls.find((c) => c.fn === "operator_customer_accounts");
    expect(call?.args).toEqual({ p_search: "c1@", p_sort: "paid", p_limit: PAGE_SIZE, p_offset: 2 * PAGE_SIZE });
    expect(state.calls.find((c) => c.fn === "operator_customer_daily")?.args).toEqual({ p_days: 30 });
    expect(state.calls.map((c) => c.fn).sort()).toEqual(["operator_customer_accounts", "operator_customer_daily", "operator_customer_totals"]);
  });

  it("a typed sort or page the database would refuse becomes the default instead", async () => {
    await page({ sort: "email; drop", page: "-4" });
    const call = state.calls.find((c) => c.fn === "operator_customer_accounts");
    expect(call?.args).toEqual({ p_search: null, p_sort: "spent_total", p_limit: PAGE_SIZE, p_offset: 0 });
  });
});

describe("what it shows", () => {
  it("the headline numbers, each from the database", async () => {
    const html = await page();
    for (const text of ["1,234", "1,100", "320.5", "$12.00", "625"]) expect(html).toContain(text);
    expect(has(html, "+3 in 7 days · +5 in 30 days")).toBe(true);
    expect(has(html, "5 of them on hold right now")).toBe(true);
    expect(has(html, en.customers.figPaidSub)).toBe(true);
  });

  it("a payment in another currency is said apart, never added to the dollars", async () => {
    state.totals = ok([totalsRow({ payments_other_currency: 2 })]);
    state.accounts = ok([account({ paid_usd: 0, payments_other_currency: 1 })]);
    const html = await page();
    expect(has(html, "2 more payments in another currency are not added here")).toBe(true);
    expect(has(html, "+1 in another currency")).toBe(true);
    expect(html).toContain("$0.00");
  });

  it("a workspace row: person, plan, spend, balance with what is on hold, bought with what was granted, failures", async () => {
    const html = await page();
    for (const text of ["Opslab C1 Studio", "c1@example.test", "Pro", "585", "5 on hold", "+100 granted", "2 failed"]) {
      expect(has(html, text), text).toBe(true);
    }
    expect(has(html, `${en.customers.colLastSignIn}: ${en.customers.cellNever}`)).toBe(true);
    expect(has(html, fmt(en.customers.countLine, "1"))).toBe(true);
  });

  it("no credit account is said in words, never as a 0 balance", async () => {
    state.accounts = ok([account({ balance: null, reserved: null, owner_email: null })]);
    const html = await page();
    expect(has(html, en.customers.cellNoAccount)).toBe(true);
    expect(has(html, en.customers.cellNoEmail)).toBe(true);
    expect(html).not.toContain(">585<");
  });

  it("the day list is newest first, with a bar only where there is something", async () => {
    const html = await page();
    expect(html.indexOf("2026-11-12")).toBeLessThan(html.indexOf("2026-11-11"));
    expect(html).toContain("width:100%");
    expect(html).toContain("width:50%");
  });

  it("the lists are named ruled lists that stack on a phone, so nothing scrolls sideways", async () => {
    const html = await page();
    expect(html.match(/<div class="g4-table-wrap"><table class="g4-table" role="table"><caption class="sr-only">/g)).toHaveLength(2);
    expect(html).not.toContain("overflow-x-auto");
  });

  it("search is a GET form on the page's own address, and it keeps the chosen sort", async () => {
    const html = await page({ q: "c1", sort: "balance" });
    const form = html.match(/<form [^>]*>/)?.[0] ?? "";
    expect(form).toContain('role="search"');
    expect(form).toContain('action="/chronos/customers"');
    expect(form).toContain('method="get"');
    expect(html).toContain('name="q"');
    expect(html).toContain('value="c1"');
    expect(html).toContain('<input type="hidden" name="sort" value="balance"/>');
    // the sort links go back to page 1 and keep the search
    expect(html).toContain('href="/chronos/customers?q=c1&amp;sort=paid"');
  });

  it("pages: next and previous only where they lead somewhere", async () => {
    state.accounts = ok([account({ total_count: 2 * PAGE_SIZE + 1 })]);
    const first = await page();
    expect(has(first, "Page 1 of 3")).toBe(true);
    expect(first).toContain('href="/chronos/customers?page=2"');
    expect(first).not.toContain('rel="prev"');
    const last = await page({ page: "3" });
    expect(has(last, "Page 3 of 3")).toBe(true);
    expect(last).toContain('rel="prev"');
    expect(last).not.toContain('rel="next"');
  });
});

describe("states", () => {
  it("no workspaces at all is the empty state", async () => {
    state.accounts = ok([]);
    const html = await page();
    expect(has(html, en.customers.empty)).toBe(true);
  });

  it("a search that finds nothing says what was searched", async () => {
    state.accounts = ok([]);
    const html = await page({ q: "nobody" });
    expect(has(html, "No workspace matches “nobody”.")).toBe(true);
  });

  it("a page past the end says so and links to the first page", async () => {
    state.accounts = ok([]);
    const html = await page({ page: "9" });
    expect(has(html, en.customers.pastEnd)).toBe(true);
    expect(html).toContain('href="/chronos/customers"');
  });

  it.each(["totals", "daily", "accounts"] as const)("a failed %s read is the error state with Retry, never numbers", async (which) => {
    state[which] = { data: null, error: { code: "XX000", message: "boom" } };
    const html = await page();
    expect(has(html, en.customers.readFailed)).toBe(true);
    expect(has(html, en.common.retry)).toBe(true);
    expect(html).not.toContain("1,234");
    expect(html).not.toContain("Opslab");
  });

  it("a headline row missing a figure is a failed read, not a 0", async () => {
    state.totals = ok([totalsRow({ credits_spent_total: null })]);
    const html = await page();
    expect(has(html, en.customers.readFailed)).toBe(true);
  });

  it("a response that is not a list is a failed read too", async () => {
    state.accounts = ok({ not: "a list" });
    const html = await page();
    expect(has(html, en.customers.readFailed)).toBe(true);
  });

  it("a deployment without 0138 says it is not applied", async () => {
    state.daily = { data: null, error: { code: "PGRST202", message: "Could not find the function public.operator_customer_daily" } };
    const html = await page();
    expect(has(html, en.customers.notEnabled)).toBe(true);
    expect(has(html, en.customers.readFailed)).toBe(false);
  });
});

describe("copy", () => {
  it("says what each figure holds: paid includes API balance top-ups, bought and granted are gross, people is every account", async () => {
    const html = await page();
    for (const text of [en.customers.rulePaid, en.customers.ruleGross, en.customers.ruleScope]) expect(has(html, text), text).toBe(true);
    expect(en.customers.rulePaid).toMatch(/API balance top-ups/);
    expect(en.customers.ruleGross).toMatch(/gross/);
    expect(en.customers.figBoughtSub).toMatch(/^Gross/);
    expect(en.customers.figGrantedSub).toMatch(/^Gross/);
    // the operator's own accounts ARE in "People": the copy must not say the platform is left out of every number
    expect(en.customers.ruleScope).not.toMatch(/in none of these numbers/);
    expect(en.customers.ruleScope).toMatch(/every account/);
    expect(uz.customers.rulePaid).toContain("USD\u2019da");
  });

  it("the refusal and the subtitle use no role words and no hint of who may open it, in any language", () => {
    const roleWords = /owner|admin|editor|viewer|operator|владел|админ|редактор|наблюдател|оператор|egasi|administrator|muharrir|operator/i;
    for (const d of [en, ru, uz]) {
      expect(d.customers.forbidden).not.toMatch(roleWords);
      expect(d.customers.subtitle).not.toMatch(roleWords);
    }
  });

  it("names no vendor and no superlative", () => {
    const vendors = /paddle|stripe|supabase|github|openai|google|elevenlabs|kling|runway|fal\b|replicate/i;
    const superlatives = /eng (yaxshi|zoʻr|zo'r|tez|arzon|kuchli)|самый|лучш|best|fastest|cheapest/i;
    for (const d of [en, ru, uz]) {
      for (const [k, v] of Object.entries(d.customers)) {
        expect(v, k).not.toMatch(vendors);
        expect(v, k).not.toMatch(superlatives);
      }
    }
  });

  it("is complete in English, Russian and Uzbek, with the same placeholders, and Uzbek comes first in its own words", () => {
    const keys = Object.keys(en.customers).sort();
    expect(Object.keys(ru.customers).sort()).toEqual(keys);
    expect(Object.keys(uz.customers).sort()).toEqual(keys);
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of keys as (keyof typeof en.customers)[]) {
      expect(placeholders(ru.customers[k]), `ru.${k}`).toEqual(placeholders(en.customers[k]));
      expect(placeholders(uz.customers[k]), `uz.${k}`).toEqual(placeholders(en.customers[k]));
      expect(ru.customers[k].trim(), `ru.${k}`).not.toBe("");
      expect(uz.customers[k].trim(), `uz.${k}`).not.toBe("");
    }
    expect(uz.nav.customers).toBe("Mijozlar");
    expect(ru.nav.customers).not.toBe(en.nav.customers);
  });
});

function fmt(s: string, n: string) {
  return s.replace("{n}", n);
}
