// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const { GoogleButton: Button } = await import("@/components/auth/GoogleButton");
const { resetGoogleEnabledCache } = await import("@/lib/google-signin");

/** The button after Supabase has answered that the Google provider is on. */
function GoogleButton(props: { mode: "signin" | "signup" }) {
  return <Button {...props} />;
}

function settings(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => body })));
}

function at(search: string) {
  window.history.replaceState({}, "", `/login${search}`);
}

beforeEach(() => {
  resetGoogleEnabledCache();
  settings({ external: { google: true } });
  h.signIn.mockReset();
  h.signIn.mockResolvedValue({ data: {}, error: null });
  h.locale = "en";
  at("");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GoogleButton", () => {
  it("is a button named 'Continue with Google' with a decorative G", async () => {
    const { container } = render(<GoogleButton mode="signin" />);
    const btn = (await screen.findByRole("button", { name: "Continue with Google" }));
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
    fireEvent.click((await screen.findByRole("button", { name: "Continue with Google" })));
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
    fireEvent.click((await screen.findByRole("button", { name: "Continue with Google" })));
    await waitFor(() => expect(h.signIn).toHaveBeenCalledTimes(1));
    expect(new URL(h.signIn.mock.calls[0][0].options.redirectTo).searchParams.get("next")).toBe("/welcome");
    a.unmount();
    h.signIn.mockClear();
    render(<GoogleButton mode="signin" />);
    fireEvent.click((await screen.findByRole("button", { name: "Continue with Google" })));
    await waitFor(() => expect(h.signIn).toHaveBeenCalledTimes(1));
    expect(new URL(h.signIn.mock.calls[0][0].options.redirectTo).searchParams.get("next")).toBe("/command-center");
  });

  it("shows a fixed message when starting fails, with no provider text", async () => {
    h.signIn.mockResolvedValue({ data: {}, error: { message: "Provider is not enabled: secret detail" } });
    render(<GoogleButton mode="signin" />);
    fireEvent.click((await screen.findByRole("button", { name: "Continue with Google" })));
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

  it("sign-up carries the consent line with the Terms and Privacy links; sign-in does not", async () => {
    const up = render(<GoogleButton mode="signup" />);
    await screen.findByRole("button", { name: "Continue with Google" });
    expect(up.container.textContent).toContain("By continuing you agree to the Terms of Service and Privacy Policy.");
    expect(screen.getByRole("link", { name: "Terms of Service" }).getAttribute("href")).toBe("/terms");
    expect(screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe("/privacy");
    up.unmount();
    const inn = render(<GoogleButton mode="signin" />);
    await screen.findByRole("button", { name: "Continue with Google" });
    expect(inn.container.textContent).not.toContain("By continuing");
    expect(inn.container.textContent).toContain("or");
  });

  it.each([
    ["ru", "Продолжить с Google"],
    ["uz", "Google bilan davom etish"],
  ] as const)("is translated (%s)", async (locale, label) => {
    h.locale = locale;
    render(<GoogleButton mode="signup" />);
    expect((await screen.findByRole("button", { name: label }))).toBeTruthy();
  });

  it("while the round trip starts: aria-busy, a spinner in the mark's box, the same label", async () => {
    h.signIn.mockReturnValue(new Promise(() => undefined));
    const { container } = render(<GoogleButton mode="signin" />);
    const btn = (await screen.findByRole("button", { name: "Continue with Google" }));
    expect(btn.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute("aria-busy")).toBe("true"));
    expect(container.querySelector(".ns-google-spin")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
    expect((await screen.findByRole("button", { name: "Continue with Google" }))).toBe(btn);
    // A second click while busy starts nothing more.
    fireEvent.click(btn);
    expect(h.signIn).toHaveBeenCalledTimes(1);
  });

  it("comes back from the back/forward cache ready to press again, but only for a persisted page", async () => {
    h.signIn.mockReturnValue(new Promise(() => undefined));
    const { container } = render(<GoogleButton mode="signin" />);
    const btn = (await screen.findByRole("button", { name: "Continue with Google" }));
    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute("aria-busy")).toBe("true"));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    });
    expect(btn.getAttribute("aria-busy")).toBe("true");
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    expect(btn.getAttribute("aria-busy")).toBeNull();
    expect(container.querySelector(".ns-google-spin")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  describe("honest while the provider is off", () => {
    const quiet = async () => {
      // let the settings request settle
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    it.each([
      ["google is off", { external: { google: false, email: true } }, true],
      ["no external list", {}, true],
      ["google is the string 'true'", { external: { google: "true" } }, true],
      ["the settings request answers an error", { external: { google: true } }, false],
    ])("renders nothing when %s", async (_n, body, ok) => {
      settings(body, ok);
      const { container } = render(<GoogleButton mode="signin" />);
      await quiet();
      expect(container.innerHTML).toBe("");
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("renders nothing when the settings request fails to connect", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
      const { container } = render(<GoogleButton mode="signin" />);
      await quiet();
      expect(container.innerHTML).toBe("");
    });

    it("asks the project's settings with the anon key only, once", async () => {
      render(<GoogleButton mode="signin" />);
      await screen.findByRole("button", { name: "Continue with Google" });
      render(<GoogleButton mode="signup" />);
      const f = fetch as unknown as ReturnType<typeof vi.fn>;
      expect(f).toHaveBeenCalledTimes(1);
      expect(f.mock.calls[0][0]).toBe("https://x.supabase.co/auth/v1/settings");
      expect(f.mock.calls[0][1]).toEqual({ headers: { apikey: "k" } });
    });

    it("still explains a failure that came back in the URL, without a button", async () => {
      settings({ external: { google: false } });
      at("?error=google_failed");
      render(<GoogleButton mode="signin" />);
      expect((await screen.findByRole("alert")).textContent).toContain("Couldn't sign you in");
      await quiet();
      expect(screen.queryByRole("button")).toBeNull();
    });
  });
});

describe("GoogleButton with the server's answer (no layout jump)", () => {
  it("is in the very first render when the server said on, and asks no one", async () => {
    const { GoogleEnabledProvider } = await import("@/components/auth/google-enabled-context");
    const { container } = render(
      <GoogleEnabledProvider enabled>
        <Button mode="signin" />
      </GoogleEnabledProvider>,
    );
    // Synchronously, before any request could have come back.
    expect(container.querySelector(".ns-google-btn")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is absent from the first render when the server said off, whatever the browser could learn", async () => {
    const { GoogleEnabledProvider } = await import("@/components/auth/google-enabled-context");
    const { container } = render(
      <GoogleEnabledProvider enabled={false}>
        <Button mode="signup" />
      </GoogleEnabledProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.innerHTML).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });
});
