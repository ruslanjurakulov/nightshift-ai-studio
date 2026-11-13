// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * The "Add credits" sheet and the purchase history on the Credits page, when Dodo sells. What would break without these:
 * "Credits to add" or "Total" saying something other than what the webhook will credit and Dodo will charge; an amount
 * outside $5–$300 reaching the server; the key not saying "Processing…" (a second press opening a second checkout);
 * "Auto recharge" looking like something that works; a pack's "+N% credits" drifting from the two catalogs; the history
 * inventing a status, an item or an amount; an invoice refusal leaving the person with nothing to do.
 */

const h = vi.hoisted(() => ({ assigned: [] as string[], refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/my-channel/credits",
  useRouter: () => ({ push: vi.fn(), refresh: h.refresh, back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (section: string) => `/my-channel${section}` }));
vi.mock("@/components/view-mode/frame-nav", () => ({
  assignTop: (url: string) => {
    h.assigned.push(url);
  },
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { DodoBuyCredits } from "@/components/credits/DodoBuyCredits";
import { DodoPurchaseHistory } from "@/components/credits/DodoPurchaseHistory";
import { DODO_CATALOG_PACKS, dodoView, packBonusPercent, resolveDodoServer } from "@/lib/dodo";
import { coercePurchaseRows, purchaseItem, purchaseStatus, type DodoHistoryRead } from "@/lib/dodo-history";

const t = dictionaries.en;
const ac = t.addCredits;
const ENV = {
  DODO_PAYMENTS_API_KEY: "dodo_test_" + "k".repeat(32),
  DODO_PRODUCT_STARTER: "pdt_0NVbdIG3JNg9Yc8ey5JHW",
  DODO_PRODUCT_CREATOR: "pdt_CREATORpack0000000000",
  DODO_PRODUCT_STUDIO: "pdt_STUDIOpack00000000000",
  DODO_PRODUCT_AMOUNT: "pdt_PWYWamount0000000000",
  DODO_METADATA_SECRET: "cc-metadata-secret-0123456789abcdef-xyz",
};
const view = dodoView(resolveDodoServer(ENV))!;
const packsOnly = dodoView(resolveDodoServer({ ...ENV, DODO_PRODUCT_AMOUNT: "" }))!;

let fetchCalls: { url: string; body: unknown }[] = [];
let answer: () => Promise<Response> = async () => new Response(JSON.stringify({ url: "https://test.checkout.dodopayments.com/session/cks_1" }), { status: 200 });
beforeEach(() => {
  h.assigned.length = 0;
  fetchCalls = [];
  answer = async () => new Response(JSON.stringify({ url: "https://test.checkout.dodopayments.com/session/cks_1" }), { status: 200 });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return answer();
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSheet(v = view) {
  return render(
    <I18nProvider locale="en">
      <DodoBuyCredits view={v} balance={100} />
    </I18nProvider>,
  );
}

const sheet = () => document.querySelector("[data-add-credits]") as HTMLElement;
const creditsToAdd = () => (document.querySelector("[data-credits-to-add]") as HTMLElement).textContent;
const totalText = () => (document.querySelector("[data-total]") as HTMLElement).textContent;
const input = () => screen.getByLabelText(ac.customLabel) as HTMLInputElement;
const submitKey = () => within(sheet()).getByRole("button", { name: new RegExp(`^(${ac.submit}|${ac.processing})`) }) as HTMLButtonElement;

describe("the Add credits sheet", () => {
  it("opens on the one-time tab with $10 chosen: 1,000 credits, $10.00, and the bounds shown", () => {
    renderSheet();
    expect(screen.getByRole("heading", { name: ac.title })).toBeTruthy();
    expect(screen.getByRole("tab", { name: ac.tabOnce }).getAttribute("aria-selected")).toBe("true");
    const presets = within(sheet()).getAllByRole("button", { pressed: false }).concat(within(sheet()).getAllByRole("button", { pressed: true }));
    expect(presets.map((b) => b.textContent).sort()).toEqual(["$10", "$100", "$20", "$50"]);
    expect(creditsToAdd()).toContain("1,000");
    expect(totalText()).toBe("$10.00");
    expect(sheet().textContent).toContain("Minimum $5, maximum $300");
    expect(sheet().textContent).toContain(ac.taxNote);
  });

  it("follows a preset and a typed amount live, in exactly the webhook's arithmetic", () => {
    renderSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "$50" }));
    expect([creditsToAdd(), totalText()]).toEqual(["5,000", "$50.00"]);
    expect(within(sheet()).getByRole("button", { name: "$50" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(input(), { target: { value: "25.5" } });
    expect([creditsToAdd(), totalText()]).toEqual(["2,550", "$25.50"]);
    fireEvent.change(input(), { target: { value: "300" } });
    expect([creditsToAdd(), totalText()]).toEqual(["30,000", "$300.00"]);
  });

  it("says what is wrong with an amount, and the key cannot be pressed", () => {
    renderSheet();
    const cases: [string, string][] = [
      ["4.99", "The minimum is $5."],
      ["300.01", "The maximum is $300 per payment."],
      ["25.555", ac.invalid.format],
      ["", ac.invalid.empty],
    ];
    for (const [value, message] of cases) {
      fireEvent.change(input(), { target: { value } });
      expect(screen.getByRole("alert").textContent).toBe(message);
      expect(submitKey().disabled).toBe(true);
      expect([creditsToAdd(), totalText()]).toEqual(["—", "—"]);
      expect(input().getAttribute("aria-invalid")).toBe("true");
    }
    fireEvent.click(submitKey());
    expect(fetchCalls).toEqual([]);
  });

  it("asks our server for the typed cents only, and says Processing… while it waits", async () => {
    let release: (r: Response) => void = () => {};
    answer = () => new Promise<Response>((resolve) => (release = resolve));
    renderSheet();
    fireEvent.change(input(), { target: { value: "25.50" } });
    await act(async () => {
      fireEvent.click(submitKey());
    });
    expect(fetchCalls).toEqual([{ url: "/api/billing/dodo/checkout", body: { kind: "amount", usd_cents: 2550, return_path: "/my-channel/credits" } }]);
    expect(submitKey().textContent).toContain(ac.processing);
    expect(submitKey().disabled).toBe(true);
    // A second press while it is opening opens nothing more.
    await act(async () => {
      fireEvent.click(submitKey());
    });
    expect(fetchCalls).toHaveLength(1);
    await act(async () => {
      release(new Response(JSON.stringify({ url: "https://test.checkout.dodopayments.com/session/cks_2" }), { status: 200 }));
    });
    expect(h.assigned).toEqual(["https://test.checkout.dodopayments.com/session/cks_2"]);
  });

  it("names the remedy when the checkout cannot open, and lets the person try again", async () => {
    answer = async () => new Response(JSON.stringify({ error: "too_many_checkouts" }), { status: 429 });
    renderSheet();
    await act(async () => {
      fireEvent.click(submitKey());
    });
    expect(screen.getByText(ac.tooMany)).toBeTruthy();
    answer = async () => new Response(JSON.stringify({ error: "not_on_sale" }), { status: 404 });
    await act(async () => {
      fireEvent.click(submitKey());
    });
    expect(screen.getByText(ac.notOnSale)).toBeTruthy();
    answer = async () => new Response(JSON.stringify({ error: "checkout_failed" }), { status: 502 });
    await act(async () => {
      fireEvent.click(submitKey());
    });
    expect(screen.getByText(t.creditsPage.loadFailed)).toBeTruthy();
    expect(submitKey().disabled).toBe(false);
    expect(h.assigned).toEqual([]);
  });

  it("Auto recharge says it is not available yet and why, with nothing to switch on", () => {
    renderSheet();
    fireEvent.click(screen.getByRole("tab", { name: ac.tabAuto }));
    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toContain(ac.autoChip);
    expect(panel.textContent).toContain(ac.autoBody);
    expect(within(panel).queryAllByRole("button")).toEqual([]);
    expect(within(panel).queryAllByRole("textbox")).toEqual([]);
    expect(within(panel).queryAllByRole("checkbox")).toEqual([]);
    expect(within(panel).queryAllByRole("switch")).toEqual([]);
  });

  it("calls it credits, never a wallet or a dollar balance", () => {
    const { container } = renderSheet();
    expect(container.textContent).not.toMatch(/wallet/i);
    for (const lang of [dictionaries.ru.addCredits, dictionaries.uz.addCredits]) expect(JSON.stringify(lang)).not.toMatch(/кошел|hamyon/i);
  });

  it("keeps the packs as the better-value cards, each with the extra credits the catalogs give", () => {
    const { container } = renderSheet();
    expect(container.textContent).toContain(ac.packsTitle);
    expect(container.textContent).toContain("+11% credits");
    expect(container.textContent).toContain("+25% credits");
    expect(DODO_CATALOG_PACKS.map((p) => packBonusPercent(p))).toEqual([null, 11, 25]);
    // Buying a pack still names the pack, never an amount.
    expect(screen.getAllByRole("button", { name: new RegExp(t.creditsPage.buy) })).toHaveLength(3);
  });

  it("is not there without the PWYW product: the panel is the packs, as before, with no bonus chips", () => {
    const { container } = renderSheet(packsOnly);
    expect(document.querySelector("[data-add-credits]")).toBeNull();
    expect(screen.getByRole("heading", { name: t.creditsPage.packsTitle })).toBeTruthy();
    expect(container.textContent).not.toContain("+11%");
  });

  it("is written in all three languages", () => {
    for (const key of Object.keys(ac) as (keyof typeof ac)[]) {
      expect(dictionaries.ru.addCredits[key], key).toBeTruthy();
      expect(dictionaries.uz.addCredits[key], key).toBeTruthy();
    }
    for (const lang of ["ru", "uz"] as const) {
      expect(dictionaries[lang].addCredits.submit).not.toBe(ac.submit);
      expect(dictionaries[lang].addCredits.history.status.paid).not.toBe(ac.history.status.paid);
    }
  });
});

describe("the purchase history", () => {
  const rows = coercePurchaseRows([
    { payment_id: "pay_Amount000000000001", item: "pack:amount_2500", credits: "2500.00", amount_minor: 2700, currency: "USD", paid_at: "2026-11-13T10:00:00Z", refunded_minor: 1350, refund_unsized: false, chargeback: false },
    { payment_id: "pay_Starter00000000001", item: "pack:starter", credits: 1000, amount_minor: 1080, currency: "USD", paid_at: "2026-11-12T10:00:00Z", refunded_minor: 0, refund_unsized: false, chargeback: false },
    { payment_id: "pay_Plan00000000000001", item: "plan", credits: 6000, amount_minor: 5292, currency: "USD", paid_at: "2026-11-11T10:00:00Z", refunded_minor: 5292, refund_unsized: false, chargeback: false },
    { payment_id: "pay_Unknown0000000001", item: null, credits: null, amount_minor: null, currency: null, paid_at: null, refunded_minor: 0, refund_unsized: false, chargeback: false },
    { payment_id: "not-a-payment", item: "pack:starter" },
  ]);

  function renderHistory(read: DodoHistoryRead) {
    return render(
      <I18nProvider locale="en">
        <DodoPurchaseHistory read={read} />
      </I18nProvider>,
    );
  }

  it("reads only what the database gave: a status from recorded refunds, an item from the signed item, unknown as unknown", () => {
    expect(rows.map((r) => r.paymentId)).toEqual(["pay_Amount000000000001", "pay_Starter00000000001", "pay_Plan00000000000001", "pay_Unknown0000000001"]);
    expect(rows.map((r) => r.status)).toEqual(["partly_refunded", "paid", "refunded", "paid"]);
    expect(rows.map((r) => r.item)).toEqual([{ kind: "amount", cents: 2500 }, { kind: "pack", id: "starter" }, { kind: "plan" }, null]);
    expect(rows[0].credits).toBe(2500);
    expect(purchaseItem("pack:mega")).toBeNull();
    expect(purchaseItem("pack:amount_0100")).toBeNull();
    expect(purchaseStatus(1080, 0, true, false)).toBe("refund_recorded");
    expect(purchaseStatus(null, 500, false, false)).toBe("refund_recorded");
    expect(purchaseStatus(1080, 1080, false, true)).toBe("chargeback");
  });

  it("shows each row with its date, item, credits, amount, status, payment id and an invoice key; unknowns as —", () => {
    renderHistory({ state: "ok", rows });
    const table = screen.getByRole("table");
    const body = within(table).getAllByRole("row").slice(1);
    expect(body).toHaveLength(4);
    expect(body[0].textContent).toContain(ac.history.itemAmount);
    expect(body[0].textContent).toContain("$27.00");
    expect(body[0].textContent).toContain(ac.history.status.partly_refunded);
    expect(body[1].textContent).toContain("Starter pack");
    expect(body[2].textContent).toContain(ac.history.itemPlan);
    expect(body[2].textContent).toContain(ac.history.status.refunded);
    const unknown = within(body[3]).getAllByRole("cell").map((c) => c.textContent);
    expect(unknown.slice(0, 4)).toEqual(["—", "—", "—", "—"]);
    expect(unknown[4]).toBe(ac.history.status.paid);
    expect(within(body[3]).getByRole("button", { name: ac.history.download })).toBeTruthy();
    expect(screen.getByText(ac.history.amountNote)).toBeTruthy();
  });

  it("says empty, unread and not-migrated as three different things", () => {
    renderHistory({ state: "ok", rows: [] });
    expect(screen.getByText(ac.history.empty)).toBeTruthy();
    cleanup();
    renderHistory({ state: "failed" });
    expect(screen.getByText(ac.history.readFailed)).toBeTruthy();
    expect(screen.queryByText(ac.history.empty)).toBeNull();
    cleanup();
    renderHistory({ state: "unsupported" });
    expect(screen.getByText(ac.history.notMigrated)).toBeTruthy();
    expect(screen.queryByText(ac.history.empty)).toBeNull();
  });

  it("fetches one invoice from our own route, says Preparing…, and names Dodo's limit when it is hit", async () => {
    let release: (r: Response) => void = () => {};
    answer = () => new Promise<Response>((resolve) => (release = resolve));
    renderHistory({ state: "ok", rows: rows.slice(1, 2) });
    const key = screen.getByRole("button", { name: ac.history.download });
    await act(async () => {
      fireEvent.click(key);
    });
    expect(fetchCalls.map((c) => c.url)).toEqual(["/api/billing/dodo/invoice?payment=pay_Starter00000000001"]);
    expect(screen.getByRole("button", { name: ac.history.preparing })).toBeTruthy();
    await act(async () => {
      release(new Response("slow down", { status: 429 }));
    });
    expect(screen.getByRole("alert").textContent).toBe(ac.history.invoiceError.rate_limited);
    // And it can be asked again.
    answer = async () => new Response("{}", { status: 404 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: ac.history.download }));
    });
    expect(screen.getByRole("alert").textContent).toBe(ac.history.invoiceError.not_found);
  });
});
