// @vitest-environment jsdom
/**
 * The plan dialog a refused generation opens (lib/upsell.ts,
 * components/studio/PlanUpsellDialog.tsx), and the voice tools in the
 * customer sidebar.
 *
 * What would break: a plan card for something no plan unlocks (a `paid` model
 * opens on the first credit PURCHASE, which a subscription is not; a
 * `planned` entitlement is not checked yet), a price or limit that is not in
 * the data, a dialog that loads the payment provider or posts to a payment
 * route when it opens, or a link to a page that does not exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { coercePlanCatalog, coerceBillingSummary, type PlanEnv } from "@/lib/plans";
import {
  UPSELL_CODES,
  UPSELL_LINKS,
  grants,
  isUpsellCode,
  parseEntitlement,
  refusalFrom,
  upsellCatalog,
  upsellView,
  type UpsellCatalog,
} from "@/lib/upsell";
import { CUSTOMER_SIDEBAR, STUDIO_TOOLS, sectionAllowed, sidebarCurrent } from "@/lib/navigation";
import { CREATIVE_ERRORS } from "@/lib/creative/operations";
import { errorAction, prefillFromQuery, withTiers, type StudioModel } from "@/lib/creative/studio";

const en = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const ROOT = process.cwd();
const withI18n = (ui: ReactNode, locale: Locale = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

// The catalog as 0034 seeds it (concurrency enforced, model tiers planned).
const PLAN_ROWS = [
  { id: "free", name: "Free", sort_order: 0, monthly_credits: 0, is_default: true, is_public: true },
  { id: "creator", name: "Creator", sort_order: 1, monthly_credits: 1000, is_default: false, is_public: true },
  { id: "pro", name: "Pro", sort_order: 2, monthly_credits: 3000, is_default: false, is_public: true },
  { id: "studio", name: "Studio", sort_order: 3, monthly_credits: 9000, is_default: false, is_public: true },
];
const KEY_ROWS = [
  { key: "concurrency", value_type: "int", default_value: 1, exempt_value: 1000, status: "enforced", sort_order: 10 },
  { key: "api_access", value_type: "bool", default_value: false, exempt_value: true, status: "enforced", sort_order: 30 },
  { key: "models_video", value_type: "tier", default_value: "basic", exempt_value: "all", status: "planned", sort_order: 41 },
];
const VALUE_ROWS = [
  { plan_id: "free", key: "concurrency", value: 1 },
  { plan_id: "creator", key: "concurrency", value: 2 },
  { plan_id: "creator", key: "api_access", value: true },
  { plan_id: "creator", key: "models_video", value: "premium" },
  { plan_id: "pro", key: "concurrency", value: 4 },
  { plan_id: "pro", key: "api_access", value: true },
  { plan_id: "pro", key: "models_video", value: "all" },
  { plan_id: "studio", key: "concurrency", value: 8 },
  { plan_id: "studio", key: "api_access", value: true },
  { plan_id: "studio", key: "models_video", value: "all" },
];
const ENV: PlanEnv = {
  NEXT_PUBLIC_PADDLE_PLAN_CREATOR: "pri_01plancreator000000000000",
  NEXT_PUBLIC_PADDLE_PLAN_PRO: "pri_01planpro00000000000000000",
  NEXT_PUBLIC_PADDLE_PLAN_STUDIO: "pri_01planstudio0000000000000",
  NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: "$10",
};
const PADDLE = { environment: "sandbox" as const, clientToken: "test_token_public" };
const CATALOG = coercePlanCatalog(PLAN_ROWS, KEY_ROWS, VALUE_ROWS);
const summary = (planId: string, limit: number | null) =>
  coerceBillingSummary({
    exempt: false,
    plan: { id: planId, name: planId, monthly_credits: PLAN_ROWS.find((p) => p.id === planId)?.monthly_credits ?? 0, is_default: planId === "free" },
    subscription: null,
    credits: { subscription: 0, pack: 0, other: 0, held: 0 },
    run_slots: limit === null ? null : { limit, active: limit },
  });
const DATA = upsellCatalog(CATALOG, "ok", summary("free", 1), ENV, PADDLE, false) as UpsellCatalog;

const PAYMENT = /paddle|checkout|billing|portal|subscribe|transaction/i;

describe("upsellCatalog: only what this deployment can sell, priced only from the data", () => {
  it("offers the paid plans with a checkout, the owner's display price or none, never the free plan", () => {
    expect(DATA.plans?.map((p) => p.id)).toEqual(["creator", "pro", "studio"]);
    expect(DATA.plans?.map((p) => p.price)).toEqual(["$10", null, null]);
    expect(DATA.currentPlanId).toBe("free");
    expect(DATA.runLimit).toBe(1);
    // No price id reaches the browser.
    expect(JSON.stringify(DATA)).not.toMatch(/pri_/);
  });

  it("offers nothing without a checkout (Paddle not configured), and nothing to an exempt organization", () => {
    expect(upsellCatalog(CATALOG, "ok", summary("free", 1), ENV, null, false)?.plans).toEqual([]);
    expect(upsellCatalog(CATALOG, "ok", null, ENV, PADDLE, true)).toBeNull();
  });

  it("a failed read is unknown (plans: null), never an empty offer", () => {
    expect(upsellCatalog(null, "failed", null, ENV, PADDLE, false)?.plans).toBeNull();
    expect(upsellCatalog(null, "unsupported", null, ENV, PADDLE, false)?.plans).toEqual([]);
  });
});

describe("upsellView: what unlocks what, as the database decides it", () => {
  const r = (code: (typeof UPSELL_CODES)[number], body: unknown = {}) => refusalFrom(code, body);

  it("run_limit_reached: plans with more runs at once than the refusal's limit, the current one left out", () => {
    const v = upsellView(r("run_limit_reached", { active: 2, limit: 2 }), undefined, { ...DATA, currentPlanId: "creator" });
    expect(v.reason).toBe("run_limit");
    expect(v.limit).toBe(2);
    expect(v.plans.map((p) => p.id)).toEqual(["pro", "studio"]);
    expect(v.highlight?.key).toBe("concurrency");
    expect(v.buyCredits).toBe(false);
  });

  it("run_limit_reached without figures falls back to the summary's limit, and offers nothing when neither is known", () => {
    expect(upsellView(r("run_limit_reached"), undefined, DATA).plans.map((p) => p.id)).toEqual(["creator", "pro", "studio"]);
    const unknown = upsellView(r("run_limit_reached"), undefined, { ...DATA, runLimit: null });
    expect(unknown.limit).toBeNull();
    expect(unknown.plans).toEqual([]);
  });

  it("a `paid` model opens on the first credit purchase: Buy credits, and no plan (a subscription is not a purchase)", () => {
    const v = upsellView(r("entitlement_required"), "paid", DATA);
    expect(v).toMatchObject({ reason: "first_purchase", buyCredits: true, plans: [] });
    // The database's own sentence stands in when the model's entitlement was not read.
    const d = upsellView(r("entitlement_required", { detail: "x is available after the organization's first credit purchase" }), undefined, DATA);
    expect(d.reason).toBe("first_purchase");
  });

  it("an enforced entitlement lists the plans that grant it; a planned one lists none", () => {
    const api = upsellView(r("entitlement_required"), "api_access", DATA);
    expect(api.reason).toBe("plan_feature");
    expect(api.plans.map((p) => p.id)).toEqual(["creator", "pro", "studio"]);
    // models_video is `planned` in 0034: no plan opens it today, so none is offered.
    const tier = upsellView(r("entitlement_required"), "models_video:premium", DATA);
    expect(tier).toMatchObject({ reason: "not_open", plans: [], buyCredits: false });
    expect(upsellView(r("entitlement_required"), "nonsense key!", DATA).reason).toBe("not_open");
  });

  it("insufficient_credits: Buy credits first, then plans with a larger monthly allowance", () => {
    const v = upsellView(r("insufficient_credits", { available: 3, needed: 6 }), undefined, { ...DATA, currentPlanId: "creator", currentMonthlyCredits: 1000 });
    expect(v).toMatchObject({ reason: "credits", buyCredits: true, available: 3, needed: 6 });
    expect(v.plans.map((p) => p.id)).toEqual(["pro", "studio"]);
  });

  it("figures that are not numbers are unknown, never 0", () => {
    expect(refusalFrom("insufficient_credits", { available: "3", needed: null })).toMatchObject({ available: null, needed: null });
    expect(refusalFrom("run_limit_reached", "nope")).toMatchObject({ active: null, limit: null });
  });

  it("reads entitlements the way 0034 does", () => {
    expect(parseEntitlement("models_video:premium")).toEqual({ key: "models_video", value: "premium" });
    expect(parseEntitlement("api_access")).toEqual({ key: "api_access", value: null });
    expect(parseEntitlement("Bad Key")).toBeNull();
    expect(grants("tier", "all", "premium")).toBe(true);
    expect(grants("tier", "basic", "premium")).toBe(false);
    expect(grants("tier", "basic", null)).toBe(true);
    expect(grants("tier", "none", null)).toBe(false);
    expect(grants("bool", true, null)).toBe(true);
    expect(grants("bool", false, null)).toBe(false);
    expect(grants("int", 4, "3")).toBe(true);
    expect(grants("int", 2, "3")).toBe(false);
  });

  it("the three codes are real route codes, and the panel offers the dialog for each", () => {
    for (const c of UPSELL_CODES) {
      expect(CREATIVE_ERRORS).toContain(c);
      expect(isUpsellCode(c)).toBe(true);
      expect(errorAction(c)).not.toBeNull();
    }
    expect(isUpsellCode("failed")).toBe(false);
  });

  it("carries the model's entitlement from sellable_models() onto the Studio's models", () => {
    const models: StudioModel[] = [{ id: "m1", displayName: "M1", capabilities: ["t2i"], beta: false }];
    expect(withTiers(models, [{ id: "m1", entitlement: "paid", spec: {} }])[0].entitlement).toBe("paid");
    expect(withTiers(models, [{ id: "m1", entitlement: "", spec: {} }])[0].entitlement).toBeNull();
  });
});

// ── the panel: a refused Generate opens the dialog ─────────────────────────

const MODELS: StudioModel[] = [
  { id: "pro-image", displayName: "Pro Image", capabilities: ["t2i"], beta: false, entitlement: "paid" },
];

let fetchMock: ReturnType<typeof vi.fn>;
let refuse: { status: number; body: Record<string, unknown> };
beforeEach(() => {
  refuse = { status: 403, body: { error: "entitlement_required" } };
  fetchMock = vi.fn((url: string) => {
    if (url === "/api/creative/quote") return json({ quote: { credits: 6 } });
    if (url === "/api/creative/jobs") return json(refuse.body, refuse.status);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

async function refusedGenerate(data: UpsellCatalog | null = DATA, locale: Locale = "en") {
  render(
    withI18n(
      <GeneratePanel orgId={ORG} models={MODELS} plans={data} initial={{ capability: "t2i", model: "", prompt: "a lighthouse", aspect: "16:9", duration: 5 }} />,
      locale,
    ),
  );
  const t = dictionaries[locale];
  const button = await screen.findByRole("button", { name: new RegExp(t.gen.generatePriced.replace("{n}", "6").replace(/[·]/g, ".")) }, { timeout: 3000 });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  const before = fetchMock.mock.calls.length;
  fireEvent.click(button);
  return { button, before };
}

const fetchedUrls = () => fetchMock.mock.calls.map((c) => String(c[0]));

describe("the plan dialog in the Studio", () => {
  it("entitlement_required on a `paid` model: one line naming the model, Buy credits, Compare plans — and no payment call", async () => {
    const { before } = await refusedGenerate();
    const dialog = await screen.findByRole("dialog", { name: en.upsell.titleModel });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain(en.upsell.firstPurchase.replace("{model}", "Pro Image"));
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(dialog).getByRole("link", { name: en.upsell.buyCredits }).getAttribute("href")).toBe("/chronos/credits#topups");
    expect(within(dialog).getByRole("link", { name: new RegExp(en.upsell.compare) }).getAttribute("href")).toBe("/pricing");
    // Opening it fetched nothing: only the job that was refused was posted.
    expect(fetchedUrls().slice(before)).toEqual(["/api/creative/jobs"]);
    expect(fetchedUrls().filter((u) => PAYMENT.test(u))).toEqual([]);
    expect(document.querySelector('script[src*="paddle"]')).toBeNull();
  });

  it("run_limit_reached: the plan's limit from the refusal and the plans with more at once", async () => {
    refuse = { status: 429, body: { error: "run_limit_reached", active: 2, limit: 2 } };
    await refusedGenerate({ ...DATA, currentPlanId: "creator", currentMonthlyCredits: 1000, runLimit: 2 });
    const dialog = await screen.findByRole("dialog", { name: en.upsell.titleRunLimit });
    expect(dialog.textContent).toContain(en.upsell.runLimit.replace("{limit}", "2"));
    const cards = within(dialog).getAllByRole("listitem");
    expect(cards.map((c) => c.getAttribute("data-plan"))).toEqual(["pro", "studio"]);
    expect(cards[0].textContent).toContain(en.upsell.runsAtOnce.replace("{n}", "4"));
    expect(cards[0].textContent).toContain(en.upsell.priceAtCheckout);
    const choose = within(cards[0]).getByRole("link", { name: en.upsell.choose.replace("{plan}", "Pro") });
    expect(choose.getAttribute("href")).toBe("/chronos/credits#plans");
    expect(within(dialog).queryByRole("link", { name: en.upsell.buyCredits })).toBeNull();
    expect(fetchedUrls().filter((u) => PAYMENT.test(u))).toEqual([]);
  });

  it("insufficient_credits: the database's figures, Buy credits first, then plans with more credits", async () => {
    refuse = { status: 402, body: { error: "insufficient_credits", available: 3, needed: 6 } };
    await refusedGenerate();
    const dialog = await screen.findByRole("dialog", { name: en.upsell.titleCredits });
    expect(dialog.textContent).toContain(en.upsell.credits.replace("{needed}", "6").replace("{available}", "3"));
    const buy = within(dialog).getByRole("link", { name: en.upsell.buyCredits });
    expect(buy.getAttribute("href")).toBe("/chronos/credits#topups");
    expect(document.activeElement).toBe(buy);
    const cards = within(dialog).getAllByRole("listitem");
    expect(cards.map((c) => c.getAttribute("data-plan"))).toEqual(["creator", "pro", "studio"]);
    expect(cards[0].textContent).toContain("$10");
    // Nothing the plan data does not hold: no yearly price, discount or trial.
    expect(dialog.textContent).not.toMatch(/year|annual|%|trial|save/i);
  });

  it("Escape closes it and focus returns to Generate; Tab stays inside; See plans opens it again", async () => {
    refuse = { status: 429, body: { error: "run_limit_reached", active: 1, limit: 1 } };
    const { button } = await refusedGenerate();
    const dialog = await screen.findByRole("dialog");
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
    focusable[focusable.length - 1].focus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(document.body.style.overflow).toBe("");

    fireEvent.click(screen.getByRole("button", { name: en.upsell.seePlans }));
    const again = await screen.findByRole("dialog", { name: en.upsell.titleRunLimit });
    expect(again.textContent).toContain(en.upsell.runLimit.replace("{limit}", "1"));
    fireEvent.click(within(again).getByRole("button", { name: en.upsell.notNow }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an organization that never pays gets the message only, no dialog", async () => {
    refuse = { status: 402, body: { error: "insufficient_credits", available: 0, needed: 6 } };
    await refusedGenerate(null);
    await screen.findByText(en.creative.errors.insufficient_credits);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("other refusals open nothing", async () => {
    refuse = { status: 502, body: { error: "failed" } };
    await refusedGenerate();
    await screen.findByText(en.creative.errors.failed);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["ru", "uz"] as const)("speaks %s", async (locale) => {
    const u = dictionaries[locale].upsell;
    refuse = { status: 429, body: { error: "run_limit_reached", active: 2, limit: 2 } };
    await refusedGenerate(DATA, locale);
    const dialog = await screen.findByRole("dialog", { name: u.titleRunLimit });
    expect(dialog.textContent).toContain(u.runLimit.replace("{limit}", "2"));
    expect(within(dialog).getByRole("link", { name: new RegExp(u.compare) })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: u.close })).toBeTruthy();
  });
});

describe("the dialog's links go to pages that exist", () => {
  it("Credits (#plans, #topups) and /pricing are real routes and anchors", () => {
    expect(existsSync(path.join(ROOT, "app/(app)/[channel]/credits/page.tsx"))).toBe(true);
    expect(existsSync(path.join(ROOT, "app/pricing/page.tsx"))).toBe(true);
    expect(readFileSync(path.join(ROOT, "components/credits/PlanPanel.tsx"), "utf8")).toContain('id="plans"');
    expect(readFileSync(path.join(ROOT, "components/credits/BuyCredits.tsx"), "utf8")).toContain('id="topups"');
    expect(UPSELL_LINKS.plans.split("#")[0]).toBe("/credits");
    expect(sectionAllowed("credits", false)).toBe(true);
  });

  it("the dialog's source never touches the payment client or a payment route", () => {
    const src = [
      readFileSync(path.join(ROOT, "components/studio/PlanUpsellDialog.tsx"), "utf8"),
      readFileSync(path.join(ROOT, "lib/upsell.ts"), "utf8"),
    ].join("\n");
    expect(src).not.toMatch(/paddle-client|ensurePaddle|Checkout\.open|fetch\(/);
  });
});

describe("the voice tools in the customer sidebar", () => {
  it("lists Change voice and Dub / translate in the Create group, each opening its tool", () => {
    const tools = CUSTOMER_SIDEBAR.tools.map((t) => t.tool);
    // The voice tools follow the picture tools; Describe (0055) comes last.
    expect(tools.slice(-3)).toEqual(["voice_change", "dub", "describe"]);
    expect(CUSTOMER_SIDEBAR.tools.find((t) => t.tool === "voice_change")?.href).toBe("/create?tool=voice_change");
    expect(CUSTOMER_SIDEBAR.tools.find((t) => t.tool === "dub")?.href).toBe("/create?tool=dub");
    expect(en.gen.kinds.voice_change).toBe("Change voice");
    expect(en.gen.kinds.dub).toBe("Dub / translate");
    expect(sidebarCurrent("/create", "dub")).toBe("tool:dub");
  });

  it("every sidebar href is a screen a customer may open", () => {
    const hrefs = [
      CUSTOMER_SIDEBAR.home,
      ...CUSTOMER_SIDEBAR.work,
      ...CUSTOMER_SIDEBAR.footer,
      ...CUSTOMER_SIDEBAR.tools,
    ].map((i) => i.href);
    for (const h of hrefs) expect(sectionAllowed(h.slice(1).split("?")[0], false), h).toBe(true);
  });

  it("the links only fill the form: the tool, no recording, no voice or language picked", () => {
    for (const tool of ["voice_change", "dub"] as const) {
      const q = new URL(`/create?tool=${tool}`, "https://x").searchParams;
      const p = prefillFromQuery(q.get("tool") ?? undefined, q.get("source") ?? undefined);
      expect(p).toMatchObject({ capability: tool, prompt: "", model: "", sourceId: null });
      expect(p?.voiceId ?? null).toBeNull();
      expect(p?.targetLanguage ?? null).toBeNull();
    }
    // A malformed recording id is refused, never passed on.
    expect(prefillFromQuery("dub", "../etc")).toBeNull();
    expect(STUDIO_TOOLS).toContain("voice_change");
  });

  it("each tool tile has its colour token", () => {
    const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    for (const tool of STUDIO_TOOLS) expect(css, tool).toContain(`--tool-${tool}:`);
  });
});

describe("i18n parity for the plan dialog", () => {
  const flat = (o: unknown, prefix = ""): Record<string, string> =>
    Object.entries(o as Record<string, unknown>).reduce<Record<string, string>>((acc, [k, v]) => {
      if (typeof v === "string") acc[prefix + k] = v;
      else Object.assign(acc, flat(v, `${prefix}${k}.`));
      return acc;
    }, {});
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

  it("ru and uz have every key en has, with the same placeholders, none empty", () => {
    const base = flat(en.upsell);
    for (const locale of ["ru", "uz"] as const) {
      const other = flat(dictionaries[locale].upsell);
      expect(Object.keys(other).sort(), locale).toEqual(Object.keys(base).sort());
      for (const [k, v] of Object.entries(base)) {
        expect(other[k].trim(), `${locale}.${k}`).not.toBe("");
        expect(holes(other[k]), `${locale}.${k}`).toEqual(holes(v));
      }
      // Translated, not copied.
      expect(other.titleCredits).not.toBe(base.titleCredits);
      expect(other.buyCredits).not.toBe(base.buyCredits);
    }
  });
});
