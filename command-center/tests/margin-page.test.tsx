/**
 * The Margin page (migration 0063), rendered against a scripted Supabase.
 *
 * What would break without these: a customer reaching the operator's margin
 * through the page, an unpriced cost rendered as $0.00 (a loss looking like a
 * profit), a failed read rendered as an empty report, and a deployment without
 * 0063 reported as broken instead of "not applied".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { esc } from "./helpers/supabaseStub";
import { isOperatorOnlySection, sectionAllowed } from "../lib/navigation";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  operator: true,
  report: { data: [] as unknown, error: null as null | { code?: string; message?: string } },
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/chronos/margin" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: unknown) => {
      state.calls.push({ fn, args });
      return fn === "operator_margin_report" ? state.report : { data: null, error: null };
    },
  }),
  getUser: async () => ({ id: "u1", email: "me@example.com" }),
}));
vi.mock("@/lib/auth/org-roles", () => ({ isOperator: async () => state.operator }));

const raw = (over: Record<string, unknown> = {}) => ({
  day: "2026-05-10", model: "m-paid", capability: "t2i", jobs_completed: 1, jobs_released: 0, jobs_internal: 0,
  credits_sold: 10, credits_released: 0, credits_paid: 10, credits_free: 0, credits_unvalued: 0,
  revenue_usd: 0.12, provider_usd: 0.04, provider_usd_released: 0, jobs_uncosted: 0, jobs_released_uncosted: 0,
  margin_usd: 0.08, margin_pct: 66.67, flags: [], ...over,
});

async function page(days?: string): Promise<string> {
  const mod = await import("../app/(app)/[channel]/margin/page");
  const el = (await mod.default({ searchParams: Promise.resolve({ days }) })) as ReactElement;
  return renderToStaticMarkup(el);
}
const has = (html: string, text: string) => html.includes(esc(text));

beforeEach(() => {
  state.operator = true;
  state.report = { data: [raw()], error: null };
  state.calls.length = 0;
});

describe("who may open it", () => {
  it("is an operator-only section, so the rail and the layout keep customers out", () => {
    expect(isOperatorOnlySection("margin")).toBe(true);
    expect(sectionAllowed("margin", false)).toBe(false);
    expect(sectionAllowed("margin", true)).toBe(true);
  });

  it("a customer who reaches the URL gets the refusal and the database is never asked", async () => {
    state.operator = false;
    const html = await page();
    expect(has(html, en.margin.forbidden)).toBe(true);
    expect(state.calls.find((c) => c.fn === "operator_margin_report")).toBeUndefined();
    expect(html).not.toContain("m-paid");
  });

  it("when the database itself refuses (42501) the page says so, not 'empty'", async () => {
    state.report = { data: null, error: { code: "42501", message: "platform admin only" } };
    const html = await page();
    expect(has(html, en.margin.forbidden)).toBe(true);
    expect(has(html, en.margin.empty)).toBe(false);
  });
});

describe("what it shows", () => {
  it("asks for the chosen period, in UTC dates, and only that", async () => {
    await page("7");
    const call = state.calls.find((c) => c.fn === "operator_margin_report");
    expect(call).toBeDefined();
    const args = call!.args as { p_from: string; p_to: string };
    expect(Object.keys(args).sort()).toEqual(["p_from", "p_to"]);
    expect((Date.parse(args.p_to) - Date.parse(args.p_from)) / 86_400_000).toBe(6);
  });

  it("an unpriced cost reads 'unpriced' and no dollar figure stands in for it", async () => {
    state.report = {
      data: [raw({ model: "m-unpriced", provider_usd: null, margin_usd: null, margin_pct: null, jobs_uncosted: 1, flags: ["unpriced_cost"] })],
      error: null,
    };
    const html = await page();
    // in the row's cost cell and in the total, as a word...
    expect(html).toMatch(/Provider cost<\/div><div class="t-figure[^"]*">unpriced</);
    expect(html).toMatch(/text-\[var\(--color-warn\)\]">unpriced<\/span><\/td>/);
    // ...and no dollar figure for the cost anywhere (the known $0.1200 revenue is not one)
    expect(html).not.toContain("$0.0400");
    expect(html).not.toContain("$0.0000");
    expect(has(html, en.margin.flag_unpriced_cost)).toBe(true);
    // the totals say so too, instead of a partial sum
    expect(has(html, en.margin.sumUnpriced.replace("{n}", "1"))).toBe(true);
  });

  it("a known sale shows its revenue, cost and margin", async () => {
    const html = await page();
    for (const text of ["$0.1200", "$0.0400", "66.7%", "m-paid", "t2i"]) expect(html).toContain(text);
    expect(html).not.toContain(">unpriced<");
  });

  it("failed jobs are flagged apart, with the cost they still ran up", async () => {
    state.report = {
      data: [raw({ jobs_released: 2, credits_released: 12, provider_usd_released: 0.05, flags: ["released_jobs"] })],
      error: null,
    };
    const html = await page();
    expect(has(html, en.margin.flag_released_jobs)).toBe(true);
    expect(html).toContain("$0.0500");
    expect(html).toContain("12");
  });

  it("free credits are not shown as revenue, and no revenue is not 'unpriced'", async () => {
    state.report = {
      data: [raw({ revenue_usd: 0, credits_paid: 0, credits_free: 10, margin_usd: -0.04, margin_pct: null, flags: ["free_credits"] })],
      error: null,
    };
    const html = await page();
    expect(has(html, en.margin.noRevenue)).toBe(true);
    expect(has(html, en.margin.flag_free_credits)).toBe(true);
  });
});

describe("states", () => {
  it("an empty period is the empty state, with the period switch still there", async () => {
    state.report = { data: [], error: null };
    const html = await page();
    expect(has(html, en.margin.empty)).toBe(true);
    expect(html).toContain("?days=7");
  });

  it("a failed read is the error state with Retry, never an empty report", async () => {
    state.report = { data: null, error: { code: "XX000", message: "boom" } };
    const html = await page();
    expect(has(html, en.margin.readFailed)).toBe(true);
    expect(has(html, en.margin.empty)).toBe(false);
    expect(has(html, en.common.retry)).toBe(true);
  });

  it("a response that is not a list is a failed read too", async () => {
    state.report = { data: { not: "a list" }, error: null };
    const html = await page();
    expect(has(html, en.margin.readFailed)).toBe(true);
  });

  it("a deployment without 0063 says it is not applied", async () => {
    state.report = { data: null, error: { code: "PGRST202", message: "Could not find the function public.operator_margin_report" } };
    const html = await page();
    expect(has(html, en.margin.notEnabled)).toBe(true);
    expect(has(html, en.margin.readFailed)).toBe(false);
  });
});

describe("copy", () => {
  it("is complete in English, Russian and Uzbek, with the same placeholders", () => {
    const keys = Object.keys(en.margin).sort();
    expect(Object.keys(ru.margin).sort()).toEqual(keys);
    expect(Object.keys(uz.margin).sort()).toEqual(keys);
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of keys as (keyof typeof en.margin)[]) {
      expect(placeholders(ru.margin[k]), `ru.${k}`).toEqual(placeholders(en.margin[k]));
      expect(placeholders(uz.margin[k]), `uz.${k}`).toEqual(placeholders(en.margin[k]));
      expect(ru.margin[k].trim(), `ru.${k}`).not.toBe("");
      expect(uz.margin[k].trim(), `uz.${k}`).not.toBe("");
    }
    expect(ru.nav.margin).not.toBe(en.nav.margin);
  });
});
