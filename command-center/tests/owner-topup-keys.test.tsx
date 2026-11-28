// @vitest-environment jsdom
/**
 * Owner money sheets, part 2: recording a provider payment and replacing a
 * provider key. Payments and keys write once. (The team roster that used to be
 * part 1 of this file has no screen any more.)
 */
import { jsonRes } from "./helpers/response";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { en } from "../lib/i18n/en";

const h = vi.hoisted(() => ({
  update: vi.fn(),
  del: vi.fn(),
  insert: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  toastError: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: h.toast, error: h.toastError, info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ order: async () => ({ data: [], error: null }) }),
      update: (v: unknown) => ({ eq: (...a: unknown[]) => h.update(v, ...a) }),
      delete: () => ({ eq: h.del }),
      insert: h.insert,
    }),
  }),
}));

import { PayPanel } from "../components/billing/TopupControls";
import { ProvidersBoard } from "../components/providers/ProvidersBoard";
import type { ProviderView } from "../components/billing/BillingBoard";

beforeEach(() => {
  h.update.mockReset().mockResolvedValue({ error: null });
  h.del.mockReset().mockResolvedValue({ error: null });
  h.insert.mockReset().mockResolvedValue({ error: null });
  h.refresh.mockReset();
  h.toast.mockReset();
  h.toastError.mockReset();
  h.fetch.mockReset().mockImplementation(async () => jsonRes({}));
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

describe("PayPanel (record a provider payment)", () => {
  const provider: ProviderView = {
    id: "elevenlabs",
    name: "ElevenLabs",
    payUrl: "https://elevenlabs.io/billing",
    unitLabel: "characters",
    keySet: true,
    price: null,
    units30: 0,
    usdPerDay: null,
    apiBalance: null,
    ledgerUsd: null,
    balanceUsd: null,
    daysLeft: null,
    lowBalanceDays: 7,
    includeInBulk: true,
    cardSaved: false,
    autoRecharge: false,
  };
  const show = () => render(<PayPanel p={provider} suggested={50} onDone={h.refresh} />);
  const topups = () => h.fetch.mock.calls.filter((c) => c[0] === "/api/billing/topup");

  it("records nothing on the first tap: the sheet names provider, amount and date", async () => {
    show();
    await tap(screen.getByRole("button", { name: en.billing.payDone }));
    expect(sheet().textContent).toContain("Record $50.00 paid to ElevenLabs?");
    expect(within(sheet()).getByText("ElevenLabs")).toBeTruthy();
    expect(within(sheet()).getByText("$50.00")).toBeTruthy();
    expect(within(sheet()).getByText(en.ownerSafety.dDate)).toBeTruthy();
    expect(topups()).toHaveLength(0);
  });

  it("Cancel records nothing", async () => {
    show();
    await tap(screen.getByRole("button", { name: en.billing.payDone }));
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(topups()).toHaveLength(0);
  });

  it("a double tap records once, and the same figure cannot be recorded again from the panel", async () => {
    let finish: (v: unknown) => void = () => {};
    h.fetch.mockImplementation(() => new Promise((r) => (finish = r)));
    show();
    await tap(screen.getByRole("button", { name: en.billing.payDone }));
    const key = within(sheet()).getByRole("button", { name: en.ownerSafety.topupConfirm });
    fireEvent.click(key);
    fireEvent.click(key);
    expect(topups()).toHaveLength(1);
    expect(JSON.parse(topups()[0][1].body)).toEqual({ provider: "elevenlabs", amount_usd: 50 });
    await act(async () => finish(jsonRes({})));
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith("Recorded $50.00 for ElevenLabs.");
    // recorded: the key is off for the same amount, even after editing and putting it back
    const recorded = screen.getByRole("button", { name: en.billing.payRecorded });
    expect(recorded.hasAttribute("disabled")).toBe(true);
    const amount = screen.getByLabelText(en.billing.payAmount);
    fireEvent.change(amount, { target: { value: "50.00" } });
    expect(screen.getByRole("button", { name: en.billing.payRecorded }).hasAttribute("disabled")).toBe(true);
    // a different amount is a deliberate new payment
    fireEvent.change(amount, { target: { value: "20" } });
    expect(screen.getByRole("button", { name: en.billing.payDone }).hasAttribute("disabled")).toBe(false);
  });

  it("a failure shows in the sheet and the key works again", async () => {
    h.fetch.mockResolvedValueOnce(jsonRes({}, 500));
    show();
    await tap(screen.getByRole("button", { name: en.billing.payDone }));
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.topupConfirm }));
    expect(within(sheet()).getByRole("alert").textContent).toBe(en.ownerSafety.topupFailed);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(within(sheet()).getByRole("button", { name: en.ownerSafety.topupConfirm }).hasAttribute("disabled")).toBe(false);
  });

  it("a setting that fails to save is put back and says so", async () => {
    h.fetch.mockResolvedValueOnce(jsonRes({}, 500));
    show();
    const box = screen.getByLabelText(en.billing.cardSaved) as HTMLInputElement;
    await act(async () => {
      fireEvent.click(box);
    });
    expect(box.checked).toBe(false);
    expect(h.toastError).toHaveBeenCalled();
  });
});

describe("ProvidersBoard (replace a key)", () => {
  const def = { id: "elevenlabs", name: "ElevenLabs", category: "voice" as const, secretName: "ELEVENLABS_API_KEY", consoleUrl: "https://e.test", live: true };
  const show = (configured: string[]) =>
    render(<ProvidersBoard groups={[{ category: "voice", items: [def] }]} configured={configured} githubConfigured />);
  const field = () => screen.getByLabelText("ElevenLabs API key");
  const secretsCalls = () => h.fetch.mock.calls.filter((c) => c[0] === "/api/setup/secrets");

  it("replacing a key on file asks first and names the provider; no part of the pasted key is shown anywhere", async () => {
    show(["ELEVENLABS_API_KEY"]);
    const secret = "sk_live_abcd1234wxyz";
    fireEvent.change(field(), { target: { value: secret } });
    await tap(screen.getByRole("button", { name: en.providers.replace }));
    expect(sheet().textContent).toContain("Replace the key of ElevenLabs?");
    expect(sheet().textContent).toContain(en.ownerSafety.keyWillReplace);
    // never the key, a prefix, a suffix or a masked fragment of it
    for (const frag of [secret, "wxyz", "sk_live", "abcd", "1234"]) expect(sheet().textContent).not.toContain(frag);
    expect(secretsCalls()).toHaveLength(0);
  });

  it("Cancel sends nothing and leaves the pasted key in the field", async () => {
    show(["ELEVENLABS_API_KEY"]);
    fireEvent.change(field(), { target: { value: "sk_live_abcd1234wxyz" } });
    await tap(screen.getByRole("button", { name: en.providers.replace }));
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(secretsCalls()).toHaveLength(0);
    expect((field() as HTMLInputElement).value).toBe("sk_live_abcd1234wxyz");
    expect(screen.getByRole("button", { name: en.providers.replace }).hasAttribute("disabled")).toBe(false);
  });

  it("a double tap on the confirm key sends once and clears the field", async () => {
    let finish: (v: unknown) => void = () => {};
    h.fetch.mockImplementation(() => new Promise((r) => (finish = r)));
    show(["ELEVENLABS_API_KEY"]);
    fireEvent.change(field(), { target: { value: "sk_live_abcd1234wxyz" } });
    await tap(screen.getByRole("button", { name: en.providers.replace }));
    const key = within(sheet()).getByRole("button", { name: en.ownerSafety.keyReplaceConfirm });
    fireEvent.click(key);
    fireEvent.click(key);
    expect(secretsCalls()).toHaveLength(1);
    await act(async () => finish(jsonRes({})));
    expect((field() as HTMLInputElement).value).toBe("");
    expect(h.toast).toHaveBeenCalledWith(en.providers.saved);
  });

  it("a rejected replace shows in the sheet and keeps the key typed", async () => {
    h.fetch.mockResolvedValueOnce(jsonRes({ error: "github_unauthorized" }, 500));
    show(["ELEVENLABS_API_KEY"]);
    fireEvent.change(field(), { target: { value: "sk_live_abcd1234wxyz" } });
    await tap(screen.getByRole("button", { name: en.providers.replace }));
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.keyReplaceConfirm }));
    expect(within(sheet()).getByRole("alert").textContent).toBe(en.providers.unauthorized);
    expect((field() as HTMLInputElement).value).toBe("sk_live_abcd1234wxyz");
  });

  it("a coded refusal (bad value) is worded by name inside the sheet, with no part of the value", async () => {
    h.fetch.mockResolvedValueOnce(jsonRes({ error: "bad_value", name: "ELEVENLABS_API_KEY", reason: "sk_live_abcd1234wxyz" }, 500));
    show(["ELEVENLABS_API_KEY"]);
    fireEvent.change(field(), { target: { value: "sk_live_abcd1234wxyz" } });
    await tap(screen.getByRole("button", { name: en.providers.replace }));
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.keyReplaceConfirm }));
    const text = within(sheet()).getByRole("alert").textContent ?? "";
    expect(text).toContain("ELEVENLABS_API_KEY");
    expect(text).not.toMatch(/sk_live|abcd|wxyz/);
  });

  it("a first key needs no sheet", async () => {
    show([]);
    fireEvent.change(field(), { target: { value: "sk_live_abcd1234wxyz" } });
    await tap(screen.getByRole("button", { name: en.providers.save }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(secretsCalls()).toHaveLength(1);
  });

  it("a key with a space or too short is refused before any sheet", async () => {
    show(["ELEVENLABS_API_KEY"]);
    fireEvent.change(field(), { target: { value: "abc def" } });
    await tap(screen.getByRole("button", { name: en.providers.replace }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText(en.ownerSafety.keyInvalid)).toBeTruthy();
    // the refusal does not echo any part, or the length, of what was typed
    expect(screen.getByText(en.ownerSafety.keyInvalid).textContent).not.toMatch(/\d|abc|def/);
    expect(secretsCalls()).toHaveLength(0);
  });
});

describe("BulkPay (pay all providers)", () => {
  const base = {
    payUrl: "https://x.test",
    unitLabel: "u",
    keySet: true,
    price: 1,
    units30: 1,
    apiBalance: null,
    ledgerUsd: null,
    balanceUsd: 0,
    daysLeft: 1,
    lowBalanceDays: 7,
    includeInBulk: true,
    cardSaved: false,
    autoRecharge: false,
  };
  const providers = [
    { ...base, id: "a", name: "Alpha", usdPerDay: 1 },
    { ...base, id: "b", name: "Beta", usdPerDay: 2 },
  ] as ProviderView[];
  const topups = () => h.fetch.mock.calls.filter((c) => c[0] === "/api/billing/topup");

  it("walks with a frozen list: controls lock, the sheet names provider and amount, a double tap records once", async () => {
    const { BulkPay } = await import("../components/billing/TopupControls");
    let finish: (v: unknown) => void = () => {};
    h.fetch.mockImplementation(() => new Promise((r) => (finish = r)));
    render(<BulkPay providers={providers} onDone={h.refresh} />);
    await tap(screen.getByRole("button", { name: new RegExp(en.billing.bulkPay) }));
    // controls above the walk are locked, so the amounts cannot shift under it
    expect(screen.getByLabelText(en.billing.bulkHorizon).matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("Alpha").matches(":disabled")).toBe(true);
    await tap(screen.getByRole("button", { name: en.billing.payDone }));
    expect(sheet().textContent).toContain("Record $30.00 paid to Alpha?");
    expect(topups()).toHaveLength(0);
    const key = within(sheet()).getByRole("button", { name: en.ownerSafety.topupConfirm });
    fireEvent.click(key);
    fireEvent.click(key);
    expect(topups()).toHaveLength(1);
    expect(JSON.parse(topups()[0][1].body)).toEqual({ provider: "a", amount_usd: 30 });
    await act(async () => finish(jsonRes({})));
    // moved on to the next provider
    expect(screen.getByText(/Beta · \$60\.00/)).toBeTruthy();
  });

  it("a failed record stays on the same step with the message in the sheet", async () => {
    const { BulkPay } = await import("../components/billing/TopupControls");
    h.fetch.mockResolvedValueOnce(jsonRes({}, 500));
    render(<BulkPay providers={providers} onDone={h.refresh} />);
    await tap(screen.getByRole("button", { name: new RegExp(en.billing.bulkPay) }));
    await tap(screen.getByRole("button", { name: en.billing.payDone }));
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.topupConfirm }));
    expect(within(sheet()).getByRole("alert").textContent).toBe(en.ownerSafety.topupFailed);
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(screen.getAllByText(/Alpha/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Beta · /)).toBeNull();
  });
});
