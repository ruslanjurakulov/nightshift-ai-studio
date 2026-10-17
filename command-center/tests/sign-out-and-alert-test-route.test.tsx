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
  h.insertError = null;
  h.hasClient = true;
});
afterEach(cleanup);

describe("signOutThisBrowser", () => {
  it("global success: one call, no local fallback", async () => {
    h.signOut.mockResolvedValue({ error: null });
    expect(await signOutThisBrowser({ signOut: h.signOut })).toBe("global");
    expect(h.signOut).toHaveBeenCalledTimes(1);
  });
  it("a server error (500) falls back to scope local", async () => {
    h.signOut.mockResolvedValueOnce({ error: { message: "500" } }).mockResolvedValueOnce({ error: null });
    expect(await signOutThisBrowser({ signOut: h.signOut })).toBe("local");
    expect(h.signOut).toHaveBeenLastCalledWith({ scope: "local" });
  });
  it("offline (the call throws) falls back to scope local", async () => {
    h.signOut.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce({ error: null });
    expect(await signOutThisBrowser({ signOut: h.signOut })).toBe("local");
  });
  it("if even the local clear fails the person is NOT signed out", async () => {
    h.signOut.mockRejectedValue(new Error("x"));
    expect(await signOutThisBrowser({ signOut: h.signOut })).toBe("failed");
    expect(await signOutThisBrowser(null)).toBe("failed");
  });
});

describe("SignOutButton", () => {
  it("goes to /login after a local fallback", async () => {
    h.signOut.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce({ error: null });
    render(<SignOutButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.common.signOut }));
    });
    expect(h.push).toHaveBeenCalledWith("/login");
    expect(h.toastError).not.toHaveBeenCalled();
  });
  it("stays and says so when nothing could sign this browser out (a /login visit would bounce straight back in)", async () => {
    h.signOut.mockRejectedValue(new Error("x"));
    render(<SignOutButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.common.signOut }));
    });
    expect(h.push).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith(en.ownerTruth.signOutFailed);
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
  it("no database client at all is not ok either", async () => {
    h.hasClient = false;
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).recorded).toBe(false);
  });
});
