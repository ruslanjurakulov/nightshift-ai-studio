// @vitest-environment jsdom
/**
 * Two small honesty rules:
 *  - sign-out always signs THIS browser out (scope "local" when the server call fails), and says so when even that fails;
 *  - POST /api/alerts/test answers ok:true only when the feed row was written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { signOutThisBrowser } from "../lib/sign-out";
import { en } from "../lib/i18n/en";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  signOut: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
  clearDrafts: vi.fn(),
  insertError: null as null | { message: string },
  hasClient: true,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, refresh: h.refresh }) }));
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: vi.fn(), error: h.toastError, info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/lib/create-draft", () => ({ clearAllDrafts: () => h.clearDrafts() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut: h.signOut } }) }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => ({ id: "u1" }),
  createClient: async () => (h.hasClient ? { from: () => ({ insert: async () => ({ error: h.insertError }) }) } : null),
}));
vi.mock("@/lib/auth/roles", () => ({ requireRole: async () => true }));
vi.mock("@/lib/auth/org-roles", () => ({ requireOperator: async () => ({ ok: true }) }));
vi.mock("@/lib/server/admin-post-guard", () => ({ guardAdminPost: async () => null }));
vi.mock("@/lib/server/github-secrets", () => ({ isGithubConfigured: false, listConfiguredSecretNames: async () => [] }));
vi.mock("@/lib/server/github-variables", () => ({ readVariables: async () => ({}) }));

import { SignOutButton } from "../components/SignOutButton";

beforeEach(() => {
  h.signOut.mockReset();
  h.push.mockReset();
  h.refresh.mockReset();
  h.toastError.mockReset();
  h.clearDrafts.mockReset();
  h.insertError = null;
  h.hasClient = true;
});
afterEach(cleanup);

/** A session the way the browser holds it: cookies and localStorage keys, with a switch for cookies that refuse to go. */
function fakeEnv(opts: { stuck?: boolean } = {}) {
  const cookies = new Set(["sb-proj-auth-token.0", "sb-proj-auth-token.1", "ns_view", "chronos_locale"]);
  const storage = new Set(["sb-proj-auth-token", "chronos_theme"]);
  return {
    cookies,
    storage,
    env: {
      cookieNames: () => [...cookies],
      expireCookie: (n: string) => {
        if (!opts.stuck) cookies.delete(n);
      },
      storageKeys: () => [...storage],
      removeStorage: (k: string) => void storage.delete(k),
    },
  };
}

describe("signOutThisBrowser", () => {
  it("global success: one call, nothing removed by hand", async () => {
    h.signOut.mockResolvedValue({ error: null });
    const f = fakeEnv();
    expect(await signOutThisBrowser({ signOut: h.signOut }, f.env)).toBe("global");
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(f.cookies.has("sb-proj-auth-token.0")).toBe(true);
  });
  it("the library's local sign-out working is 'local'", async () => {
    h.signOut.mockResolvedValueOnce({ error: { message: "500" } }).mockResolvedValueOnce({ error: null });
    expect(await signOutThisBrowser({ signOut: h.signOut }, fakeEnv().env)).toBe("local");
    expect(h.signOut).toHaveBeenLastCalledWith({ scope: "local" });
  });
  it("an auth outage, as the real library behaves: global AND local both return the error and keep the session, so the cookies and keys are removed by hand", async () => {
    h.signOut.mockResolvedValue({ error: { message: "503" } });
    const f = fakeEnv();
    expect(await signOutThisBrowser({ signOut: h.signOut }, f.env)).toBe("cleared");
    expect(f.cookies.has("sb-proj-auth-token.0")).toBe(false);
    expect(f.cookies.has("sb-proj-auth-token.1")).toBe(false);
    expect(f.storage.has("sb-proj-auth-token")).toBe(false);
    // only the session: language, view and theme choices stay
    expect([...f.cookies].sort()).toEqual(["chronos_locale", "ns_view"]);
    expect([...f.storage]).toEqual(["chronos_theme"]);
  });
  it("offline (both calls throw) is the same", async () => {
    h.signOut.mockRejectedValue(new TypeError("Failed to fetch"));
    const f = fakeEnv();
    expect(await signOutThisBrowser({ signOut: h.signOut }, f.env)).toBe("cleared");
    expect(f.cookies.has("sb-proj-auth-token.0")).toBe(false);
  });
  it("no auth client at all still clears by hand", async () => {
    const f = fakeEnv();
    expect(await signOutThisBrowser(null, f.env)).toBe("cleared");
    expect(f.cookies.has("sb-proj-auth-token.0")).toBe(false);
  });
  it("a session cookie that will not go is 'failed': the person is NOT signed out", async () => {
    h.signOut.mockRejectedValue(new Error("x"));
    expect(await signOutThisBrowser({ signOut: h.signOut }, fakeEnv({ stuck: true }).env)).toBe("failed");
  });
});

describe("SignOutButton", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.cookie = "sb-proj-auth-token=; Max-Age=0; Path=/";
  });
  it("auth outage: the session is removed here, the person is told the server was not reached, then /login; drafts go", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    document.cookie = "sb-proj-auth-token=abc; Path=/";
    h.signOut.mockResolvedValue({ error: { message: "503" } });
    render(<SignOutButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.common.signOut }));
    });
    expect(document.cookie).not.toContain("sb-proj-auth-token");
    expect(h.toastError).toHaveBeenCalledWith(en.ownerTruth.signOutFailed);
    expect(h.clearDrafts).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(h.push).toHaveBeenCalledWith("/login");
  });
  it("a normal sign-out goes straight to /login with no message", async () => {
    h.signOut.mockResolvedValue({ error: null });
    render(<SignOutButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.common.signOut }));
    });
    expect(h.push).toHaveBeenCalledWith("/login");
    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.clearDrafts).toHaveBeenCalledTimes(1);
  });
  it("still signed in after everything (cookie refuses to go): stays, says so, and keeps the drafts", async () => {
    h.signOut.mockRejectedValue(new Error("x"));
    const original = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
    Object.defineProperty(document, "cookie", { configurable: true, get: () => "sb-proj-auth-token=abc", set: () => undefined });
    try {
      render(<SignOutButton />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: en.common.signOut }));
      });
      expect(h.push).not.toHaveBeenCalled();
      expect(h.toastError).toHaveBeenCalledWith(en.ownerTruth.signOutFailed);
      expect(h.clearDrafts).not.toHaveBeenCalled();
    } finally {
      delete (document as unknown as Record<string, unknown>).cookie;
      Object.defineProperty(Document.prototype, "cookie", original);
    }
  });
});

describe("POST /api/alerts/test", () => {
  const post = async () => (await import("../app/api/alerts/test/route")).POST(new Request("https://x.test/api/alerts/test", { method: "POST" }));
  it("a written feed row is ok:true recorded:true", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, recorded: true, queued: true });
  });
  it("a failed insert is NOT ok:true (500, ok:false, recorded:false)", async () => {
    h.insertError = { message: "rls" };
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, recorded: false });
  });
  it("slack delivered but nothing saved: the answer says delivered, still not ok", async () => {
    vi.stubEnv("SLACK_WEBHOOK_URL", "https://hooks.example.test/x");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    h.insertError = { message: "rls" };
    const res = await post();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, recorded: false, delivered: true });
  });
  it("no database client at all is not ok either", async () => {
    h.hasClient = false;
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).recorded).toBe(false);
  });
});
