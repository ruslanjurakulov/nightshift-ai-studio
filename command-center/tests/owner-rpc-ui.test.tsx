// @vitest-environment jsdom
/**
 * The owner screens while NIGHTSHIFT_OWNER_RPC is on: grant (with its reason, limits, key and refusals), reversal,
 * prices (the explicit big-change step, the history and Restore), the team through the server, the Billing spend
 * panel and the read-only Security panel. And the other half of the promise: with the flag off (no `rpc` prop, no
 * `ownerRpc` prop) the old forms write the old way and never call /api/owner.
 *
 * Nothing is sent on the first tap; a double tap sends once; a retry reuses the request key; a refusal is shown in
 * the sheet in plain words with the keys live again; an unknown is never drawn as a zero.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { jsonRes } from "./helpers/response";
import { en } from "../lib/i18n/en";
import { parsePrices } from "../lib/credits";

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  upsert: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  members: [] as Record<string, unknown>[],
  refresh: vi.fn(),
  toast: vi.fn(),
}));

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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: h.toast, error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: vi.fn(),
    from: () => ({
      select: () => ({ order: async () => ({ data: h.members, error: null }) }),
      upsert: h.upsert,
      insert: h.insert,
      update: (v: unknown) => ({ eq: (...a: unknown[]) => h.update(v, ...a) }),
      delete: () => ({ eq: h.del }),
    }),
  }),
}));

import { OwnerGrantForm, type GrantLimits } from "../components/credits/OwnerGrantForm";
import { OwnerRecentGrants } from "../components/credits/OwnerRecentGrants";
import { OwnerPriceHistory } from "../components/credits/OwnerPriceHistory";
import { CreditPricesEditor } from "../components/credits/CreditPricesEditor";
import { MembersBoard } from "../components/members/MembersBoard";
import { ProviderSpendPanel } from "../components/billing/ProviderSpendPanel";
import { OwnerSecurityPanel } from "../components/security/OwnerSecurityPanel";
import { summarizeProviderSpend, type OwnerSecurity, type PriceHistoryEntry, type SecurityEvent } from "../lib/owner-reads";

const o = en.ownerRpc;
const ORG = "0b000000-0000-0000-0000-00000000000b";

beforeEach(() => {
  h.fetch.mockReset().mockImplementation(async () => jsonRes({ ok: true }));
  h.upsert.mockReset().mockResolvedValue({ error: null });
  h.insert.mockReset().mockResolvedValue({ error: null });
  h.update.mockReset().mockResolvedValue({ error: null });
  h.del.mockReset().mockResolvedValue({ error: null });
  h.refresh.mockReset();
  h.toast.mockReset();
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sheet = () => screen.getByRole("alertdialog");
const tap = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const sent = (n = 0) => {
  const [url, init] = h.fetch.mock.calls[n] as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
};

// ─── Granting ───────────────────────────────────────────────────────────────────────────────────

describe("OwnerGrantForm", () => {
  const LIMITS: GrantLimits = { perCall: 100000, per24h: 500000, granted24h: 120000, windowDays: 14 };
  const show = (limits = LIMITS) => render(<OwnerGrantForm orgId={ORG} orgName="Acme Studio" creditsPerUsd={100} limits={limits} />);
  const fill = (amount: string, reason = "welcome gift for the pilot") => {
    change(screen.getByLabelText(en.credits.grantAmount), amount);
    change(screen.getByPlaceholderText(o.grant.reasonPh), reason);
  };
  const open = async () => tap(screen.getByRole("button", { name: en.credits.grant }));
  const confirmKey = () => within(sheet()).getByRole("button", { name: en.ownerSafety.grantConfirm });

  it("shows the limits before anything is typed, from the database's own numbers", () => {
    show();
    expect(screen.getByText("One grant: up to 100,000 credits")).toBeTruthy();
    expect(screen.getByText("Last 24 hours: 120,000 of 500,000 credits given")).toBeTruthy();
  });

  it("what was given in the last 24 hours, when unreadable, is not drawn as zero", () => {
    show({ ...LIMITS, granted24h: null });
    expect(screen.getByText(/could not be read/)).toBeTruthy();
    expect(screen.queryByText(/0 of 500,000/)).toBeNull();
  });

  it("limits that could not be read say so, and the server still enforces them", () => {
    show({ perCall: null, per24h: null, granted24h: null, windowDays: null });
    expect(screen.getByText(o.grant.capsUnknown)).toBeTruthy();
  });

  it("a reason shorter than 8 characters never opens the sheet and sends nothing", async () => {
    show();
    fill("500", "short");
    await open();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText(o.grant.reasonShort)).toBeTruthy();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("more than one grant may give is stopped on the screen, with the cap", async () => {
    show();
    fill("100001");
    await open();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText(o.grant.overCall.replace("{cap}", "100,000"))).toBeTruthy();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("the first tap only asks: the sheet names the organization, credits, reason and limits; nothing is sent", async () => {
    show();
    fill("2500");
    await open();
    const dlg = sheet();
    expect(dlg.textContent).toContain("Give 2,500 credits to “Acme Studio”?");
    expect(within(dlg).getByText("welcome gift for the pilot")).toBeTruthy();
    expect(within(dlg).getByText("100,000")).toBeTruthy();
    expect(within(dlg).getByText("380,000")).toBeTruthy(); // 500,000 - 120,000 left in the 24 hour limit
    expect(dlg.textContent).toContain("reverse this grant for 14 days");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("Cancel sends nothing and keeps what was typed", async () => {
    show();
    fill("2500");
    await open();
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(h.fetch).not.toHaveBeenCalled();
    expect((screen.getByLabelText(en.credits.grantAmount) as HTMLInputElement).value).toBe("2500");
  });

  it("a double tap on the confirm key is ONE request, to the server route, with the exact arguments and a valid key", async () => {
    let done: (r: Response) => void = () => {};
    h.fetch.mockImplementation(() => new Promise<Response>((r) => (done = r)));
    show();
    fill("2500");
    await open();
    const key = confirmKey();
    fireEvent.click(key);
    fireEvent.click(key);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const { url, body } = sent();
    expect(url).toBe("/api/owner/credits/grant");
    expect(body).toMatchObject({ org: ORG, credits: 2500, reason: "welcome gift for the pilot" });
    expect(String(body.key)).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    await act(async () => done(jsonRes({ ok: true, duplicate: false, balance: 2550, credits: 2500 })));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("2,500 credits given to “Acme Studio”. Balance: 2,550 credits.")).toBeTruthy();
    expect((screen.getByLabelText(en.credits.grantAmount) as HTMLInputElement).value).toBe("");
  });

  it("the database's answer 'duplicate' is said plainly: nothing was added twice", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: true, duplicate: true, balance: 2550, credits: 2500 }));
    show();
    fill("2500");
    await open();
    await tap(confirmKey());
    expect(screen.getByText("That request had already gone through: nothing was added twice. Balance: 2,550 credits.")).toBeTruthy();
  });

  it("every refusal is shown in the sheet in plain words with the figures, and the key works again", async () => {
    h.fetch.mockImplementation(async () =>
      jsonRes({ ok: false, error: "daily_cap", granted_24h: 450000, requested: 100000, cap: 500000 }, 422),
    );
    show();
    fill("5000");
    await open();
    await tap(confirmKey());
    const alert = within(sheet()).getByRole("alert").textContent ?? "";
    expect(alert).toContain("450,000");
    expect(alert).toContain("500,000");
    expect(alert).toContain("Nothing was changed");
    expect(h.refresh).not.toHaveBeenCalled();
    expect(confirmKey().hasAttribute("disabled")).toBe(false);
  });

  it.each([
    [{ ok: false, error: "mfa_required" }, 401, o.err.mfa_required],
    [{ ok: false, error: "rate_limited" }, 429, o.err.rate_limited],
    [{ ok: false, error: "exempt_org" }, 422, o.err.exempt_org],
    [{ ok: false, error: "key_reused" }, 422, o.err.key_reused],
    [{ ok: false, error: "balance_limit" }, 422, o.err.balance_limit],
    [{ error: "unauthorized" }, 401, en.ownerTruth.sessionEnded],
  ])("%j (%i) reads as its own sentence", async (body, status, text) => {
    h.fetch.mockImplementation(async () => jsonRes(body, status));
    show();
    fill("10");
    await open();
    await tap(confirmKey());
    expect(within(sheet()).getByRole("alert").textContent).toContain(text);
  });

  it("a dropped connection says to look at the history first (it may have gone through)", async () => {
    h.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    show();
    fill("10");
    await open();
    await tap(confirmKey());
    expect(within(sheet()).getByRole("alert").textContent).toContain(en.ownerTruth.checkBeforeRetry);
  });

  it("a retry of the SAME grant reuses the request key, even after the sheet was closed", async () => {
    h.fetch.mockImplementationOnce(async () => jsonRes({ ok: false, error: "rpc_failed" }, 502));
    show();
    fill("10");
    await open();
    await tap(confirmKey()); // fails: the answer never says whether it went through
    await tap(confirmKey()); // the same sheet again
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(sent(0).body.key).toBe(sent(1).body.key);

    cleanup();
    h.fetch.mockReset().mockImplementationOnce(async () => jsonRes({ ok: false, error: "rpc_failed" }, 502)).mockImplementation(async () => jsonRes({ ok: true }));
    show();
    fill("10");
    await open();
    await tap(confirmKey());
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    await open(); // the same grant, a second sheet
    await tap(confirmKey());
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(sent(0).body.key).toBe(sent(1).body.key);
  });

  it("a different amount or a different reason is a different grant and gets a new key", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: false, error: "rpc_failed" }, 502));
    show();
    fill("10");
    await open();
    await tap(confirmKey());
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    fill("11");
    await open();
    await tap(confirmKey());
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    fill("11", "a different reason entirely");
    await open();
    await tap(confirmKey());
    const keys = h.fetch.mock.calls.map((_c, i) => sent(i).body.key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  it("a large grant must be typed back before the key works", async () => {
    show();
    fill("6000");
    await open();
    expect(confirmKey().hasAttribute("disabled")).toBe(true);
    change(within(sheet()).getByRole("textbox"), "6000");
    expect(confirmKey().hasAttribute("disabled")).toBe(false);
  });
});

// ─── Reversing ──────────────────────────────────────────────────────────────────────────────────

describe("OwnerRecentGrants", () => {
  const grants = [
    { id: 31, amount: 500, createdAt: "2026-10-17T10:00:00Z", note: "owner grant: pilot", reversed: false },
    { id: 30, amount: 100, createdAt: "2026-10-16T10:00:00Z", note: null, reversed: true },
  ];
  const show = (g: typeof grants | null = grants, failed = false) => render(<OwnerRecentGrants orgName="Acme Studio" grants={g} windowDays={14} failed={failed} />);

  it("a grant that already has a reversal says so and offers nothing", () => {
    show();
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[1]).getByText(o.grant.reversedTag)).toBeTruthy();
    expect(within(rows[1]).queryByRole("button")).toBeNull();
    expect(within(rows[0]).getByRole("button", { name: /^Reverse the grant of 500 credits$/ })).toBeTruthy();
  });

  it("each Reverse button names its amount, and says which form it opens", async () => {
    show();
    const btn = screen.getByRole("button", { name: "Reverse the grant of 500 credits" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-controls")).toBe("reverse-form-31");
    await tap(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("reverse-form-31")).toBeTruthy();
  });

  it("the reason is counted in characters, not UTF-16 units: eight emoji are enough", async () => {
    show();
    await tap(screen.getByRole("button", { name: /^Reverse the grant of 500/ }));
    change(screen.getByPlaceholderText(o.grant.reasonPh), "😀".repeat(8));
    expect(screen.getByText("8 / 300")).toBeTruthy();
    expect(screen.getByRole("button", { name: o.grant.reverseReview }).hasAttribute("disabled")).toBe(false);
    change(screen.getByPlaceholderText(o.grant.reasonPh), "😀".repeat(7));
    expect(screen.getByRole("button", { name: o.grant.reverseReview }).hasAttribute("disabled")).toBe(true);
  });

  it("an unreadable list offers nothing as reversible", () => {
    show(null, true);
    expect(screen.queryByRole("button", { name: /^Reverse the grant of 500 credits$/ })).toBeNull();
    expect(screen.getByText(o.grant.recentFailed)).toBeTruthy();
  });

  it("an empty window is said, not drawn as an error", () => {
    show([]);
    expect(screen.getByText("No grants in the last 14 days.")).toBeTruthy();
  });

  it("Reverse needs a reason first, then a sheet; only the sheet's key calls the server, once", async () => {
    let done: (r: Response) => void = () => {};
    h.fetch.mockImplementation(() => new Promise<Response>((r) => (done = r)));
    show();
    await tap(screen.getByRole("button", { name: /^Reverse the grant of 500 credits$/ }));
    const review = screen.getByRole("button", { name: o.grant.reverseReview });
    expect(review.hasAttribute("disabled")).toBe(true);
    change(screen.getByPlaceholderText(o.grant.reasonPh), "given twice by mistake");
    await tap(review);
    const dlg = sheet();
    expect(dlg.textContent).toContain("Take back 500 credits from “Acme Studio”?");
    expect(h.fetch).not.toHaveBeenCalled();
    const key = within(dlg).getByRole("button", { name: o.grant.reverseConfirm });
    fireEvent.click(key);
    fireEvent.click(key);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual({ url: "/api/owner/credits/reverse", body: { transactionId: 31, reason: "given twice by mistake" } });
    await act(async () => done(jsonRes({ ok: true, duplicate: false, granted: 500, reversed: 320, shortfall: 180, balance: 20 })));
    expect(screen.getByText("Took back 320 of 500 credits. 180 had already been spent and stays as a shortfall.")).toBeTruthy();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("a refusal (too old, nothing left, already reversed) shows in the sheet", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: false, error: "too_old", window_days: 14 }, 422));
    show();
    await tap(screen.getByRole("button", { name: /^Reverse the grant of 500 credits$/ }));
    change(screen.getByPlaceholderText(o.grant.reasonPh), "given twice by mistake");
    await tap(screen.getByRole("button", { name: o.grant.reverseReview }));
    await tap(within(sheet()).getByRole("button", { name: o.grant.reverseConfirm }));
    expect(within(sheet()).getByRole("alert").textContent).toContain("older than 14 days");
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

// ─── Prices ─────────────────────────────────────────────────────────────────────────────────────

describe("CreditPricesEditor through the server", () => {
  const prices = Object.values(parsePrices([{ unit: "custom_thing", credits_per_unit: 1, margin: 0, updated_at: null }]));
  const show = () => render(<CreditPricesEditor prices={prices} canEdit rpc={{ maxRatio: 3 }} />);
  const fillPrice = (rate: string, margin = "0") => {
    change(screen.getByPlaceholderText(en.credits.unitPh), "custom_thing");
    change(screen.getByPlaceholderText(en.credits.ratePh), rate);
    change(screen.getByPlaceholderText(en.credits.marginPh), margin);
  };
  const save = async () => tap(screen.getByRole("button", { name: en.credits.savePrice }));

  it("a small change is the ordinary sheet and goes to the server without the big-change confirm", async () => {
    show();
    fillPrice("1.2");
    await save();
    expect(sheet().textContent).toContain("Change the price of “custom_thing”?");
    expect(h.fetch).not.toHaveBeenCalled();
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.priceSaveConfirm }));
    expect(sent()).toEqual({ url: "/api/owner/prices", body: { action: "set", unit: "custom_thing", rate: 1.2, margin: 0, confirm: false } });
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("a big change is an explicit step: old and new, the ratio and the limit are shown and the figure must be typed", async () => {
    show();
    fillPrice("5");
    await save();
    const dlg = sheet();
    expect(dlg.textContent).toContain("Big price change: “custom_thing”?");
    expect(within(dlg).getAllByText("1 → 5")).toHaveLength(2); // the rate and what the customer pays
    expect(within(dlg).getByText("rate ×5, charged ×5")).toBeTruthy();
    expect(within(dlg).getByText("3× up or down")).toBeTruthy();
    const key = within(dlg).getByRole("button", { name: o.prices.bigConfirm });
    expect(key.hasAttribute("disabled")).toBe(true);
    change(within(dlg).getByRole("textbox"), "5");
    await tap(key);
    expect(sent().body).toMatchObject({ action: "set", rate: 5, confirm: true });
  });

  it("a rate of zero is big too, and asks for a word because a zero is not worth typing", async () => {
    show();
    fillPrice("0");
    await save();
    expect(sheet().textContent).toContain("Big price change");
    expect(sheet().textContent).toContain(en.ownerSafety.typeToConfirm.replace("{word}", o.prices.bigWord));
    change(within(sheet()).getByRole("textbox"), "confirm");
    await tap(within(sheet()).getByRole("button", { name: o.prices.bigConfirm }));
    expect(sent().body).toMatchObject({ rate: 0, confirm: true });
  });

  it("when the server calls it big and the screen did not (a stale page), the big-change sheet opens with the same typing; one more tap does not confirm it", async () => {
    h.fetch
      .mockImplementationOnce(async () => jsonRes({ ok: false, error: "confirm_required", reason: "ratio", rate_ratio: 4, charged_ratio: 4, max_ratio: 3 }, 409))
      .mockImplementation(async () => jsonRes({ ok: true }));
    show();
    fillPrice("1.2");
    await save();
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.priceSaveConfirm }));
    // the first sheet is gone; the big-change sheet is up, with the server's figures
    expect(sheet().textContent).toContain("Big price change");
    expect(sheet().textContent).toContain("rate ×4, charged ×4");
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
    const key = within(sheet()).getByRole("button", { name: o.prices.bigConfirm });
    expect(key.hasAttribute("disabled")).toBe(true);
    fireEvent.click(key);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    change(within(sheet()).getByRole("textbox"), "confirm");
    await tap(key);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(sent(0).body.confirm).toBe(false);
    expect(sent(1).body.confirm).toBe(true);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith("Price saved: custom_thing.");
  });

  it("cancelling the stale big-change sheet saves nothing", async () => {
    h.fetch.mockImplementationOnce(async () => jsonRes({ ok: false, error: "confirm_required", rate_ratio: 4, charged_ratio: 4, max_ratio: 3 }, 409));
    show();
    fillPrice("1.2");
    await save();
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.priceSaveConfirm }));
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("a plain save says so with a toast, once", async () => {
    show();
    fillPrice("1.2");
    await save();
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.priceSaveConfirm }));
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith("Price saved: custom_thing.");
  });

  it("the reason is optional and is sent when given", async () => {
    show();
    fillPrice("1.2");
    change(screen.getByPlaceholderText(o.prices.reasonPh), " supplier raised the price ");
    await save();
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.priceSaveConfirm }));
    expect(sent().body.reason).toBe("supplier raised the price");
  });

  it("delete is a sheet, then one server call that carries the confirm and NO leftover reason from the price form", async () => {
    show();
    change(screen.getByPlaceholderText(o.prices.reasonPh), "typed for a different price");
    const li = screen.getAllByRole("listitem").find((r) => r.textContent?.includes("custom_thing"))!;
    await tap(within(li).getByRole("button", { name: en.credits.removePrice }));
    expect(h.fetch).not.toHaveBeenCalled();
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.priceDeleteConfirm }));
    expect(sent()).toEqual({ url: "/api/owner/prices", body: { action: "delete", unit: "custom_thing", confirm: true } });
    expect(h.del).not.toHaveBeenCalled();
    // and the field is cleared after the action, so it cannot ride on the next one either
    expect((screen.getByPlaceholderText(o.prices.reasonPh) as HTMLInputElement).value).toBe("");
  });

  it("a refusal (bad rate, rate limited) is shown in the sheet", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: false, error: "rate_limited" }, 429));
    show();
    fillPrice("1.2");
    await save();
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.priceSaveConfirm }));
    expect(within(sheet()).getByRole("alert").textContent).toContain(o.err.rate_limited);
  });

  it("with the flag off (no rpc prop) the editor writes the table as before and never calls /api/owner", async () => {
    render(<CreditPricesEditor prices={prices} canEdit />);
    expect(screen.queryByPlaceholderText(o.prices.reasonPh)).toBeNull();
    fillPrice("1.2");
    await save();
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.priceSaveConfirm }));
    expect(h.upsert).toHaveBeenCalledWith({ unit: "custom_thing", credits_per_unit: 1.2, margin: 0 }, { onConflict: "unit" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("OwnerPriceHistory", () => {
  const prices = Object.values(parsePrices([{ unit: "custom_thing", credits_per_unit: 5, margin: 0, updated_at: null }]));
  const entry = (over: Partial<PriceHistoryEntry>): PriceHistoryEntry => ({
    id: 10, at: "2026-10-17T10:00:00Z", unit: "custom_thing", action: "set", oldRate: 1, oldMargin: 0, newRate: 5, newMargin: 0, reason: "raise", source: "rpc", ...over,
  });
  const show = (history: PriceHistoryEntry[] | null) => render(<OwnerPriceHistory history={history} prices={prices} maxRatio={3} />);

  it("lists old → new with the reason, marks a direct write, and offers Restore on the newest change of each service only", () => {
    show([entry({ id: 12, source: "direct", reason: null }), entry({ id: 11, oldRate: null, oldMargin: null, newRate: 1 }), entry({ id: 10 })]);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByRole("button", { name: /^Restore the previous price of custom_thing$/ })).toBeTruthy();
    expect(rows[0].textContent).toContain(o.prices.direct);
    expect(rows[0].textContent).toContain("1 → 5");
    expect(rows[1].textContent).toContain(`${o.prices.noPrice} → 1`);
    expect(within(rows[1]).queryByRole("button")).toBeNull();
    expect(within(rows[2]).queryByRole("button")).toBeNull();
  });

  it("Restore shows the price now and after, is a big-change sheet when the swing is big, and calls the server with the history id", async () => {
    show([entry({ id: 12 })]);
    await tap(screen.getByRole("button", { name: /^Restore the previous price of custom_thing$/ }));
    const dlg = sheet();
    expect(dlg.textContent).toContain("Put “custom_thing” back?");
    expect(within(dlg).getByText("5 → 5")).toBeTruthy(); // now
    expect(within(dlg).getByText("1 → 1")).toBeTruthy(); // after
    expect(h.fetch).not.toHaveBeenCalled();
    // 5 -> 1 is a fifth: past the 3x limit, so the typed word is asked for
    const key = within(dlg).getByRole("button", { name: o.prices.bigConfirm });
    expect(key.hasAttribute("disabled")).toBe(true);
    change(within(dlg).getByRole("textbox"), "confirm");
    await tap(key);
    expect(sent()).toEqual({ url: "/api/owner/prices", body: { action: "restore", historyId: 12, confirm: true } });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("restoring a change that created the price removes it, and says so", async () => {
    show([entry({ id: 12, oldRate: null, oldMargin: null, newRate: 5 })]);
    await tap(screen.getByRole("button", { name: /^Restore the previous price of custom_thing$/ }));
    expect(sheet().textContent).toContain("restoring removes it again");
  });

  it("when the server calls a restore big and the screen did not, the big-change sheet opens with the typed word; one more tap does not confirm", async () => {
    h.fetch
      .mockImplementationOnce(async () => jsonRes({ ok: false, error: "confirm_required", rate_ratio: 4, charged_ratio: 4, max_ratio: 3 }, 409))
      .mockImplementation(async () => jsonRes({ ok: true }));
    show([entry({ id: 12, oldRate: 4, oldMargin: 0, newRate: 5 })]); // 5 -> 4: not big on this screen
    await tap(screen.getByRole("button", { name: /^Restore the previous price of custom_thing$/ }));
    expect(sheet().textContent).not.toContain("Big price change");
    await tap(within(sheet()).getByRole("button", { name: o.prices.restoreConfirm }));
    expect(sheet().textContent).toContain("rate ×4, charged ×4");
    const key = within(sheet()).getByRole("button", { name: o.prices.bigConfirm });
    expect(key.hasAttribute("disabled")).toBe(true);
    fireEvent.click(key);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    change(within(sheet()).getByRole("textbox"), "confirm");
    await tap(key);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(sent(0).body.confirm).toBe(false);
    expect(sent(1).body.confirm).toBe(true);
    expect(h.toast).toHaveBeenCalledWith("Price restored: custom_thing.");
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("a price changed since the page loaded (price_changed) is refused in the sheet in plain words; nothing is restored", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: false, error: "price_changed" }, 409));
    show([entry({ id: 12, oldRate: 4, oldMargin: 0, newRate: 5 })]);
    await tap(screen.getByRole("button", { name: /^Restore the previous price of custom_thing$/ }));
    await tap(within(sheet()).getByRole("button", { name: o.prices.restoreConfirm }));
    expect(within(sheet()).getByRole("alert").textContent).toBe(o.err.price_changed);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("an unreadable history says so; an empty one says nothing happened yet", () => {
    show(null);
    expect(screen.getByText(o.prices.historyFailed)).toBeTruthy();
    cleanup();
    show([]);
    expect(screen.getByText(o.prices.historyEmpty)).toBeTruthy();
  });
});

// ─── Team ───────────────────────────────────────────────────────────────────────────────────────

describe("MembersBoard through the server", () => {
  const MEMBERS = [
    { id: "11111111-1111-4111-8111-111111111111", user_id: "u-me", email: "me@a.uz", role: "owner", created_at: "2026-01-01" },
    { id: "22222222-2222-4222-8222-222222222222", user_id: "u-b", email: "b@a.uz", role: "admin", created_at: "2026-01-02" },
    { id: "33333333-3333-4333-8333-333333333333", user_id: "u-c", email: "c@a.uz", role: "owner", created_at: "2026-01-03" },
  ];
  const row = (email: string) => screen.getAllByRole("listitem").find((r) => r.textContent?.includes(email))!;
  // "Role" also labels the legend section, so pick the select.
  const addRole = () => screen.getAllByLabelText(en.members.addRole).find((el) => el.tagName === "SELECT")!;
  const show = (ownerRpc: boolean) => {
    h.members = MEMBERS;
    return render(<MembersBoard myRole="owner" myEmail="me@a.uz" myUserId="u-me" ownerRpc={ownerRpc} />);
  };

  it("remove: the sheet first, then ONE call to /api/owner/team; the table is not written", async () => {
    show(true);
    await act(async () => {});
    await tap(within(row("b@a.uz")).getByRole("button", { name: en.members.remove }));
    expect(h.fetch).not.toHaveBeenCalled();
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.memberRemoveConfirm }));
    expect(sent()).toEqual({ url: "/api/owner/team", body: { action: "remove", member: MEMBERS[1].id } });
    expect(h.del).not.toHaveBeenCalled();
  });

  it("change role goes through the server with the member id", async () => {
    show(true);
    await act(async () => {});
    fireEvent.change(within(row("b@a.uz")).getByRole("combobox"), { target: { value: "viewer" } });
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.roleChangeConfirm }));
    expect(sent()).toEqual({ url: "/api/owner/team", body: { action: "role", member: MEMBERS[1].id, role: "viewer" } });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("add (an admin, with a sheet) goes through the server; the table is not written", async () => {
    show(true);
    await act(async () => {});
    change(screen.getByLabelText(en.members.addEmail), "New@A.uz");
    change(addRole(), "admin");
    await tap(screen.getByRole("button", { name: en.members.add }));
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.memberAddConfirm }));
    expect(sent()).toEqual({ url: "/api/owner/team", body: { action: "add", email: "new@a.uz", role: "admin" } });
    expect(h.insert).not.toHaveBeenCalled();
  });

  it.each([
    ["last_owner", o.err.last_owner],
    ["self_change", o.err.self_change],
    ["owner_required", o.err.owner_required],
    ["no_such_member", o.err.no_such_member],
  ])("the server's refusal %s is worded in the sheet", async (error, text) => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: false, error }, 422));
    show(true);
    await act(async () => {});
    await tap(within(row("b@a.uz")).getByRole("button", { name: en.members.remove }));
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.memberRemoveConfirm }));
    expect(within(sheet()).getByRole("alert").textContent).toBe(text);
  });

  it("adding a viewer (no sheet) shows the refusal inline: already_member and bad_email", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: false, error: "already_member" }, 422));
    show(true);
    await act(async () => {});
    change(screen.getByLabelText(en.members.addEmail), "b@a.uz");
    change(addRole(), "viewer");
    await tap(screen.getByRole("button", { name: en.members.add }));
    expect(screen.getByRole("alert").textContent).toBe(o.err.already_member);
  });

  it("with the flag off the board writes app_members as before and never calls /api/owner", async () => {
    show(false);
    await act(async () => {});
    await tap(within(row("b@a.uz")).getByRole("button", { name: en.members.remove }));
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.memberRemoveConfirm }));
    expect(h.del).toHaveBeenCalledWith("id", MEMBERS[1].id);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

// ─── Billing and Security panels ────────────────────────────────────────────────────────────────

const spendRow = (over: Record<string, unknown>) => ({
  day: "2026-10-17", provider: "elevenlabs", usd: 1, usdPriced: 1, unpricedRows: 0, units: 1000, unit: "tts_characters", runs: 1, ...over,
});

describe("ProviderSpendPanel", () => {
  const panel = (rows: ReturnType<typeof spendRow>[]) => (
    <ProviderSpendPanel state="ok" summary={summarizeProviderSpend(rows as never)} days={30} />
  );

  it("shows a priced provider's total with its name as the Billing page writes it", () => {
    render(panel([spendRow({ usd: 3.5 })]));
    expect(screen.getByText("ElevenLabs")).toBeTruthy();
    expect(screen.getAllByText("$3.50").length).toBeGreaterThan(0);
  });

  it("unpriced is unknown, with 'at least' for the priced part, and never $0", () => {
    const { container } = render(panel([spendRow({ provider: "kling", usd: null, usdPriced: null, unpricedRows: 4, units: 4, unit: "video_gen_clips" })]));
    expect(screen.getAllByText(o.spend.unknown).length).toBeGreaterThan(0);
    expect(screen.getAllByText("4 rows have no price").length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/\$0\.\d/);
    cleanup();
    const partial = render(panel([spendRow({ usd: null, usdPriced: 2, unpricedRows: 1 })]));
    expect(partial.container.textContent).toContain("at least $2.00");
  });

  it("an unpriced provider whose row count is unknown says unknown and invents no count", () => {
    const { container } = render(panel([spendRow({ provider: "kling", usd: null, usdPriced: null, unpricedRows: null, units: 4, unit: "video_gen_clips" })]));
    expect(screen.getAllByText(o.spend.unknown).length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/\\d+ rows? (has|have) no price/);
    expect(container.textContent).not.toContain("0 rows");
  });

  it("the title and the groups call the figures estimates, never what a provider charged or billed", () => {
    const { container } = render(panel([spendRow({ usd: 3.5 }), spendRow({ provider: "render", usd: 9, usdPriced: 9 })]));
    expect(screen.getByText(o.spend.title)).toBeTruthy();
    expect(o.spend.title).toMatch(/Estimated/);
    expect(o.spend.billedTitle).toMatch(/estimated/);
    expect(container.textContent?.toLowerCase()).not.toMatch(/charged us|billed by/);
  });

  it("our own estimates are listed apart from the bills, with their plain names", () => {
    render(panel([spendRow({ usd: 3.5 }), spendRow({ provider: "render", usd: 99, usdPriced: 99 })]));
    expect(screen.getByText(o.spend.billedTitle)).toBeTruthy();
    expect(screen.getByText(o.spend.estimatesTitle)).toBeTruthy();
    expect(screen.getByText("Rendering")).toBeTruthy();
  });

  it("failed, unsupported and empty each say so, with no figure", () => {
    const { container, rerender } = render(<ProviderSpendPanel state="failed" summary={null} days={30} />);
    expect(screen.getByText(o.spend.failed)).toBeTruthy();
    expect(container.textContent).not.toMatch(/\$[\d,]+\.\d\d/);
    rerender(<ProviderSpendPanel state="unsupported" summary={null} days={30} />);
    expect(screen.getByText(o.spend.unsupported)).toBeTruthy();
    rerender(<ProviderSpendPanel state="ok" summary={summarizeProviderSpend([])} days={30} />);
    expect(screen.getByText(o.spend.empty)).toBeTruthy();
  });
});

describe("OwnerSecurityPanel", () => {
  const SEC: OwnerSecurity = {
    gateOn: false,
    recentMfaMinutes: 480,
    grantMaxPerCall: 100000,
    grantMax24h: 500000,
    priceMaxRatio: 3,
    reverseWindowDays: 14,
    caller: { passes: true, why: "gate_off", aal: "aal1", hasVerifiedFactor: false },
    wouldBlockAfterEnable: true,
    admins: [
      { email: "owner@a.uz", role: "owner", bound: true, verifiedFactors: 2 },
      { email: "admin@a.uz", role: "admin", bound: false, verifiedFactors: 0 },
      { email: "x@a.uz", role: "admin", bound: true, verifiedFactors: null },
    ],
    factorsReadable: true,
    canEnable: false,
  };
  const EVENTS: SecurityEvent[] = [
    { id: 2, at: "2026-10-18T10:00:00Z", kind: "credits.grant", severity: "notice", actorEmail: "owner@a.uz", actorRole: "authenticated", target: "org-1", reason: "welcome" },
    { id: 1, at: "2026-10-18T09:00:00Z", kind: "something.new", severity: "critical", actorEmail: null, actorRole: null, target: null, reason: null },
  ];

  it("shows the gate, the limits, each admin's authenticators and the events, and has no button at all", () => {
    const { container } = render(<OwnerSecurityPanel state="ok" security={SEC} events={EVENTS} eventsState="ok" />);
    expect(screen.getByText(o.security.gateOff)).toBeTruthy();
    expect(screen.getByText("100,000 credits")).toBeTruthy();
    expect(screen.getByText("3× up or down")).toBeTruthy();
    expect(screen.getByText("14 days")).toBeTruthy();
    expect(screen.getByText(o.security.factors.replace("{n}", "2"))).toBeTruthy();
    expect(screen.getByText(o.security.noFactor)).toBeTruthy();
    expect(screen.getByText(o.security.factorsUnknown)).toBeTruthy();
    expect(screen.getByText(o.security.readyNo)).toBeTruthy();
    expect(screen.getByText(o.security.switchNote)).toBeTruthy();
    expect(screen.getByText("Credits given")).toBeTruthy();
    expect(screen.getByText("something.new")).toBeTruthy();
    // read-only: nothing here can switch the gate, or anything else
    expect(container.querySelectorAll("button, a, input, select, textarea, form")).toHaveLength(0);
    expect(container.textContent?.toLowerCase()).not.toContain("enable_admin_mfa");
  });

  it("an unreadable state is said, not drawn as off; unsupported says the migration is missing", () => {
    const { container, rerender } = render(<OwnerSecurityPanel state="failed" security={null} events={null} eventsState="failed" />);
    expect(screen.getByText(o.security.failed)).toBeTruthy();
    expect(container.textContent).not.toContain(o.security.gateOff);
    expect(screen.getByText(o.security.eventsFailed)).toBeTruthy();
    rerender(<OwnerSecurityPanel state="unsupported" security={null} events={null} eventsState="unsupported" />);
    expect(screen.getByText(o.security.unsupported)).toBeTruthy();
  });

  it("a gate that is on, and a session that would be refused, are said plainly", () => {
    render(<OwnerSecurityPanel state="ok" security={{ ...SEC, gateOn: true, caller: { passes: false, why: "aal1", aal: "aal1", hasVerifiedFactor: true } }} events={[]} eventsState="ok" />);
    expect(screen.getByText(o.security.gateOn)).toBeTruthy();
    expect(screen.getByText(/would be refused: signed in with the password only/)).toBeTruthy();
    expect(screen.getByText(o.security.eventsEmpty)).toBeTruthy();
  });
});
