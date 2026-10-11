// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { en } from "../lib/i18n/en";

const UID = "6f1c7a4e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
const h = vi.hoisted(() => ({
  update: vi.fn(),
  signOut: vi.fn(),
  finish: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  user: null as { id: string; email: string } | null,
  jar: new Map<string, string>(),
  redirected: null as string | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/i18n/public-context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://p.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { updateUser: h.update, signOut: h.signOut } }) }));
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => h.user }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ t: en, locale: "en" }) };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, refresh: h.refresh, push: vi.fn() }),
  redirect: (url: string) => {
    h.redirected = url;
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined) }),
}));
vi.mock("@/app/reset-password/actions", () => ({ finishRecovery: h.finish }));
vi.mock("@/components/auth/AuthShell", async () => {
  const actual = await vi.importActual<typeof import("../components/auth/AuthShell")>("../components/auth/AuthShell");
  return {
    ...actual,
    AuthShell: ({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) => (
      <main>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
        {children}
      </main>
    ),
  };
});

const { ResetPasswordForm } = await import("../components/auth/ResetPasswordForm");
const { default: ResetPasswordPage } = await import("../app/reset-password/page");
const { RECOVERY_COOKIE, encodeRecovery } = await import("../lib/recovery");
const { FLASH_KEY } = await import("../lib/flash");

async function fill(password: string, confirm = password) {
  fireEvent.change(screen.getByLabelText(new RegExp(`^${en.recovery.newPassword}`)), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(new RegExp(`^${en.recovery.confirmPassword}`)), { target: { value: confirm } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: en.recovery.resetSubmit }));
  });
}

beforeEach(() => {
  h.update.mockReset().mockResolvedValue({ data: {}, error: null });
  h.signOut.mockReset().mockResolvedValue({ error: null });
  h.finish.mockReset().mockResolvedValue(undefined);
  h.replace.mockReset();
  h.refresh.mockReset();
  h.user = null;
  h.jar.clear();
  h.redirected = null;
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe("/reset-password (the page)", () => {
  const now = () => Math.floor(Date.now() / 1000);

  it("without a session it sends the visitor to /forgot-password with a fixed notice", async () => {
    await expect(ResetPasswordPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(h.redirected).toBe("/forgot-password?s=needs_link");
  });

  it("an ordinary signed-in session (no recovery marker) is sent away too", async () => {
    h.user = { id: UID, email: "ana@a.test" };
    await expect(ResetPasswordPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(h.redirected).toBe("/forgot-password?s=needs_link");
  });

  it("a marker for another account, or an expired one, does not open it", async () => {
    h.user = { id: UID, email: "ana@a.test" };
    h.jar.set(RECOVERY_COOKIE, encodeRecovery({ uid: "00000000-0000-4000-8000-000000000000", iat: now() }));
    await expect(ResetPasswordPage()).rejects.toThrow("NEXT_REDIRECT");
    h.jar.set(RECOVERY_COOKIE, encodeRecovery({ uid: UID, iat: now() - 3600 }));
    await expect(ResetPasswordPage()).rejects.toThrow("NEXT_REDIRECT");
  });

  it("a recovery session for this account shows the form, naming whose password it is", async () => {
    h.user = { id: UID, email: "ana@a.test" };
    h.jar.set(RECOVERY_COOKIE, encodeRecovery({ uid: UID, iat: now() }));
    render(await ResetPasswordPage());
    expect(screen.getByRole("heading", { name: en.recovery.resetTitle })).toBeTruthy();
    expect(document.body.textContent).toContain("ana@a.test");
  });
});

describe("the reset form", () => {
  it("applies the SAME policy as sign-up: too short, mismatch, nothing sent", async () => {
    render(<ResetPasswordForm email="ana@a.test" />);
    await fill("short");
    expect(screen.getByRole("alert").textContent).toContain(en.signup.errPasswordShort.replace("{n}", "8"));
    await fill("longenough1", "longenough2");
    expect(screen.getByRole("alert").textContent).toContain(en.signup.errMismatch);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("saves, signs the OTHER sessions out, clears the marker, leaves a one-line notice and goes to the app", async () => {
    render(<ResetPasswordForm email="ana@a.test" />);
    await fill("longenough1");
    expect(h.update).toHaveBeenCalledWith({ password: "longenough1" });
    expect(h.signOut).toHaveBeenCalledWith({ scope: "others" });
    expect(h.finish).toHaveBeenCalled();
    expect(window.sessionStorage.getItem(FLASH_KEY)).toBe("password_changed");
    expect(h.replace).toHaveBeenCalledWith("/");
    // order: password first, then the others are signed out
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.signOut.mock.invocationCallOrder[0]);
  });

  it("a failed save changes nothing else, and never shows the provider's text", async () => {
    h.update.mockResolvedValue({ data: null, error: { code: "weak_password", message: "Password is known to be weak and easy to guess" } });
    render(<ResetPasswordForm email="ana@a.test" />);
    await fill("longenough1");
    expect(screen.getByRole("alert").textContent).toContain(en.recovery.errWeak);
    expect(document.body.textContent).not.toContain("known to be weak");
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("an ended recovery session says so and offers a new link", async () => {
    h.update.mockResolvedValue({ data: null, error: { name: "AuthSessionMissingError", message: "Auth session missing!" } });
    render(<ResetPasswordForm email="ana@a.test" />);
    await fill("longenough1");
    expect(screen.getByRole("alert").textContent).toContain(en.recovery.errSession);
    expect(screen.getByRole("link", { name: en.recovery.requestNew }).getAttribute("href")).toBe("/forgot-password");
  });

  it("the show/hide toggle reveals both fields and is announced as pressed", async () => {
    render(<ResetPasswordForm email="ana@a.test" />);
    const a = screen.getByLabelText(new RegExp(`^${en.recovery.newPassword}`)) as HTMLInputElement;
    const b = screen.getByLabelText(new RegExp(`^${en.recovery.confirmPassword}`)) as HTMLInputElement;
    expect([a.type, b.type]).toEqual(["password", "password"]);
    const toggle = screen.getByRole("button", { name: en.recovery.showPasswords });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect([a.type, b.type]).toEqual(["text", "text"]);
    expect(screen.getByRole("button", { name: en.recovery.hidePasswords }).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not put the password anywhere but the call to Supabase", async () => {
    const spy = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    render(<ResetPasswordForm email="ana@a.test" />);
    await fill("longenough1");
    for (const call of [...spy.mock.calls, ...err.mock.calls]) expect(JSON.stringify(call)).not.toContain("longenough1");
    expect(window.location.href).not.toContain("longenough1");
    expect(window.sessionStorage.length === 0 || !JSON.stringify({ ...window.sessionStorage }).includes("longenough1")).toBe(true);
  });
});
