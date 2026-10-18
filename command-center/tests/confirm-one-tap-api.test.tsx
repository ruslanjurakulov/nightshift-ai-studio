// @vitest-environment jsdom
/**
 * API activation and the two monthly limits (the account's and a key's) ask first, with old -> new and the effect.
 * What would break: a limit raised or removed, or the API switched on (a program can then spend the prepaid balance),
 * by one tap. Revoking a key already had a sheet and keeps it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { en } from "@/lib/i18n/en";
import { LEGACY_SCOPES } from "@/lib/api/scopes";
import { limitEffect } from "@/lib/limit-change";
import { supabaseStub } from "./helpers/supabaseStub";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (s: string) => `/x/${s}` }));
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("@/lib/i18n/en");
  const { fmt } = await import("@/lib/i18n/core");
  return { useI18n: () => ({ t: en, locale: "en", fmt }) };
});
const h = vi.hoisted(() => ({ rpc: vi.fn(), tables: {} as Record<string, unknown[]> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => supabaseStub(() => ({ data: h.tables[table] ?? [], error: null })).from(table),
    rpc: h.rpc,
  }),
}));

import { DeveloperConsole } from "@/components/developers/DeveloperConsole";

const d = en.developers;
const cs = en.confirmSheets;
const TOPUP = { environment: "sandbox", clientToken: "test_abcdefghijkl" } as const;
const INFO = {
  eligible: true,
  activated_at: "2026-09-01T08:00:00Z",
  exempt: false,
  balance_cents: 2500,
  reserved_cents: 300,
  paid_total_cents: 5000,
  tier: 1,
  rpm: 60,
  concurrency: 2,
  tier_cap_cents: 10000,
  monthly_limit_cents: 4000,
  month_spend_cents: 1200,
  active_keys: 1,
};

function answer(info: unknown) {
  h.rpc.mockImplementation(async (fn: string) => {
    if (fn === "api_console") return { data: info, error: null };
    if (fn === "api_usage") return { data: { days: [], endpoints: [] }, error: null };
    return { data: null, error: null };
  });
}
const called = (fn: string) => h.rpc.mock.calls.filter(([name]) => name === fn);
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}
function confirmKey(label: string) {
  return within(screen.getByRole("alertdialog")).getByRole("button", { name: label }) as HTMLButtonElement;
}
const cancel = () => fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.ux.confirmCancel }));

beforeEach(() => {
  h.rpc.mockReset();
  h.tables = {
    api_keys: [
      { id: "k1", name: "Server", monthly_limit_cents: 500, created_at: "2026-09-02T08:00:00Z", last_used_at: null, revoked_at: null, scopes: [...LEGACY_SCOPES], rpm_limit: null, creative_monthly_credits: null },
      { id: "k2", name: "Worker", monthly_limit_cents: null, created_at: "2026-09-03T08:00:00Z", last_used_at: null, revoked_at: null, scopes: [...LEGACY_SCOPES], rpm_limit: null, creative_monthly_credits: null },
    ],
    api_ledger: [],
  };
  window.history.replaceState(null, "", "/x/developers");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("limitEffect", () => {
  it("names the direction, and treats no limit as the loosest setting", () => {
    expect(limitEffect(500, 500)).toBe("same");
    expect(limitEffect(null, null)).toBe("same");
    expect(limitEffect(500, 900)).toBe("up");
    expect(limitEffect(900, 500)).toBe("down");
    expect(limitEffect(500, null)).toBe("removed");
    expect(limitEffect(null, 500)).toBe("set");
  });
});

describe("activating the API", () => {
  async function open() {
    answer({ ...INFO, activated_at: null });
    render(<DeveloperConsole orgId="o1" topup={TOPUP} />);
    await screen.findByText(d.activateTitle);
    fireEvent.click(screen.getByRole("checkbox"));
  }

  it("asks first and says a program with a key can spend the prepaid balance; nothing is called on the first tap", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: d.activate }));
    expect(screen.getByRole("alertdialog").textContent).toContain(cs.apiActivateBody);
    expect(called("api_activate")).toHaveLength(0);
  });

  it("calls api_activate once after the sheet, even when the key is hit twice; Cancel calls nothing", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: d.activate }));
    cancel();
    await settle();
    expect(called("api_activate")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: d.activate }));
    const key = confirmKey(cs.apiActivateConfirm);
    fireEvent.click(key);
    fireEvent.click(key);
    await waitFor(() => expect(called("api_activate")).toHaveLength(1));
    await settle();
    expect(called("api_activate")).toHaveLength(1);
  });
});

describe("the account's monthly limit", () => {
  async function open() {
    answer(INFO);
    render(<DeveloperConsole orgId="o1" topup={TOPUP} />);
    fireEvent.click(await screen.findByRole("tab", { name: d.tabUsage }));
    return await screen.findByLabelText(d.orgLimit);
  }

  it("shows old -> new and the effect before saving; the first tap calls nothing", async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: d.save }));
    const text = screen.getByRole("alertdialog").textContent ?? "";
    expect(text).toContain("$40.00");
    expect(text).toContain("$90.00");
    expect(text).toContain(cs.limitUp);
    expect(called("api_set_monthly_limit")).toHaveLength(0);
  });

  it("saves the same call once after the sheet, and nothing after Cancel", async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: d.save }));
    expect(screen.getByRole("alertdialog").textContent).toContain(cs.limitDown);
    cancel();
    await settle();
    expect(called("api_set_monthly_limit")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: d.save }));
    const key = confirmKey(cs.limitConfirm);
    fireEvent.click(key);
    fireEvent.click(key);
    await waitFor(() => expect(called("api_set_monthly_limit")).toHaveLength(1));
    await settle();
    expect(called("api_set_monthly_limit")[0][1]).toEqual({ p_org: "o1", p_cents: 2000 });
    expect(called("api_set_monthly_limit")).toHaveLength(1);
  });

  it("an empty field means the plan ceiling, and the sheet says so rather than 'no limit'", async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: d.save }));
    expect(screen.getByRole("alertdialog").textContent).toContain("the plan ceiling of $100.00 applies");
  });

  it("a number that does not parse is refused before any sheet", async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: d.save }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText(d.limitInvalid)).toBeTruthy();
  });
});

describe("a key's monthly limit", () => {
  async function open(answerText: string | null) {
    answer(INFO);
    vi.spyOn(window, "prompt").mockReturnValue(answerText);
    render(<DeveloperConsole orgId="o1" topup={TOPUP} />);
    await screen.findByLabelText(d.keyName);
    await screen.findByText("Server");
  }
  const setLimitButtons = () => screen.getAllByRole("button", { name: d.setLimit });

  it("shows the key, old -> new and that removing the limit is removing a guard", async () => {
    await open("");
    fireEvent.click(setLimitButtons()[0]);
    await screen.findByRole("alertdialog");
    const text = screen.getByRole("alertdialog").textContent ?? "";
    expect(text).toContain("Server");
    expect(text).toContain("$5.00");
    expect(text).toContain(d.noLimit);
    expect(text).toContain(cs.limitRemoved);
    expect(called("set_api_key_limit")).toHaveLength(0);
  });

  it("writes after the sheet only; Cancel writes nothing; a cancelled prompt opens no sheet", async () => {
    await open("12.5");
    fireEvent.click(setLimitButtons()[0]);
    await screen.findByRole("alertdialog");
    cancel();
    await settle();
    expect(called("set_api_key_limit")).toHaveLength(0);
    fireEvent.click(setLimitButtons()[0]);
    await screen.findByRole("alertdialog");
    fireEvent.click(confirmKey(cs.limitConfirm));
    await waitFor(() => expect(called("set_api_key_limit")).toHaveLength(1));
    expect(called("set_api_key_limit")[0][1]).toEqual({ p_key_id: "k1", p_cents: 1250 });
  });

  it("a prompt the person dismissed opens no sheet and writes nothing", async () => {
    await open(null);
    fireEvent.click(setLimitButtons()[0]);
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(called("set_api_key_limit")).toHaveLength(0);
  });
});
