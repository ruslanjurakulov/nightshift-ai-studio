// @vitest-environment jsdom
/**
 * The Usage page's interactive half (components/usage/UsageView.tsx): the
 * extra-credits switch, and the words in all three languages.
 *
 * What would break: a switch that says "on" while the save failed (a person
 * then believes their packs are protected, or spendable, when they are not),
 * a switch that writes for someone who may not, a leftover {placeholder} or a
 * missing translation in ru / uz, an Upgrade link that opens a checkout, or a
 * tap target under 44px.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";

const rpc = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }), usePathname: () => "/chronos/usage" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc }) }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { UsageView } from "@/components/usage/UsageView";
import { coerceUsageSummary, type FreeGap, type UsageSummary } from "@/lib/usage";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-10-03T12:00:00Z");
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

function summary(over: Record<string, unknown> = {}): UsageSummary {
  const s = coerceUsageSummary({
    exempt: false,
    extra_enabled: true,
    plan: { id: "creator", name: "Creator", monthly_credits: 2000, is_default: false },
    subscription: { status: "active", current_period_start: day(-9), current_period_end: day(21), cancel_at_period_end: false },
    plan_credits: { granted: 2000, spent: 1240, held: 180, left: 580, period_start: day(-9), period_end: day(21) },
    last_plan_period_end: day(21),
    extra_credits: { available: 500, soonest_expiry: day(300) },
    bonus_credits: { available: 100, soonest_expiry: null },
    spendable_now: 1180,
    run_slots: { exempt: false, limit: 2, active: 1 },
    entitlements: { concurrency: 2, queue_priority: 1, api_access: true },
    ...over,
  });
  if (!s) throw new Error("fixture");
  return s;
}

const GAPS: FreeGap[] = [{ key: "credits" }, { key: "concurrency", free: 1, best: 4 }, { key: "queue_priority" }, { key: "api_access" }];

function view(locale: Locale, props: Partial<React.ComponentProps<typeof UsageView>> = {}) {
  return render(
    <I18nProvider locale={locale}>
      <UsageView summary={summary()} nowMs={NOW} orgId={ORG} canChange canBuy canUpgrade={false} gaps={GAPS} {...props} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  rpc.mockReset();
  refresh.mockReset();
});
afterEach(cleanup);

describe("the extra-credits switch", () => {
  it("is on by default, and pressing it saves through the database function and refreshes the page", async () => {
    rpc.mockResolvedValue({ data: { use_extra_credits: false, changed: true }, error: null });
    view("en");
    const sw = screen.getByRole("switch", { name: dictionaries.en.usage.extra.toggleLabel });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("set_use_extra_credits", { p_org: ORG, p_on: false }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("goes back when the save fails, and says so", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "nope" } });
    view("en");
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(dictionaries.en.usage.extra.saveFailed));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("goes back when the answer is not the value that was asked for", async () => {
    rpc.mockResolvedValue({ data: { use_extra_credits: true, changed: false }, error: null });
    view("en");
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(dictionaries.en.usage.extra.saveFailed));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("is disabled, and writes nothing, for someone who does not run the workspace", () => {
    view("en", { canChange: false });
    const sw = screen.getByRole("switch") as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    fireEvent.click(sw);
    expect(rpc).not.toHaveBeenCalled();
    expect(screen.getByText(dictionaries.en.usage.extra.adminOnly)).toBeTruthy();
  });

  it("shows the saved state of a switch that is off", () => {
    view("en", { summary: summary({ extra_enabled: false, spendable_now: 680 }) });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(dictionaries.en.usage.extra.waitingOff)).toBeTruthy();
  });

  it("the whole row is a 56px key, not a small toggle", () => {
    const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
    expect(css).toMatch(/\.usage-switch\s*{[^}]*min-height:\s*56px/);
  });
});

describe("what the page offers", () => {
  const hrefs = () => Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href"));

  it("Buy credits and Upgrade plan are plain links to the Credits page; there is no checkout here", () => {
    view("en", { canBuy: true, canUpgrade: true });
    expect(hrefs()).toEqual(["/chronos/credits#topups", "/chronos/credits#plans"]);
    expect(screen.getByRole("link", { name: dictionaries.en.usage.extra.buy })).toBeTruthy();
    expect(document.querySelector("form, iframe, input")).toBeNull();
  });

  it("offers neither when neither can be followed", () => {
    view("en", { canBuy: false, canUpgrade: false });
    expect(hrefs()).toEqual([]);
  });

  it("the meters are real meters with a spoken reading", () => {
    view("en");
    const meters = screen.getAllByRole("meter");
    expect(meters.map((m) => m.getAttribute("aria-label"))).toEqual([dictionaries.en.usage.plan.meterLabel, dictionaries.en.usage.limits.meterLabel]);
    expect(meters[0].getAttribute("aria-valuetext")).toContain("62%");
    expect(meters[0].getAttribute("aria-valuetext")).toContain("1,240");
  });
});

describe.each(["en", "ru", "uz"] as const)("in %s", (locale) => {
  const states: [string, UsageSummary, Partial<React.ComponentProps<typeof UsageView>>][] = [
    ["a subscriber", summary(), { canBuy: true, canUpgrade: true }],
    ["all plan credits used, extra off", summary({ extra_enabled: false, plan_credits: { granted: 2000, spent: 2000, held: 0, left: 0, period_start: day(-9), period_end: day(21) }, spendable_now: 100 }), {}],
    ["nothing spendable", summary({ extra_enabled: false, bonus_credits: { available: 0, soonest_expiry: null }, plan_credits: { granted: 2000, spent: 2000, held: 0, left: 0, period_start: day(-9), period_end: day(21) }, spendable_now: 0 }), {}],
    ["an expired period", summary({ plan_credits: null, last_plan_period_end: day(-2) }), {}],
    ["no credits yet", summary({ plan_credits: null, last_plan_period_end: null }), {}],
    ["a plan that ends", summary({ subscription: { status: "active", current_period_end: day(5), cancel_at_period_end: true } }), {}],
    [
      "Free",
      summary({ plan: { id: "free", name: "Free", monthly_credits: 0, is_default: true }, subscription: null, plan_credits: null, last_plan_period_end: null, extra_credits: { available: 0, soonest_expiry: null } }),
      { canUpgrade: true },
    ],
  ];

  it.each(states)("%s: no leftover placeholder, no 'undefined' or 'NaN'", (_name, s, props) => {
    const { container } = view(locale, { summary: s, ...props });
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[{}]/);
    expect(text).not.toMatch(/undefined|NaN|null/);
    expect(text.length).toBeGreaterThan(40);
  });

  it("every Usage string exists (key parity is the type; this is the words)", () => {
    const flat = (o: unknown, p = ""): string[] =>
      o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => flat(v, `${p}.${k}`)) : typeof o === "string" ? [`${p}=${o}`] : [];
    const mine = flat(dictionaries[locale].usage);
    const en = flat(dictionaries.en.usage);
    expect(mine.map((x) => x.split("=")[0])).toEqual(en.map((x) => x.split("=")[0]));
    for (const entry of mine) expect(entry.split("=").slice(1).join("=").trim().length, entry).toBeGreaterThan(1);
  });

  it("uses the same placeholders as English in every string", () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const walk = (a: unknown, b: unknown, path: string) => {
      if (typeof a === "string" && typeof b === "string") {
        // {unit} is the English / Russian credit word; Uzbek writes "kredit" in the sentence.
        const strip = (n: string[]) => n.filter((x) => x !== "unit");
        expect(strip(names(b)), `${locale} ${path}`).toEqual(strip(names(a)));
      } else if (a && b && typeof a === "object" && typeof b === "object") {
        for (const k of Object.keys(a)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      }
    };
    walk(dictionaries.en.usage, dictionaries[locale].usage, "usage");
  });
});
