// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({ signIn: vi.fn(), locale: "en" as "en" | "ru" | "uz" }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "k" }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signInWithOAuth: h.signIn } }) }));
vi.mock("@/lib/i18n/public-context", async () => {
  const { dictionaries } = await import("@/lib/i18n");
  const { publicDictionary } = await import("@/lib/i18n/public");
  return { usePublicI18n: () => ({ t: publicDictionary(dictionaries[h.locale]), locale: h.locale }) };
});
// AuthShell pulls in the whole page frame; the button only needs the alert.
vi.mock("@/components/auth/AuthShell", () => ({
  AuthAlert: ({ children }: { children: ReactNode }) => <p role="alert">{children}</p>,
}));

const { GoogleButton } = await import("@/components/auth/GoogleButton");

function at(search: string) {
  window.history.replaceState({}, "", `/login${search}`);
}

beforeEach(() => {
  h.signIn.mockReset();
  h.signIn.mockResolvedValue({ data: {}, error: null });
  h.locale = "en";
  at("");
});
afterEach(cleanup);

describe("GoogleButton", () => {
  it("is a button named 'Continue with Google' with a decorative G", () => {
    const { container } = render(<GoogleButton mode="signin" />);
    const btn = screen.getByRole("button", { name: "Continue with Google" });
    expect((btn as HTMLButtonElement).type).toBe("button");
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    // The four brand colours, and no filled-primary class.
    expect([...svg.querySelectorAll("path")].map((p) => p.getAttribute("fill"))).toEqual(["#EA4335", "#4285F4", "#FBBC05", "#34A853"]);
    expect(btn.className).not.toContain("st-key");
  });

  it("starts Supabase's Google OAuth with this origin's callback and a safe next", async () => {
    at("?next=%2Fall-channels%2Fcommand-center");
    render(<GoogleButton mode="signin" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(h.signIn).toHaveBeenCalledTimes(1));
    const arg = h.signIn.mock.calls[0][0];
    expect(arg.provider).toBe("google");
    const to = new URL(arg.options.redirectTo);
    expect(to.origin).toBe(window.location.origin);
    expect(to.pathname).toBe("/auth/callback");
    expect(to.searchParams.get("next")).toBe("/all-channels/command-center");
  });

  it("an off-site next is replaced; sign-up defaults to /welcome, sign-in to the app", async () => {
    at("?next=https%3A%2F%2Fevil.example");
    const a = render(<GoogleButton mode="signup" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(h.signIn).toHaveBeenCalledTimes(1));
    expect(new URL(h.signIn.mock.calls[0][0].options.redirectTo).searchParams.get("next")).toBe("/welcome");
    a.unmount();
    h.signIn.mockClear();
    render(<GoogleButton mode="signin" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(h.signIn).toHaveBeenCalledTimes(1));
    expect(new URL(h.signIn.mock.calls[0][0].options.redirectTo).searchParams.get("next")).toBe("/command-center");
  });

  it("shows a fixed message when starting fails, with no provider text", async () => {
    h.signIn.mockResolvedValue({ data: {}, error: { message: "Provider is not enabled: secret detail" } });
    render(<GoogleButton mode="signin" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't sign you in with Google");
    expect(alert.textContent).not.toContain("secret");
  });

  it.each([
    ["google_denied", "cancelled"],
    ["google_unverified", "has not confirmed"],
    ["google_failed", "Couldn't sign you in"],
  ])("shows the fixed message for ?error=%s", async (code, words) => {
    at(`?error=${code}`);
    render(<GoogleButton mode="signin" />);
    expect((await screen.findByRole("alert")).textContent).toContain(words);
  });

  it("ignores an error value that is not in the closed set", () => {
    at("?error=%3Cb%3Ehi%3C%2Fb%3E");
    render(<GoogleButton mode="signin" />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sign-up carries the consent line with the Terms and Privacy links; sign-in does not", () => {
    const up = render(<GoogleButton mode="signup" />);
    expect(up.container.textContent).toContain("By continuing you agree to the Terms and Privacy Policy.");
    expect(screen.getByRole("link", { name: "Terms" }).getAttribute("href")).toBe("/terms");
    expect(screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe("/privacy");
    up.unmount();
    const inn = render(<GoogleButton mode="signin" />);
    expect(inn.container.textContent).not.toContain("By continuing");
    expect(inn.container.textContent).toContain("or");
  });

  it.each([
    ["ru", "Продолжить с Google"],
    ["uz", "Google bilan davom etish"],
  ] as const)("is translated (%s)", (locale, label) => {
    h.locale = locale;
    render(<GoogleButton mode="signup" />);
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
  });
});
