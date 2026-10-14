// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";

const h = vi.hoisted(() => ({ reset: vi.fn(), locale: "en" as "en" | "ru" | "uz" }));

vi.mock("@/lib/i18n/public-context", async () => {
  const { dictionaries, fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: dictionaries[h.locale], locale: h.locale, fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://p.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { resetPasswordForEmail: h.reset } }) }));
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

const { default: ForgotPasswordPage } = await import("../app/forgot-password/page");

async function submit(email: string) {
  fireEvent.change(screen.getByLabelText(en.auth.email), { target: { value: email } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: en.recovery.forgotSubmit }));
  });
}

beforeEach(() => {
  h.reset.mockReset().mockResolvedValue({ data: {}, error: null });
  h.locale = "en";
  window.history.pushState({}, "", "/forgot-password");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("/forgot-password", () => {
  it("asks for a link back to /auth/callback?next=/reset-password on this site", async () => {
    render(<ForgotPasswordPage />);
    await submit("ana@example.com");
    expect(h.reset).toHaveBeenCalledWith("ana@example.com", {
      redirectTo: `${window.location.origin}/auth/callback?next=%2Freset-password`,
    });
  });

  it("shows the SAME confirmation for a known address, an unknown one and every provider failure", async () => {
    const shown: string[] = [];
    const answers = [
      { data: {}, error: null },
      { data: null, error: { code: "user_not_found", status: 400, message: "User not found" } },
      { data: null, error: { code: "over_email_send_rate_limit", status: 429, message: "email rate limit exceeded" } },
      { data: null, error: { status: 500, message: "Database error finding user" } },
    ];
    for (const answer of answers) {
      cleanup();
      h.reset.mockReset().mockResolvedValue(answer);
      render(<ForgotPasswordPage />);
      await submit("ana@example.com");
      shown.push(document.body.textContent ?? "");
    }
    h.reset.mockReset().mockRejectedValue(new Error("network down"));
    cleanup();
    render(<ForgotPasswordPage />);
    await submit("ana@example.com");
    shown.push(document.body.textContent ?? "");
    expect(new Set(shown).size).toBe(1);
    expect(shown[0]).toContain(en.recovery.sentTitle);
    expect(shown[0]).toContain(en.recovery.sentBody.replace("{email}", "ana@example.com"));
    for (const leak of ["not found", "rate limit", "Database error", "network down", "429", "500"]) expect(shown[0]).not.toContain(leak);
  });

  it("says the neutral sentence in all three languages (if an account exists, we sent a link)", () => {
    expect(en.recovery.sentBody).toMatch(/If an account exists/);
    expect(ru.recovery.sentBody).toMatch(/Если для \{email\} есть аккаунт/);
    expect(uz.recovery.sentBody).toMatch(/hisob mavjud boʻlsa/);
    for (const d of [en, ru, uz]) expect(d.recovery.sentBody).toContain("{email}");
  });

  it("only a malformed address is refused, and nothing is sent for it", async () => {
    render(<ForgotPasswordPage />);
    await submit("not-an-email");
    expect(h.reset).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(en.recovery.errEmail);
  });

  it("'send again' waits 60 seconds, counting down", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date", "setTimeout", "clearTimeout"] });
    render(<ForgotPasswordPage />);
    await submit("ana@example.com");
    const again = screen.getByRole("button", { name: /Send again in 60 s/ }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect((screen.getByRole("button", { name: /Send again in 30 s/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(30_500);
    });
    const ready = screen.getByRole("button", { name: en.recovery.resend }) as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    h.reset.mockClear();
    await act(async () => {
      fireEvent.click(ready);
    });
    expect(h.reset).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: /Send again in 60 s/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains an expired or missing link with a fixed notice from the closed set only", () => {
    window.history.pushState({}, "", "/forgot-password?s=expired");
    render(<ForgotPasswordPage />);
    expect(screen.getByRole("alert").textContent).toContain(en.recovery.noticeExpired);
    cleanup();
    window.history.pushState({}, "", "/forgot-password?s=needs_link");
    render(<ForgotPasswordPage />);
    expect(screen.getByRole("alert").textContent).toContain(en.recovery.noticeNeedsLink);
    cleanup();
    window.history.pushState({}, "", "/forgot-password?s=%3Cb%3Ehi");
    render(<ForgotPasswordPage />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("links back to sign in, and the sign-in page links here", () => {
    render(<ForgotPasswordPage />);
    expect(screen.getByRole("link", { name: en.recovery.backToSignIn }).getAttribute("href")).toBe("/login");
  });
});
