// @vitest-environment jsdom
/**
 * Owner access and money sheets, part 2: the team roster, recording a provider
 * payment and replacing a provider key. Own row and last owner are blocked in
 * the UI; every other change names the person; payments and keys write once.
 */
import { jsonRes } from "./helpers/response";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { en } from "../lib/i18n/en";

const h = vi.hoisted(() => ({
  members: [] as Record<string, unknown>[],
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
      select: () => ({ order: async () => ({ data: h.members, error: null }) }),
      update: (v: unknown) => ({ eq: (...a: unknown[]) => h.update(v, ...a) }),
      delete: () => ({ eq: h.del }),
      insert: h.insert,
    }),
  }),
}));

import { MembersBoard } from "../components/members/MembersBoard";
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
const row = (email: string) => screen.getAllByRole("listitem").find((r) => r.textContent?.includes(email))!;

describe("MembersBoard", () => {
  const rows = (...r: [string, string, string | null, string][]) =>
    r.map(([id, email, user_id, role]) => ({ id, email, user_id, role, created_at: "2026-01-01" }));

  it("removing a person names them, deletes nothing before the second tap, and Cancel changes nothing", async () => {
    h.members = rows(["1", "me@a.uz", "u-me", "owner"], ["2", "b@a.uz", "u-b", "admin"]);
    render(<MembersBoard myRole="owner" myEmail="me@a.uz" myUserId="u-me" />);
    await waitFor(() => screen.getByText("b@a.uz"));
    await tap(within(row("b@a.uz")).getByRole("button", { name: en.members.remove }));
    expect(sheet().textContent).toContain("Remove b@a.uz from the team?");
    expect(h.del).not.toHaveBeenCalled();
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(h.del).not.toHaveBeenCalled();
    await tap(within(row("b@a.uz")).getByRole("button", { name: en.members.remove }));
    const key = within(sheet()).getByRole("button", { name: en.ownerSafety.memberRemoveConfirm });
    fireEvent.click(key);
    fireEvent.click(key);
    expect(h.del).toHaveBeenCalledTimes(1);
    expect(h.del).toHaveBeenCalledWith("id", "2");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(h.toast).toHaveBeenCalledWith("b@a.uz removed.");
  });

  it("a failed removal shows in the sheet and keeps the person", async () => {
    h.members = rows(["1", "me@a.uz", "u-me", "owner"], ["2", "b@a.uz", "u-b", "admin"]);
    h.del.mockResolvedValueOnce({ error: { message: "rls" } });
    render(<MembersBoard myRole="owner" myEmail="me@a.uz" myUserId="u-me" />);
    await waitFor(() => screen.getByText("b@a.uz"));
    await tap(within(row("b@a.uz")).getByRole("button", { name: en.members.remove }));
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.memberRemoveConfirm }));
    expect(within(sheet()).getByRole("alert").textContent).toBe(en.members.saveFailed);
    expect(within(sheet()).getByRole("button", { name: en.ownerSafety.memberRemoveConfirm }).hasAttribute("disabled")).toBe(false);
  });

  it("a role change shows from → to and writes only on confirm", async () => {
    h.members = rows(["1", "me@a.uz", "u-me", "owner"], ["2", "b@a.uz", "u-b", "admin"]);
    render(<MembersBoard myRole="owner" myEmail="me@a.uz" myUserId="u-me" />);
    await waitFor(() => screen.getByText("b@a.uz"));
    fireEvent.change(within(row("b@a.uz")).getByRole("combobox"), { target: { value: "viewer" } });
    await act(async () => {});
    expect(sheet().textContent).toContain("Change the role of b@a.uz?");
    expect(within(sheet()).getByText(`${en.members.roleAdmin} → ${en.members.roleViewer}`)).toBeTruthy();
    expect(h.update).not.toHaveBeenCalled();
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.roleChangeConfirm }));
    expect(h.update).toHaveBeenCalledWith({ role: "viewer" }, "id", "2");
  });

  it("adding an admin names who gets which role before anything is written; adding a viewer needs no sheet", async () => {
    h.members = rows(["1", "me@a.uz", "u-me", "owner"]);
    render(<MembersBoard myRole="owner" myEmail="me@a.uz" myUserId="u-me" />);
    await waitFor(() => screen.getByText("me@a.uz"));
    fireEvent.change(screen.getByLabelText(en.members.addEmail), { target: { value: "New@A.uz" } });
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "admin" } });
    await tap(screen.getByRole("button", { name: en.members.add }));
    expect(sheet().textContent).toContain("Give new@a.uz the role “Admin”?");
    expect(h.insert).not.toHaveBeenCalled();
    const key = within(sheet()).getByRole("button", { name: en.ownerSafety.memberAddConfirm });
    fireEvent.click(key);
    fireEvent.click(key);
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.insert).toHaveBeenCalledWith({ email: "new@a.uz", role: "admin", created_by: "u-me" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.change(screen.getByLabelText(en.members.addEmail), { target: { value: "v@a.uz" } });
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "viewer" } });
    await tap(screen.getByRole("button", { name: en.members.add }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.insert).toHaveBeenCalledTimes(2);
  });

  it("the only owner cannot be demoted or removed: no select, no remove key, a clear note", async () => {
    h.members = rows(["1", "me@a.uz", "u-me", "owner"], ["2", "b@a.uz", "u-b", "admin"]);
    render(<MembersBoard myRole="owner" myEmail="me@a.uz" myUserId="u-me" />);
    await waitFor(() => screen.getByText("me@a.uz"));
    const mine = row("me@a.uz");
    expect(within(mine).queryByRole("combobox")).toBeNull();
    expect(within(mine).queryByRole("button", { name: en.members.remove })).toBeNull();
    expect(mine.textContent).toContain(en.members.lastOwnerNote);
  });

  it("your own row is blocked even when another owner exists", async () => {
    h.members = rows(["1", "me@a.uz", "u-me", "owner"], ["2", "b@a.uz", "u-b", "owner"], ["3", "c@a.uz", null, "editor"]);
    render(<MembersBoard myRole="owner" myEmail="me@a.uz" myUserId="u-me" />);
    await waitFor(() => screen.getByText("me@a.uz"));
    const mine = row("me@a.uz");
    expect(within(mine).queryByRole("combobox")).toBeNull();
    expect(within(mine).queryByRole("button", { name: en.members.remove })).toBeNull();
    expect(mine.textContent).toContain(en.ownerSafety.blockSelf);
    // another person's row is still manageable
    expect(within(row("c@a.uz")).getByRole("button", { name: en.members.remove })).toBeTruthy();
    expect(within(row("b@a.uz")).getByRole("button", { name: en.members.remove })).toBeTruthy();
  });
});

describe("PayPanel (record a provider payment)", () => {
  const provider: ProviderView = {
    id: "elevenlabs",
    name: "ElevenLabs",
    billingUrl: "https://elevenlabs.io/billing",
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
    billingUrl: "https://x.test",
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
