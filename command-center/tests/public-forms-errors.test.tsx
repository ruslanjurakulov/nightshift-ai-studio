// @vitest-environment jsdom
/**
 * Launch checklist item 6 ("forms work"): the sign-in and sign-up forms, with a
 * fake backend, in every language, in their ERROR states. Each failure must say
 * what to do in the visitor's own words, never show the backend's text, never
 * navigate, and leave the button usable again so the person can retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LOCALES } from "../lib/i18n";

const h = vi.hoisted(() => ({
  locale: "en" as string,
  signIn: vi.fn(),
  signUp: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/lib/i18n/public-context", async () => {
  const { dictionaries, fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: dictionaries[h.locale as "en"], locale: h.locale, fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://p.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithPassword: h.signIn, signUp: h.signUp, getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, refresh: vi.fn(), replace: vi.fn() }) }));
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

const { dictionaries } = await import("../lib/i18n");
const { default: LoginPage } = await import("../app/login/page");
const { default: SignupPage } = await import("../app/signup/page");

const t = () => dictionaries[h.locale as "en"];
const FAKE = { email: "nobody@example.invalid", password: "not-a-real-password-1" };

beforeEach(() => {
  h.signIn.mockReset();
  h.signUp.mockReset();
  h.push.mockReset();
});
afterEach(cleanup);

async function signIn() {
  render(<LoginPage />);
  fireEvent.change(screen.getByLabelText(t().auth.email), { target: { value: FAKE.email } });
  fireEvent.change(screen.getByLabelText(t().auth.password), { target: { value: FAKE.password } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: t().auth.signIn }));
  });
}

describe.each(LOCALES.map((l) => l.code))("sign-in errors (%s)", (locale) => {
  beforeEach(() => {
    h.locale = locale;
  });

  it.each([
    ["wrong credentials", { code: "invalid_credentials", status: 400, message: "Invalid login credentials" }, (d: ReturnType<typeof t>) => d.signup.loginInvalid],
    ["unconfirmed e-mail", { code: "email_not_confirmed", status: 400, message: "Email not confirmed" }, (d: ReturnType<typeof t>) => d.signup.loginNotConfirmed],
    ["rate limit", { code: "over_request_rate_limit", status: 429, message: "rate limit" }, (d: ReturnType<typeof t>) => d.signup.loginRateLimited],
    ["server failure", { status: 500, message: "Database error querying schema" }, (d: ReturnType<typeof t>) => d.signup.loginFailed],
    ["network failure", { name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" }, (d: ReturnType<typeof t>) => d.signup.loginFailed],
  ])("%s: says what to do in the visitor's language, hides the backend's wording, stays on the page and lets them retry", async (_n, error, expected) => {
    h.signIn.mockResolvedValue({ data: {}, error });
    await signIn();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(expected(t()));
    expect(alert.textContent).not.toContain(error.message);
    expect(h.push).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: t().auth.signIn }) as HTMLButtonElement).disabled).toBe(false);
    // and the e-mail the person typed is still there
    expect((screen.getByLabelText(t().auth.email) as HTMLInputElement).value).toBe(FAKE.email);
  });
});

describe.each(LOCALES.map((l) => l.code))("sign-up errors (%s)", (locale) => {
  beforeEach(() => {
    h.locale = locale;
  });

  it("an empty form is refused in the visitor's language and nothing is sent", async () => {
    render(<SignupPage />);
    const form = document.querySelector("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(screen.getByRole("alert").textContent?.length).toBeGreaterThan(5);
    expect(h.signUp).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("the sign-up form has a labelled field for every input and a submit button", () => {
    render(<SignupPage />);
    for (const input of document.querySelectorAll("form input:not([type=hidden]):not([type=checkbox])")) {
      expect((input as HTMLInputElement).labels?.length ?? 0, input.outerHTML).toBeGreaterThan(0);
    }
    expect(document.querySelector("form button[type=submit], form button:not([type])")).not.toBeNull();
  });
});
