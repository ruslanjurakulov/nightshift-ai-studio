import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  configured: true,
  user: null as null | { id: string },
  state: { hasVerifiedFactor: true, aal: "aal1" } as null | { hasVerifiedFactor: boolean; aal: string },
  getUser: vi.fn(), readMfaState: vi.fn(), mode: vi.fn(), redirect: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get isSupabaseConfigured() { return h.configured; } }));
vi.mock("@/lib/supabase/server", () => ({ getUser: h.getUser }));
vi.mock("@/lib/security/admin-mfa-server", () => ({ adminMfaMode: h.mode, readMfaState: h.readMfaState }));
vi.mock("@/lib/i18n/server", () => ({ getDictionary: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@/components/auth/MfaChallenge", () => ({ MfaChallenge: () => null }));

import VerifyPage from "../app/login/verify/page";
import { MfaChallenge } from "@/components/auth/MfaChallenge";

beforeEach(() => {
  vi.clearAllMocks(); h.configured = true; h.user = null;
  h.state = { hasVerifiedFactor: true, aal: "aal1" };
  h.getUser.mockImplementation(async () => h.user);
  h.readMfaState.mockImplementation(async () => h.state);
  h.mode.mockReturnValue("enforce");
  h.redirect.mockImplementation((target: string) => { throw Object.assign(new Error("Synthetic Next redirect"), { target }); });
});
const page = (next?: string) => VerifyPage({ searchParams: Promise.resolve({ next }) });
async function redirected(next?: string): Promise<string> {
  try { await page(next); } catch (error) {
    if (error instanceof Error && "target" in error) return String(error.target);
    throw error;
  }
  throw new Error("Expected the ordinary redirect");
}

describe("expired verify-session continuation469", () => {
  it.each([
    "/chronos/editor/46900000-0000-4000-8000-000000000001?focus=captions#review",
    "/all-channels/studio?shelf=projects&kind=edit",
  ])("carries the validated internal destination to fresh login: %s", async (next) => {
    const destination = await redirected(next);
    expect(destination).toBe(`/login?next=${encodeURIComponent(next)}`);
    const url = new URL(destination, "http://localhost");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe(next);
    expect(h.getUser).toHaveBeenCalledTimes(1);
    expect(h.mode).not.toHaveBeenCalled();
    expect(h.readMfaState).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   ", "project without a rooted path"])("uses plain login when continuation context is absent or invalid: %s", async (next) => {
    expect(await redirected(next)).toBe("/login");
    expect(h.readMfaState).not.toHaveBeenCalled();
  });

  it("keeps the existing unconfigured branch closed before any user or MFA lookup", async () => {
    h.configured = false;
    expect(await redirected("/chronos/editor/46900000-0000-4000-8000-000000000001")).toBe("/login");
    expect(h.getUser).not.toHaveBeenCalled(); expect(h.readMfaState).not.toHaveBeenCalled();
  });

  it("still requires the existing MFA form after a password-only user is available", async () => {
    h.user = { id: "synthetic-user-469" };
    const next = "/chronos/editor/46900000-0000-4000-8000-000000000001";
    const element = await page(next);
    expect(element.type).toBe(MfaChallenge); expect(element.props.next).toBe(next);
    expect(h.getUser).toHaveBeenCalledTimes(1);
    expect(h.readMfaState).toHaveBeenCalledWith(h.user); expect(h.redirect).not.toHaveBeenCalled();
  });

  it("keeps unreadable MFA state on the form with the existing default destination", async () => {
    h.user = { id: "synthetic-user-469" }; h.state = null;
    const element = await page();
    expect(element.type).toBe(MfaChallenge); expect(element.props.next).toBe("/command-center");
    expect(h.readMfaState).toHaveBeenCalledWith(h.user); expect(h.redirect).not.toHaveBeenCalled();
  });
});
