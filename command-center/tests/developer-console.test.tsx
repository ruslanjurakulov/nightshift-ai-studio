// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { KEY_PRESETS, LEGACY_SCOPES, READ_ONLY_SCOPES, keyPresetOf } from "@/lib/api/scopes";
import { supabaseStub } from "./helpers/supabaseStub";

/**
 * The Developers page after the simplification: one strip with the shared API
 * balance and "Add funds", three tabs, a key form with two presets and the
 * detail under "More options". Money semantics are not under test here — they
 * did not change (tests/dev-pages*.test.ts and the API tests pin them).
 */

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (s: string) => `/x/${s}` }));
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("@/lib/i18n/en");
  const { fmt } = await import("@/lib/i18n/core");
  return { useI18n: () => ({ t: en, locale: "en", fmt }) };
});

const h = vi.hoisted(() => ({ rpc: vi.fn(), tables: {} as Record<string, unknown[]>, read: [] as string[] }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      h.read.push(table);
      return supabaseStub(() => ({ data: h.tables[table] ?? [], error: null })).from(table);
    },
    rpc: h.rpc,
  }),
}));

import { DeveloperConsole, tabFromAddress } from "@/components/developers/DeveloperConsole";

const d = en.developers;
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
  monthly_limit_cents: null,
  month_spend_cents: 1200,
  active_keys: 1,
};
const KEY = "nsk_live_" + "A".repeat(43);
const TOPUP = { environment: "sandbox", clientToken: "test_abcdefghijkl" } as const;

function answer(info: unknown) {
  h.rpc.mockImplementation(async (fn: string) => {
    if (fn === "api_console") return { data: info, error: null };
    if (fn === "api_usage") return { data: { days: [], endpoints: [] }, error: null };
    if (fn === "create_scoped_api_key") return { data: { key: KEY, id: "k_new" }, error: null };
    return { data: null, error: null };
  });
}

beforeEach(() => {
  h.rpc.mockReset();
  h.read.length = 0;
  h.tables = {
    api_keys: [
      { id: "k_full", name: "Server", monthly_limit_cents: null, created_at: "2026-09-02T08:00:00Z", last_used_at: null, revoked_at: null, scopes: [...LEGACY_SCOPES], rpm_limit: null, creative_monthly_credits: null },
      { id: "k_read", name: "Dashboard", monthly_limit_cents: 500, created_at: "2026-09-03T08:00:00Z", last_used_at: null, revoked_at: null, scopes: [...READ_ONLY_SCOPES], rpm_limit: 30, creative_monthly_credits: null },
      { id: "k_cust", name: "Worker", monthly_limit_cents: null, created_at: "2026-09-04T08:00:00Z", last_used_at: null, revoked_at: null, scopes: ["account:read", "creative:quote", "creative:create"], rpm_limit: null, creative_monthly_credits: 100 },
      { id: "k_old", name: "Old", monthly_limit_cents: null, created_at: "2026-08-01T08:00:00Z", last_used_at: null, revoked_at: null, scopes: null, rpm_limit: null, creative_monthly_credits: null },
    ],
    api_ledger: [],
  };
  window.history.replaceState(null, "", "/x/developers");
});
afterEach(cleanup);

const balance = () => screen.getByTestId("api-balance").textContent;
const tabs = () => screen.getAllByRole("tab");

describe("scopes: the two presets", () => {
  it("'Standard' is exactly today's default key; 'Read only' can change and spend nothing", () => {
    expect([...KEY_PRESETS.full]).toEqual([...LEGACY_SCOPES]);
    expect(KEY_PRESETS.full.some((s) => s.startsWith("creative:"))).toBe(false);
    expect(READ_ONLY_SCOPES.every((s) => s.endsWith(":read"))).toBe(true);
    expect(keyPresetOf(["videos:write", "account:read", "videos:read"])).toBe("full");
    expect(keyPresetOf(["videos:read", "account:read"])).toBe("read");
    expect(keyPresetOf(["account:read"])).toBeNull();
    expect(keyPresetOf([...LEGACY_SCOPES, "creative:create"])).toBeNull();
  });
});

describe("old links", () => {
  it.each([
    ["", "#billing", "usage"],
    ["", "#limits", "usage"],
    ["", "#overview", "usage"],
    ["?tab=usage", "", "usage"],
    ["?tab=limits", "", "usage"],
    ["", "#connected-apps-title", "apps"],
    ["?tab=connected-apps", "", "apps"],
    ["", "#keys", "keys"],
    ["?tab=limits", "#keys", "keys"],
  ])("%s%s lands on %s", (search, hash, tab) => {
    expect(tabFromAddress(search, hash)).toBe(tab);
  });
  it("an unknown name opens the default (null: the page opens on Keys)", () => {
    expect(tabFromAddress("?tab=nope", "#whatever")).toBeNull();
    expect(tabFromAddress("?tab=__proto__", "")).toBeNull();
  });
});

describe("DeveloperConsole", () => {
  it("has three tabs and opens on Keys", async () => {
    answer(INFO);
    render(<DeveloperConsole orgId="o1" topup={TOPUP} connectedApps={<p>APPS PANEL</p>} />);
    await screen.findByRole("tab", { name: d.tabKeys });
    expect(tabs().map((x) => x.textContent)).toEqual([d.tabKeys, d.tabUsage, d.tabApps]);
    expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("APPS PANEL")).toBeNull();
    fireEvent.click(tabs()[2]);
    expect(screen.getByText("APPS PANEL")).toBeTruthy();
    expect(window.location.hash).toBe("#apps");
  });

  it("an old #billing link opens 'Usage and billing', with the limit, usage and payments in it", async () => {
    window.history.replaceState(null, "", "/x/developers#billing");
    answer(INFO);
    render(<DeveloperConsole orgId="o1" topup={TOPUP} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: d.tabUsage }).getAttribute("aria-selected")).toBe("true"));
    expect(await screen.findByText(d.limitsTitle)).toBeTruthy(); // was the Limits tab
    expect(screen.getByText(d.historyTitle)).toBeTruthy(); // was the Billing tab
    expect(await screen.findByText(d.noUsage)).toBeTruthy(); // was the Usage tab
    expect(screen.getByText(d.monthSpend)).toBeTruthy(); // was the Overview tab
  });

  it("an old #billing link never mounts Keys first: the keys are not even read", async () => {
    window.history.replaceState(null, "", "/x/developers#billing");
    answer(INFO);
    render(<DeveloperConsole orgId="o1" topup={TOPUP} />);
    await screen.findByText(d.historyTitle);
    expect(screen.getByRole("tab", { name: d.tabUsage }).getAttribute("aria-selected")).toBe("true");
    expect(h.read).not.toContain("api_keys");
    expect(h.read).toContain("api_ledger");
  });

  it("shows the shared API balance (less what is on hold) with Add funds on every tab", async () => {
    answer(INFO);
    render(<DeveloperConsole orgId="o1" topup={TOPUP} connectedApps={<p>APPS</p>} />);
    await screen.findByRole("tab", { name: d.tabKeys });
    for (const tab of tabs()) {
      fireEvent.click(tab);
      expect(balance()).toBe("$22.00");
      expect(screen.getByRole("button", { name: d.addFunds })).toBeTruthy();
    }
  });

  it("Add funds opens the existing top-up form: an amount and a button that starts the same payment", async () => {
    answer(INFO);
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DeveloperConsole orgId="o1" topup={TOPUP} />);
    fireEvent.click(await screen.findByRole("button", { name: d.addFunds }));
    const amount = screen.getByLabelText(d.amount) as HTMLInputElement;
    expect(amount.value).toBe("25");
    fireEvent.change(amount, { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: d.topup }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("/api/developers/topup");
    expect(JSON.parse(init.body)).toEqual({ org_id: "o1", amount_cents: 4000 });
    await screen.findByText(d.topupFailed);
    vi.unstubAllGlobals();
  });

  it("an invalid amount is refused before any request", async () => {
    answer(INFO);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<DeveloperConsole orgId="o1" topup={TOPUP} />);
    fireEvent.click(await screen.findByRole("button", { name: d.addFunds }));
    fireEvent.change(screen.getByLabelText(d.amount), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: d.topup }));
    expect(await screen.findByText(d.topupInvalid)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("without a configured top-up, Add funds is disabled and says why", async () => {
    answer(INFO);
    render(<DeveloperConsole orgId="o1" topup={null} />);
    const button = (await screen.findByRole("button", { name: d.addFunds })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(d.topupUnavailable)).toBeTruthy();
  });

  it("an unknown balance is a dash, never $0.00", async () => {
    answer({ ...INFO, balance_cents: null });
    render(<DeveloperConsole orgId="o1" topup={TOPUP} />);
    await screen.findByRole("tab", { name: d.tabKeys });
    expect(balance()).toBe("—");
    expect(screen.getByText(d.balanceUnknown)).toBeTruthy();
    expect(document.body.textContent).not.toContain("$0.00");
  });

  it("while loading and when the console fails to load, the balance is a dash, not $0.00", async () => {
    h.rpc.mockImplementation(() => new Promise(() => {}));
    const first = render(<DeveloperConsole orgId="o1" topup={TOPUP} />);
    expect(balance()).toBe("—");
    expect(screen.queryByRole("button", { name: d.addFunds })).toBeNull();
    first.unmount();
    h.rpc.mockImplementation(async () => ({ data: null, error: { code: "XX000", message: "boom" } }));
    render(<DeveloperConsole orgId="o1" topup={TOPUP} />);
    await screen.findByText(d.loadFailed);
    expect(balance()).toBe("—");
    expect(document.body.textContent).not.toContain("$0.00");
  });

  it("the operator's organization has no balance to show and nothing to top up", async () => {
    answer({ ...INFO, exempt: true });
    render(<DeveloperConsole orgId="o1" topup={TOPUP} />);
    await screen.findByRole("tab", { name: d.tabKeys });
    expect(balance()).toBe("—");
    expect(screen.queryByRole("button", { name: d.addFunds })).toBeNull();
  });

  it("before the API is activated there is no Add funds, only the activation", async () => {
    answer({ ...INFO, activated_at: null });
    render(<DeveloperConsole orgId="o1" topup={TOPUP} />);
    await screen.findByText(d.activateTitle);
    expect(screen.queryByRole("button", { name: d.addFunds })).toBeNull();
  });
});

describe("the key form", () => {
  async function open() {
    answer(INFO);
    render(<DeveloperConsole orgId="o1" topup={TOPUP} />);
    await screen.findByLabelText(d.keyName);
  }
  const created = () => h.rpc.mock.calls.find(([fn]) => fn === "create_scoped_api_key")?.[1] as Record<string, unknown> | undefined;

  it("asks only for a name and one of two presets; the detail is under a closed 'More options'", async () => {
    await open();
    const more = screen.getByText(d.moreOptions).closest("details") as HTMLDetailsElement;
    expect(more.open).toBe(false);
    for (const label of [d.keyLimit, d.keyRpm, d.keyCreditLimit, d.keyScopes]) {
      expect(more.textContent).toContain(label);
    }
    const form = screen.getByLabelText(d.keyName).closest("form") as HTMLFormElement;
    const outside = within(form).getAllByRole("radio");
    expect(outside).toHaveLength(2);
    expect(screen.getByRole("radio", { name: new RegExp(d.presetFull) })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: new RegExp(d.presetRead) })).toHaveProperty("checked", false);
  });

  it("creates with today's defaults when only a name is given", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(d.keyName), { target: { value: "Prod" } });
    fireEvent.click(screen.getByRole("button", { name: d.create }));
    await screen.findByText(d.newKeyTitle);
    expect(created()).toEqual({
      p_org: "o1",
      p_name: "Prod",
      p_monthly_limit_cents: null,
      p_scopes: [...LEGACY_SCOPES].sort(),
      p_rpm_limit: null,
      p_creative_monthly_credits: null,
    });
  });

  it("'Read only' creates a key that can only read", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(d.keyName), { target: { value: "Reader" } });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(d.presetRead) }));
    fireEvent.click(screen.getByRole("button", { name: d.create }));
    await screen.findByText(d.newKeyTitle);
    expect(created()?.p_scopes).toEqual([...READ_ONLY_SCOPES].sort());
  });

  it("ticking a permission under More options makes the key custom and neither preset stays chosen; nothing is added on its own", async () => {
    await open();
    fireEvent.click(screen.getByText(d.moreOptions));
    fireEvent.click(screen.getByLabelText(d.scopeCreativeQuote));
    expect(screen.getByRole("radio", { name: new RegExp(d.presetFull) })).toHaveProperty("checked", false);
    expect(screen.getByRole("radio", { name: new RegExp(d.presetRead) })).toHaveProperty("checked", false);
    expect(screen.getByText("Custom (4)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(d.keyName), { target: { value: "Quote" } });
    fireEvent.change(screen.getByLabelText(d.keyRpm), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText(d.keyLimit), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: d.create }));
    await screen.findByText(d.newKeyTitle);
    expect(created()?.p_scopes).toEqual([...LEGACY_SCOPES, "creative:quote"].sort());
    expect(created()?.p_rpm_limit).toBe(20);
    expect(created()?.p_monthly_limit_cents).toBe(1500);
  });

  it("a key with no permission cannot be created, and a bad limit opens More options on the problem", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(d.keyName), { target: { value: "Bad" } });
    fireEvent.click(screen.getByText(d.moreOptions));
    for (const s of LEGACY_SCOPES) fireEvent.click(screen.getByLabelText(new RegExp(`^${({ "account:read": d.scopeAccountRead, "videos:read": d.scopeVideosRead, "videos:write": d.scopeVideosWrite } as Record<string, string>)[s]}$`)));
    expect((screen.getByRole("button", { name: d.create }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(d.presetFull) }));
    fireEvent.click(screen.getByText(d.moreOptions)); // close it again
    fireEvent.change(screen.getByLabelText(d.keyLimit), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: d.create }));
    expect(await screen.findByText(d.limitInvalid)).toBeTruthy();
    expect((screen.getByText(d.moreOptions).closest("details") as HTMLDetailsElement).open).toBe(true);
    expect(created()).toBeUndefined();
  });

  it("with every permission unticked and More options closed, the form says why Create key is off", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(d.keyName), { target: { value: "Nothing" } });
    fireEvent.click(screen.getByText(d.moreOptions));
    for (const s of LEGACY_SCOPES) fireEvent.click(screen.getByLabelText(new RegExp(`^${({ "account:read": d.scopeAccountRead, "videos:read": d.scopeVideosRead, "videos:write": d.scopeVideosWrite } as Record<string, string>)[s]}$`)));
    fireEvent.click(screen.getByText(d.moreOptions)); // close it again
    expect((screen.getByText(d.moreOptions).closest("details") as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText("Custom (0)")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(d.scopesRequired);
    expect((screen.getByRole("button", { name: d.create }) as HTMLButtonElement).disabled).toBe(true);
    // ticking one permission clears the message and turns the button back on
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(d.presetRead) }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: d.create }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the Standard preset is named for what it is and still sends today's default scopes", () => {
    expect(en.developers.presetFull).toBe("Standard");
    expect(ru.developers.presetFull).toBe("Стандартный");
    expect(uz.developers.presetFull).toBe("Standart");
    expect(en.developers.presetFullHint).toContain("AI generations paid in credits are off");
    expect([...KEY_PRESETS.full]).toEqual([...LEGACY_SCOPES]);
  });

  it("key rows say Standard, Read only or Custom (n), with the whole list one tap away; Set limit and Revoke stay", async () => {
    await open();
    await screen.findByText("Server"); // the key list loads after the form
    const row = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
    expect(within(row("Server")).getByText(d.presetFull)).toBeTruthy();
    expect(within(row("Dashboard")).getByText(d.presetRead)).toBeTruthy();
    expect(within(row("Worker")).getByText("Custom (3)")).toBeTruthy();
    expect(within(row("Old")).getByText(d.presetFull)).toBeTruthy();
    const worker = row("Worker");
    expect(worker.querySelector("summary")?.getAttribute("title")).toContain(d.scopeCreativeCreate);
    for (const text of [d.scopeAccountRead, d.scopeCreativeQuote, d.scopeCreativeCreate]) expect(within(worker).getByText(text)).toBeTruthy();
    expect(worker.textContent).toContain(`${d.keyCreditsShort}: 100`);
    expect(within(row("Dashboard")).getByText(`${d.keyRpmShort}: 30`)).toBeTruthy();
    expect(within(row("Old")).getByText(d.keyAccessLegacy)).toBeTruthy();
    for (const name of ["Server", "Dashboard", "Worker"]) {
      expect(within(row(name)).getByRole("button", { name: d.setLimit })).toBeTruthy();
      expect(within(row(name)).getByRole("button", { name: d.revoke })).toBeTruthy();
    }
  });

  it("Revoke asks in the shared sheet that names the key (never window.confirm); Cancel revokes nothing, Confirm revokes once", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await open();
    await screen.findByText("Server");
    const row = () => screen.getByText("Server").closest("tr") as HTMLElement;
    fireEvent.click(within(row()).getByRole("button", { name: d.revoke }));
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg.textContent).toContain(`${d.revoke}: Server`);
    expect(dlg.textContent).toContain(d.revokeConfirm);
    expect(nativeConfirm).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByRole("button", { name: en.ux.confirmCancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(h.rpc.mock.calls.filter((c) => c[0] === "revoke_api_key")).toHaveLength(0);
    fireEvent.click(within(row()).getByRole("button", { name: d.revoke }));
    const again = await screen.findByRole("alertdialog");
    const key = within(again).getByRole("button", { name: d.revoke });
    fireEvent.click(key);
    fireEvent.click(key);
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("revoke_api_key", { p_key_id: "k_full" }));
    expect(h.rpc.mock.calls.filter((c) => c[0] === "revoke_api_key")).toHaveLength(1);
    nativeConfirm.mockRestore();
  });
});

describe("the dictionaries", () => {
  const keys = ["tabKeys", "tabUsage", "tabApps", "apiBalance", "addFunds", "balanceUnknown", "topup", "presetFull", "presetFullHint", "presetRead", "presetReadHint", "presetCustom", "presetCustomHint", "moreOptions"] as const;
  it.each(keys)("%s is written in all three languages", (k) => {
    for (const dict of [en, ru, uz]) expect((dict.developers as Record<string, string>)[k].trim()).not.toBe("");
    expect((ru.developers as Record<string, string>)[k]).not.toBe((en.developers as Record<string, string>)[k]);
    expect((uz.developers as Record<string, string>)[k]).not.toBe((en.developers as Record<string, string>)[k]);
  });
  it("the Custom (n) label keeps its number in every language", () => {
    for (const dict of [en, ru, uz]) expect(dict.developers.presetCustom).toContain("{n}");
  });
  it("the five old tab names are gone", () => {
    for (const dict of [en, ru, uz]) {
      const dev = dict.developers as Record<string, string>;
      expect(dev.tabOverview).toBeUndefined();
      expect(dev.tabBilling).toBeUndefined();
      expect(dev.tabLimits).toBeUndefined();
    }
  });
});

