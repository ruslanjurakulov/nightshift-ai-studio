// @vitest-environment jsdom
/**
 * The owner's buttons never report a success that did not happen.
 *
 * The old middleware answered a signed-out POST with a 307 to /login; fetch followed it, `res.ok` was true, and the
 * Billing refresh said "started", the payment "recorded", the test alert "sent". Every operator client now reads the
 * answer through lib/operator-post.ts: a redirect, a sign-in page, 401, 403, `ok:false`, `recorded:false`, a 500 and a
 * dropped connection are failures, each with its own sentence, and only a real JSON success is a success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { jsonRes, redirectedToLogin } from "./helpers/response";

const h = vi.hoisted(() => ({ fetch: vi.fn(), refresh: vi.fn(), toastError: vi.fn(), toastOk: vi.fn(), locale: "en" as "en" | "ru" | "uz" }));

vi.mock("@/lib/i18n/context", async () => {
  const dicts = { en: (await import("../lib/i18n/en")).en, ru: (await import("../lib/i18n/ru")).ru, uz: (await import("../lib/i18n/uz")).uz };
  const { fmt } = await import("../lib/i18n");
  return {
    useI18n: () => ({ t: dicts[h.locale], locale: h.locale, fmt, setLocale: () => {} }),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }), usePathname: () => "/chronos/billing" }));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: h.toastOk, error: h.toastError, info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { BillingBoard, type ProviderView } from "../components/billing/BillingBoard";
import { PayPanel } from "../components/billing/TopupControls";
import { SendTestAlert } from "../components/alerts/SendTestAlert";
import { SessionEndedBar } from "../components/shell/SessionEndedBar";
import { SESSION_ENDED_EVENT, postOperator, readOperatorResponse, supabaseFailureKind } from "../lib/operator-post";
import { operatorFailureText } from "../lib/setup-errors";

const provider: ProviderView = {
  id: "elevenlabs",
  name: "ElevenLabs",
  billingUrl: "https://e.test",
  unitLabel: "1k chars",
  keySet: true,
  price: 0.3,
  units30: 1000,
  usdPerDay: 1,
  apiBalance: null,
  ledgerUsd: 50,
  balanceUsd: 50,
  daysLeft: 50,
  lowBalanceDays: 7,
  includeInBulk: true,
  cardSaved: false,
  autoRecharge: false,
};

type Case = { name: string; reply: () => Promise<Response> | Response; text: (t: typeof en) => string };
const FAILURES: Case[] = [
  { name: "a followed redirect to the sign-in page (200, redirected, HTML)", reply: redirectedToLogin, text: (t) => t.ownerTruth.sessionEnded },
  { name: "401 unauthenticated", reply: () => jsonRes({ error: "unauthenticated" }, 401), text: (t) => t.ownerTruth.sessionEnded },
  { name: "401 mfa_required", reply: () => jsonRes({ error: "mfa_required" }, 401), text: (t) => t.ownerTruth.mfaRequired },
  { name: "403 forbidden", reply: () => jsonRes({ error: "forbidden" }, 403), text: (t) => t.ownerTruth.forbidden },
  { name: "200 with a sign-in page and no redirect flag", reply: () => new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } }), text: (t) => t.ownerTruth.sessionEnded },
  { name: "network error", reply: () => Promise.reject(new TypeError("Failed to fetch")), text: (t) => t.ownerTruth.offline },
];

beforeEach(() => {
  h.locale = "en";
  h.fetch.mockReset();
  h.refresh.mockReset();
  h.toastError.mockReset();
  h.toastOk.mockReset();
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tap = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

describe("Billing: refresh balances", () => {
  const board = () => render(<BillingBoard providers={[provider]} runway={null} githubConfigured />);
  it.each(FAILURES)("$name is a failure with its own sentence, never 'started'", async ({ reply, text }) => {
    h.fetch.mockImplementation(async () => reply());
    board();
    await tap(screen.getByRole("button", { name: en.billing.refresh }));
    expect(screen.queryByText(en.billing.refreshQueued)).toBeNull();
    expect(screen.getByText(text(en))).toBeTruthy();
  });
  it("500 and 200 ok:false say the refresh could not start", async () => {
    for (const bad of [() => jsonRes({ error: "github_failed" }, 502), () => jsonRes({ ok: false })]) {
      h.fetch.mockImplementation(async () => bad());
      const { unmount } = board();
      await tap(screen.getByRole("button", { name: en.billing.refresh }));
      expect(screen.queryByText(en.billing.refreshQueued)).toBeNull();
      expect(screen.getByText(en.billing.refreshFailed)).toBeTruthy();
      unmount();
    }
  });
  it("only a real JSON ok:true says started", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: true }));
    board();
    await tap(screen.getByRole("button", { name: en.billing.refresh }));
    expect(screen.getByText(en.billing.refreshQueued)).toBeTruthy();
  });
});

describe("Billing: save a provider price", () => {
  it.each(FAILURES)("$name does not say saved and does not refresh the page", async ({ reply, text }) => {
    h.fetch.mockImplementation(async () => reply());
    render(<BillingBoard providers={[provider]} runway={null} githubConfigured />);
    await tap(screen.getByRole("button", { name: en.billing.save }));
    expect(screen.queryByText(en.billing.saved)).toBeNull();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(text(en));
  });
});

describe("Billing: record a payment", () => {
  it.each(FAILURES)("$name keeps the sheet open with the reason and does not refresh", async ({ reply, text }) => {
    h.fetch.mockImplementation(async () => reply());
    render(<PayPanel p={provider} suggested={50} onDone={h.refresh} />);
    await tap(screen.getByRole("button", { name: en.billing.payDone }));
    await tap(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.ownerSafety.topupConfirm }));
    const said = within(screen.getByRole("alertdialog")).getByRole("alert").textContent ?? "";
    expect(said).toContain(text(en));
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.toastOk).not.toHaveBeenCalled();
  });
  it("a dropped connection tells the owner to check the history before recording again (it may have gone through)", async () => {
    h.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<PayPanel p={provider} suggested={50} onDone={h.refresh} />);
    await tap(screen.getByRole("button", { name: en.billing.payDone }));
    await tap(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.ownerSafety.topupConfirm }));
    expect(within(screen.getByRole("alertdialog")).getByRole("alert").textContent).toContain(en.ownerTruth.checkBeforeRetry);
  });
});

describe("Alerts: send a test", () => {
  beforeEach(() => {
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload: vi.fn() } as unknown as Location);
  });
  it.each(FAILURES)("$name is not 'Test recorded'", async ({ reply, text }) => {
    h.fetch.mockImplementation(async () => reply());
    render(<SendTestAlert />);
    await tap(screen.getByRole("button", { name: en.alerts.sendTest }));
    expect(screen.queryByText(en.alerts.testSent)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(text(en));
  });
  it("200 with recorded:false is not 'Test recorded' (nothing was written)", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: true, recorded: false }));
    render(<SendTestAlert />);
    await tap(screen.getByRole("button", { name: en.alerts.sendTest }));
    expect(screen.queryByText(en.alerts.testSent)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(en.ownerTruth.notRecorded);
  });
  it("a recorded test says so", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: true, recorded: true, delivered: false, queued: true }));
    render(<SendTestAlert />);
    await tap(screen.getByRole("button", { name: en.alerts.sendTest }));
    expect(screen.getByText(en.alerts.testSent)).toBeTruthy();
  });
});

describe("postOperator / readOperatorResponse", () => {
  it("classifies every answer", async () => {
    const kind = async (res: Response) => {
      const r = await readOperatorResponse(res);
      return r.ok ? "ok" : r.kind;
    };
    expect(await kind(redirectedToLogin())).toBe("session");
    expect(await kind(new Response(null, { status: 307, headers: { location: "/login" } }))).toBe("session");
    expect(await kind(jsonRes({ error: "unauthenticated" }, 401))).toBe("session");
    expect(await kind(jsonRes({ error: "mfa_required" }, 401))).toBe("mfa");
    expect(await kind(jsonRes({ error: "mfa_enrol_required" }, 403))).toBe("mfa_enrol");
    expect(await kind(jsonRes({ error: "mfa_recent_required" }, 403))).toBe("mfa");
    expect(await kind(jsonRes({ error: "forbidden" }, 403))).toBe("forbidden");
    expect(await kind(jsonRes({ error: "rate_limited" }, 429))).toBe("rate_limited");
    expect(await kind(jsonRes({ error: "save_failed" }, 500))).toBe("server");
    expect(await kind(jsonRes({ ok: false }))).toBe("server");
    expect(await kind(jsonRes({ ok: true, recorded: false }))).toBe("not_recorded");
    expect(await kind(new Response("oops", { status: 200, headers: { "content-type": "text/plain" } }))).toBe("server");
    expect(await kind(new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }))).toBe("server");
    expect(await kind(jsonRes({ ok: true }))).toBe("ok");
    expect(await kind(jsonRes({ voices: [] }))).toBe("ok");
  });
  it("a thrown fetch is a network failure and never throws", async () => {
    h.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await postOperator("/api/x", { a: 1 });
    expect(r).toMatchObject({ ok: false, kind: "network" });
  });
  it("a session that ended is announced to the shell exactly when it is learned", async () => {
    const seen = vi.fn();
    window.addEventListener(SESSION_ENDED_EVENT, seen);
    await readOperatorResponse(jsonRes({ ok: true }));
    expect(seen).not.toHaveBeenCalled();
    await readOperatorResponse(jsonRes({ error: "unauthenticated" }, 401));
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(SESSION_ENDED_EVENT, seen);
  });
  it("the browser's Supabase client errors map to the same kinds", () => {
    expect(supabaseFailureKind({ message: "JWT expired", code: "PGRST301" }, 401)).toBe("session");
    expect(supabaseFailureKind({ message: "permission denied", code: "42501" }, 403)).toBe("forbidden");
    expect(supabaseFailureKind({ message: "TypeError: Failed to fetch" }, 0)).toBe("network");
    expect(supabaseFailureKind({ message: "boom", code: "XX000" }, 500)).toBe("server");
  });
});

describe("the sign-in-again bar", () => {
  it("appears when a session ending is announced, with a button that returns to this page", async () => {
    render(<SessionEndedBar />);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
    });
    const bar = screen.getByRole("alert");
    expect(bar.textContent).toContain(en.ownerTruth.sessionBar);
    const link = within(bar).getByRole("link", { name: en.ownerTruth.signInAgain });
    expect(link.getAttribute("href")).toBe("/login?next=%2Fchronos%2Fbilling");
  });
});

describe.each([
  ["en", en],
  ["ru", ru],
  ["uz", uz],
] as const)("distinct owner sentences (%s)", (_n, t) => {
  it("every failure kind has its own sentence, none is empty, none shows a raw code", () => {
    const kinds = ["session", "mfa", "mfa_enrol", "forbidden", "network", "not_recorded", "server"] as const;
    const out = kinds.map((kind) => operatorFailureText(t, { kind, data: {} }, "FALLBACK"));
    expect(out.filter((s) => s === "FALLBACK")).toHaveLength(1);
    expect(new Set(out).size).toBe(kinds.length);
    for (const s of out) expect(s).not.toMatch(/mfa_required|unauthenticated|_failed|undefined|\{/);
    expect(t.ownerTruth.signInAgain.length).toBeGreaterThan(3);
  });
});
