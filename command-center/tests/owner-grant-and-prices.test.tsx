// @vitest-environment jsdom
/**
 * Owner money sheets, part 1: granting credits and the platform price list.
 * Nothing is written on the first tap; the sheet names the object and the
 * number; a double tap writes once; Cancel writes nothing; a failure shows and
 * the keys come back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { en } from "../lib/i18n/en";
import { parsePrices } from "../lib/credits";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  upsert: vi.fn(),
  del: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: h.toast, error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: h.rpc,
    from: () => ({ upsert: h.upsert, delete: () => ({ eq: h.del }) }),
  }),
}));

import { GrantCreditsForm } from "../components/credits/GrantCreditsForm";
import { CreditPricesEditor } from "../components/credits/CreditPricesEditor";

beforeEach(() => {
  h.rpc.mockReset().mockResolvedValue({ error: null });
  h.upsert.mockReset().mockResolvedValue({ error: null });
  h.del.mockReset().mockResolvedValue({ error: null });
  h.refresh.mockReset();
  h.toast.mockReset();
});
afterEach(cleanup);

const sheet = () => screen.getByRole("alertdialog");
const tap = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("GrantCreditsForm", () => {
  const show = () => render(<GrantCreditsForm orgId="org-1" orgName="Acme Studio" creditsPerUsd={100} />);

  it("asks first: the sheet names the organization, the exact credits and about what they cost; nothing is sent yet", async () => {
    show();
    type(en.credits.grantAmount, "2500");
    await tap(screen.getByRole("button", { name: en.credits.grant }));
    const dlg = sheet();
    expect(dlg.textContent).toContain("Give 2,500 credits to “Acme Studio”?");
    expect(within(dlg).getByText("Acme Studio")).toBeTruthy();
    expect(within(dlg).getByText("2,500 credits")).toBeTruthy();
    expect(dlg.textContent).toContain("about $25");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("Cancel sends nothing and leaves the typed amount in place", async () => {
    show();
    type(en.credits.grantAmount, "2500");
    await tap(screen.getByRole("button", { name: en.credits.grant }));
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(h.rpc).not.toHaveBeenCalled();
    expect((screen.getByLabelText(en.credits.grantAmount) as HTMLInputElement).value).toBe("2500");
  });

  it("a double tap on the confirm key grants once, with the exact amount, then refreshes and says so", async () => {
    let done: (v: { error: null }) => void = () => {};
    h.rpc.mockImplementation(() => new Promise((r) => (done = r)));
    show();
    type(en.credits.grantAmount, "2500");
    type(en.credits.grantNote, "welcome");
    await tap(screen.getByRole("button", { name: en.credits.grant }));
    const key = within(sheet()).getByRole("button", { name: en.ownerSafety.grantConfirm });
    fireEvent.click(key);
    fireEvent.click(key);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("grant_credits", { p_org: "org-1", p_amount: 2500, p_note: "welcome" });
    await act(async () => done({ error: null }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith("2,500 credits given to “Acme Studio”.");
    expect((screen.getByLabelText(en.credits.grantAmount) as HTMLInputElement).value).toBe("");
  });

  it("an error shows in the sheet, nothing is cleared, and the key works again", async () => {
    h.rpc.mockResolvedValueOnce({ error: { message: "x" } });
    show();
    type(en.credits.grantAmount, "10");
    await tap(screen.getByRole("button", { name: en.credits.grant }));
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.grantConfirm }));
    expect(within(sheet()).getByRole("alert").textContent).toContain(en.credits.grantFailed);
    expect(within(sheet()).getByRole("alert").textContent).toContain(en.ownerSafety.checkLedger);
    expect(h.refresh).not.toHaveBeenCalled();
    expect((screen.getByLabelText(en.credits.grantAmount) as HTMLInputElement).value).toBe("10");
    const key = within(sheet()).getByRole("button", { name: en.ownerSafety.grantConfirm });
    expect(key.hasAttribute("disabled")).toBe(false);
    await tap(key);
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });

  it("a large grant must be typed back before the key works", async () => {
    show();
    type(en.credits.grantAmount, "6000");
    await tap(screen.getByRole("button", { name: en.credits.grant }));
    const key = within(sheet()).getByRole("button", { name: en.ownerSafety.grantConfirm });
    expect(key.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(sheet()).getByRole("textbox"), { target: { value: "6000" } });
    expect(key.hasAttribute("disabled")).toBe(false);
  });

  it("an amount that is not a number never opens a sheet", async () => {
    show();
    type(en.credits.grantAmount, "-5");
    await tap(screen.getByRole("button", { name: en.credits.grant }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText(en.credits.grantInvalid)).toBeTruthy();
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("CreditPricesEditor", () => {
  const prices = Object.values(
    parsePrices([
      { unit: "video_minute", credits_per_unit: 20, margin: 2, updated_at: null },
      { unit: "custom_thing", credits_per_unit: 7, margin: 0, updated_at: null },
    ]),
  );
  const show = () => render(<CreditPricesEditor prices={prices} canEdit />);
  const removeKey = (unit: string) => {
    const li = screen.getAllByRole("listitem").find((r) => r.textContent?.includes(unit))!;
    return within(li).getByRole("button", { name: en.credits.removePrice });
  };

  it("Remove opens a sheet that names the price; nothing is deleted until the second, separate tap", async () => {
    show();
    await tap(removeKey("custom_thing"));
    expect(sheet().textContent).toContain("Delete the price of “custom_thing”?");
    expect(h.del).not.toHaveBeenCalled();
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.priceDeleteConfirm }));
    expect(h.del).toHaveBeenCalledWith("unit", "custom_thing");
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith("Price deleted: custom_thing.");
  });

  it("Cancel on the delete sheet deletes nothing", async () => {
    show();
    await tap(removeKey("custom_thing"));
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(h.del).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("a failed delete shows in the sheet and keeps the price", async () => {
    h.del.mockResolvedValueOnce({ error: { message: "rls" } });
    show();
    await tap(removeKey("custom_thing"));
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.priceDeleteConfirm }));
    expect(within(sheet()).getByRole("alert").textContent).toBe(en.credits.priceFailed);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(within(sheet()).getByRole("button", { name: en.ownerSafety.priceDeleteConfirm }).hasAttribute("disabled")).toBe(false);
  });

  it("saving shows old → new for the rate and the charge, writes only on confirm, and once on a double tap", async () => {
    let done: (v: { error: null }) => void = () => {};
    h.upsert.mockImplementation(() => new Promise((r) => (done = r)));
    show();
    fireEvent.change(screen.getByPlaceholderText(en.credits.unitPh), { target: { value: "video_minute" } });
    fireEvent.change(screen.getByPlaceholderText(en.credits.ratePh), { target: { value: "25" } });
    fireEvent.change(screen.getByPlaceholderText(en.credits.marginPh), { target: { value: "2" } });
    await tap(screen.getByRole("button", { name: en.credits.savePrice }));
    const dlg = sheet();
    expect(dlg.textContent).toContain("Change the price of “per minute of finished video”?");
    expect(within(dlg).getByText("20 → 25")).toBeTruthy();
    expect(within(dlg).getByText("60 → 75")).toBeTruthy();
    expect(h.upsert).not.toHaveBeenCalled();
    const key = within(dlg).getByRole("button", { name: en.ownerSafety.priceSaveConfirm });
    fireEvent.click(key);
    fireEvent.click(key);
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.upsert).toHaveBeenCalledWith({ unit: "video_minute", credits_per_unit: 25, margin: 2 }, { onConflict: "unit" });
    await act(async () => done({ error: null }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("a rate swing over 30% (markup unchanged) asks for the new rate to be typed", async () => {
    show();
    fireEvent.change(screen.getByPlaceholderText(en.credits.unitPh), { target: { value: "video_minute" } });
    fireEvent.change(screen.getByPlaceholderText(en.credits.ratePh), { target: { value: "40" } });
    fireEvent.change(screen.getByPlaceholderText(en.credits.marginPh), { target: { value: "2" } });
    await tap(screen.getByRole("button", { name: en.credits.savePrice }));
    expect(sheet().textContent).toContain(en.ownerSafety.typeToConfirm.replace("{word}", "40"));
    const key = within(sheet()).getByRole("button", { name: en.ownerSafety.priceSaveConfirm });
    expect(key.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(sheet()).getByRole("textbox"), { target: { value: "40" } });
    expect(key.hasAttribute("disabled")).toBe(false);
  });

  it("a markup-only change that moves the customer-charged figure over 30% asks for that figure, not the rate", async () => {
    show();
    fireEvent.change(screen.getByPlaceholderText(en.credits.unitPh), { target: { value: "video_minute" } });
    fireEvent.change(screen.getByPlaceholderText(en.credits.ratePh), { target: { value: "20" } });
    fireEvent.change(screen.getByPlaceholderText(en.credits.marginPh), { target: { value: "3" } });
    await tap(screen.getByRole("button", { name: en.credits.savePrice }));
    // 20 x 3 = 60 before, 20 x 4 = 80 after: +33%
    expect(within(sheet()).getByText("60 → 80")).toBeTruthy();
    expect(sheet().textContent).toContain(en.ownerSafety.typeToConfirm.replace("{word}", "80"));
    const key = within(sheet()).getByRole("button", { name: en.ownerSafety.priceSaveConfirm });
    expect(key.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(sheet()).getByRole("textbox"), { target: { value: "20" } });
    expect(key.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(sheet()).getByRole("textbox"), { target: { value: "80" } });
    expect(key.hasAttribute("disabled")).toBe(false);
  });

  it("a small markup-only change needs no typing", async () => {
    show();
    fireEvent.change(screen.getByPlaceholderText(en.credits.unitPh), { target: { value: "video_minute" } });
    fireEvent.change(screen.getByPlaceholderText(en.credits.ratePh), { target: { value: "20" } });
    fireEvent.change(screen.getByPlaceholderText(en.credits.marginPh), { target: { value: "2.5" } });
    await tap(screen.getByRole("button", { name: en.credits.savePrice }));
    expect(within(sheet()).queryByRole("textbox")).toBeNull();
  });

  it("Cancel on the save sheet writes nothing and keeps the form", async () => {
    show();
    fireEvent.change(screen.getByPlaceholderText(en.credits.unitPh), { target: { value: "video_minute" } });
    fireEvent.change(screen.getByPlaceholderText(en.credits.ratePh), { target: { value: "25" } });
    await tap(screen.getByRole("button", { name: en.credits.savePrice }));
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(h.upsert).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText(en.credits.ratePh) as HTMLInputElement).value).toBe("25");
  });
});
