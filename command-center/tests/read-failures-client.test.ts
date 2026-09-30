/**
 * The client-side loads (members rosters, API keys, payment history): a failed
 * read is the error state with Retry — not an empty roster (which would even
 * offer "claim ownership"), "no keys" or "no payments".
 *
 * There is no DOM in this test environment, so hooks are replaced with a tiny
 * runner: state lives in cells, effects run once after the first render, and
 * we render again after they settle. Enough to exercise `load()` for real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { esc, failingSupabase, supabaseStub, EMPTY } from "./helpers/supabaseStub";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  cells: [] as unknown[],
  i: 0,
  effects: [] as (() => unknown)[],
  mounted: false,
  client: null as unknown,
}));

vi.mock("react", async (orig) => {
  const R = await orig<typeof import("react")>();
  const next = () => h.i++;
  const fake = {
    useState: <T,>(init: T | (() => T)) => {
      const k = next();
      if (!(k in h.cells)) h.cells[k] = typeof init === "function" ? (init as () => T)() : init;
      return [h.cells[k] as T, (v: T | ((p: T) => T)) => { h.cells[k] = typeof v === "function" ? (v as (p: T) => T)(h.cells[k] as T) : v; }] as const;
    },
    useRef: <T,>(init: T) => {
      const k = next();
      if (!(k in h.cells)) h.cells[k] = { current: init };
      return h.cells[k] as { current: T };
    },
    useEffect: (fn: () => unknown) => { next(); if (!h.mounted) h.effects.push(fn); },
    useCallback: <T,>(fn: T) => { next(); return fn; },
    useMemo: <T,>(fn: () => T) => { next(); return fn(); },
    useTransition: () => { next(); return [false, (f: () => void) => f()] as const; },
  };
  return { ...R, ...fake, default: { ...R, ...fake } };
});
vi.mock("@/lib/i18n/context", async () => {
  const { fmt } = await import("../lib/i18n");
  const { en } = await import("../lib/i18n/en");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.client }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (s: string) => `/x${s}` }));

/** Render, let the mount effects (and their awaited loads) settle, render again. */
async function mount(make: () => ReactElement): Promise<string> {
  h.cells = [];
  h.effects = [];
  h.mounted = false;
  h.i = 0;
  renderToStaticMarkup(make());
  h.mounted = true;
  for (const e of h.effects) await e();
  await new Promise((r) => setTimeout(r, 0));
  h.i = 0;
  return renderToStaticMarkup(make());
}

const has = (html: string, text: string) => html.includes(esc(text));

afterEach(() => {
  h.client = null;
});

describe("MembersBoard / OrgMembersBoard", () => {
  it("failed roster read: error state, no 'empty' text, no claim-ownership offer", async () => {
    h.client = failingSupabase();
    const { MembersBoard } = await import("../components/members/MembersBoard");
    const html = await mount(() => createElement(MembersBoard, { myRole: "owner", myEmail: "me@example.com", myUserId: "u1" }));
    expect(html).toContain("data-read-error");
    expect(has(html, en.common.retry)).toBe(true);
    expect(has(html, en.members.empty)).toBe(false);
    expect(has(html, en.members.claimTitle)).toBe(false);
  });

  it("readable empty roster keeps the empty text", async () => {
    h.client = supabaseStub(() => EMPTY);
    const { MembersBoard } = await import("../components/members/MembersBoard");
    const html = await mount(() => createElement(MembersBoard, { myRole: "owner", myEmail: "me@example.com", myUserId: "u1" }));
    expect(html).not.toContain("data-read-error");
    expect(has(html, en.members.empty)).toBe(true);
    expect(has(html, en.members.claimTitle)).toBe(true); // control: the offer exists when the roster is really empty
  });

  it("org roster: failed read is the error state", async () => {
    h.client = failingSupabase();
    const { OrgMembersBoard } = await import("../components/org/OrgMembersBoard");
    const org = { id: "org-1", name: "Org", role: "owner", is_default: false } as never;
    const html = await mount(() => createElement(OrgMembersBoard, { org, myUserId: "u1" }));
    expect(html).toContain("data-read-error");
    expect(has(html, en.members.empty)).toBe(false);
  });

  it("org roster: readable empty keeps the empty text", async () => {
    h.client = supabaseStub(() => EMPTY);
    const { OrgMembersBoard } = await import("../components/org/OrgMembersBoard");
    const org = { id: "org-1", name: "Org", role: "owner", is_default: false } as never;
    const html = await mount(() => createElement(OrgMembersBoard, { org, myUserId: "u1" }));
    expect(html).not.toContain("data-read-error");
    expect(has(html, en.members.empty)).toBe(true);
  });
});

describe("DeveloperConsole lists", () => {
  it("API keys: failed read is the error state, not 'no keys'", async () => {
    h.client = failingSupabase();
    const { Keys } = await import("../components/developers/DeveloperConsole");
    const html = await mount(() => createElement(Keys, { orgId: "org-1", activated: true }));
    expect(html).toContain("data-read-error");
    expect(has(html, en.developers.noKeys)).toBe(false);
  });

  it("API keys: readable empty keeps 'no keys'", async () => {
    h.client = supabaseStub(() => EMPTY);
    const { Keys } = await import("../components/developers/DeveloperConsole");
    const html = await mount(() => createElement(Keys, { orgId: "org-1", activated: true }));
    expect(html).not.toContain("data-read-error");
    expect(has(html, en.developers.noKeys)).toBe(true);
  });

  const info = {
    eligible: true, activated_at: "2026-01-01T00:00:00Z", exempt: false, balance_cents: 0, reserved_cents: 0,
    paid_total_cents: 0, tier: 1, rpm: 10, concurrency: 1, tier_cap_cents: null, monthly_limit_cents: null,
    month_spend_cents: 0, active_keys: 0,
  };

  it("payment history: failed read is the error state, not 'no payments'", async () => {
    h.client = failingSupabase();
    const { Billing } = await import("../components/developers/DeveloperConsole");
    const html = await mount(() => createElement(Billing, { orgId: "org-1", info, topup: null, onPaid: () => {} }));
    expect(html).toContain("data-read-error");
    expect(has(html, en.developers.noPayments)).toBe(false);
  });

  it("payment history: readable empty keeps 'no payments'", async () => {
    h.client = supabaseStub(() => EMPTY);
    const { Billing } = await import("../components/developers/DeveloperConsole");
    const html = await mount(() => createElement(Billing, { orgId: "org-1", info, topup: null, onPaid: () => {} }));
    expect(html).not.toContain("data-read-error");
    expect(has(html, en.developers.noPayments)).toBe(true);
  });
});

describe("ApprovalsBoard request list", () => {
  const props = { channelId: "chan1", initialRequire: false, myRole: "owner", myEmail: "me@example.com", myUserId: "u1" } as const;

  it("failed read: error state, not 'no approval requests yet'", async () => {
    h.client = failingSupabase();
    const { ApprovalsBoard } = await import("../components/approvals/ApprovalsBoard");
    const html = await mount(() => createElement(ApprovalsBoard, props));
    expect(html).toContain("data-read-error");
    expect(has(html, en.approvals.readFailed)).toBe(true);
    expect(has(html, en.approvals.empty)).toBe(false);
  });

  it("readable empty keeps the empty state", async () => {
    h.client = supabaseStub(() => EMPTY);
    const { ApprovalsBoard } = await import("../components/approvals/ApprovalsBoard");
    const html = await mount(() => createElement(ApprovalsBoard, props));
    expect(html).not.toContain("data-read-error");
    expect(has(html, en.approvals.empty)).toBe(true);
  });
});
