// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";

const h = vi.hoisted(() => ({ locale: "en" as "en" | "ru" | "uz" }));

vi.mock("@/lib/i18n/public-context", async () => {
  const { dictionaries, fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: dictionaries[h.locale], locale: h.locale, fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://p.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signInWithPassword: vi.fn() } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/auth/AuthShell", async () => {
  const actual = await vi.importActual<typeof import("../components/auth/AuthShell")>("../components/auth/AuthShell");
  return {
    ...actual,
    AuthShell: ({ title, children }: { title: string; children: React.ReactNode }) => (
      <main>
        <h1>{title}</h1>
        {children}
      </main>
    ),
  };
});

const { default: LoginPage } = await import("../app/login/page");

afterEach(cleanup);

describe("/login links to the reset flow", () => {
  it.each([
    ["en", en],
    ["ru", ru],
    ["uz", uz],
  ] as const)("a plain 'Forgot password?' link in %s, after the password field", (locale, dict) => {
    h.locale = locale;
    render(<LoginPage />);
    const link = screen.getByRole("link", { name: dict.signup.forgotLink });
    expect(link.getAttribute("href")).toBe("/forgot-password");
    const password = screen.getByLabelText(dict.auth.password);
    expect(password.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
