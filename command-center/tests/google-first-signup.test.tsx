// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";

/**
 * Google first, the way Krea does it: once the owner switches the Google provider on in Supabase, /signup and /login
 * open with one white "Continue with Google" key, its consent line, a quiet "or", and only then the e-mail form, whose
 * submit steps down to the quiet key so the page has one primary choice. While the provider is off, the pages are
 * exactly the e-mail form they were: no button, no divider, the filled submit.
 *
 * What breaks without these: a page with two primary keys (the white one and the indigo submit), a dangling "or" with
 * nothing above it on a project where Google is off, or a Google sign-up that skips the Terms/18+ statement because the
 * consent line moved away from the button.
 */

const h = vi.hoisted(() => ({ locale: "en" as "en" | "ru" | "uz" }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/i18n/public-context", async () => {
  const { dictionaries, fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: dictionaries[h.locale], locale: h.locale, fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://p.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithPassword: vi.fn(), signUp: vi.fn(), signInWithOAuth: vi.fn() } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/auth/AuthShell", async () => {
  const actual = await vi.importActual<typeof import("../components/auth/AuthShell")>("../components/auth/AuthShell");
  return {
    ...actual,
    AuthShell: ({ title, children }: { title: string; children: ReactNode }) => (
      <main>
        <h1>{title}</h1>
        {children}
      </main>
    ),
  };
});

const { default: SignupPage } = await import("../app/signup/page");
const { default: LoginPage } = await import("../app/login/page");
const { GoogleEnabledProvider } = await import("@/components/auth/google-enabled-context");
const { resetGoogleEnabledCache } = await import("@/lib/google-signin");

const pages = [
  ["/signup", SignupPage],
  ["/login", LoginPage],
] as const;

function at(path: string) {
  window.history.replaceState({}, "", path);
}

/** The page as the server renders it, with the server's answer about the Google provider. */
function renderPage(Page: () => ReactNode, enabled: boolean | undefined) {
  if (enabled === undefined) return render(<Page />);
  return render(
    <GoogleEnabledProvider enabled={enabled}>
      <Page />
    </GoogleEnabledProvider>,
  );
}

const submit = (c: HTMLElement) => c.querySelector("button[type=submit]") as HTMLButtonElement;

beforeEach(() => {
  h.locale = "en";
  resetGoogleEnabledCache();
  // Only the browser-side fallback would ask; a test that expects no ask checks this was never called.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ external: { google: false } }) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Google enabled: the first and primary choice", () => {
  it.each(pages)("%s: the Google key comes before every other control, then the consent line, the 'or', the form", (path, Page) => {
    at(path);
    const { container } = renderPage(Page, true);
    const google = screen.getByRole("button", { name: en.site.auth.google.button });
    // First button on the page, and before the e-mail form in document order.
    expect(container.querySelector("button")).toBe(google);
    const form = container.querySelector("form")!;
    expect(google.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Before the e-mail field itself, not only before the <form> element.
    const email = screen.getByLabelText(path === "/signup" ? en.signup.email : en.auth.email);
    expect(google.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const order = [...container.querySelectorAll(".ns-google-btn, .ns-google-consent, .ns-google-or, form")].map((n) =>
      n.tagName === "FORM" ? "form" : n.className,
    );
    expect(order).toEqual(["ns-google-btn", "ns-google-consent", "ns-google-or", "form"]);
  });

  it.each(pages)("%s: the e-mail submit steps down to the quiet key, so Google is the one primary key", (path, Page) => {
    at(path);
    const { container } = renderPage(Page, true);
    const google = screen.getByRole("button", { name: en.site.auth.google.button });
    expect(google.className).not.toContain("st-key");
    expect(submit(container).getAttribute("data-tone")).toBe("quiet");
    // Exactly one key on the page is not quiet: Google's.
    const loud = [...container.querySelectorAll("button")].filter((b) => b.classList.contains("st-key") && !b.hasAttribute("data-tone"));
    expect(loud).toEqual([]);
  });

  it.each(pages)("%s: the consent line (Terms, Privacy, 18+) is still directly under the button", (path, Page) => {
    at(path);
    const { container } = renderPage(Page, true);
    const consent = container.querySelector(".ns-google-consent")!;
    expect(consent.textContent).toBe(
      "By continuing you agree to the Terms of Service and Privacy Policy and confirm you are 18 or older.",
    );
    expect(consent.previousElementSibling).toBe(screen.getByRole("button", { name: en.site.auth.google.button }));
    expect(consent.querySelector('a[href="/terms"]')).toBeTruthy();
    expect(consent.querySelector('a[href="/privacy"]')).toBeTruthy();
  });

  it.each([
    ["ru", ru],
    ["uz", uz],
  ] as const)("the key and its 'or' are translated (%s)", (locale, dict) => {
    h.locale = locale;
    at("/signup");
    const { container } = renderPage(SignupPage, true);
    expect(screen.getByRole("button", { name: dict.site.auth.google.button })).toBeTruthy();
    expect(container.querySelector(".ns-google-or")!.textContent).toBe(dict.site.auth.google.or);
    expect(container.querySelector(".ns-google-consent")!.textContent).toContain("18");
  });

  it("without a server answer, the page asks once and promotes Google only on a clear yes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ external: { google: true } }) })));
    at("/login");
    const { container } = renderPage(LoginPage, undefined);
    await screen.findByRole("button", { name: en.site.auth.google.button });
    expect(submit(container).getAttribute("data-tone")).toBe("quiet");
    // The page and the button share one remembered answer: one request, not two.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Google not enabled: the page is the e-mail form as before", () => {
  it.each(pages)("%s: no Google key, no divider, no consent line of its own, the filled submit", async (path, Page) => {
    at(path);
    const { container } = renderPage(Page, false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: en.site.auth.google.button })).toBeNull();
    expect(container.querySelector(".ns-google")).toBeNull();
    expect(container.querySelector(".ns-google-or")).toBeNull();
    expect(container.querySelector(".ns-google-consent")).toBeNull();
    expect(submit(container).hasAttribute("data-tone")).toBe(false);
    expect(submit(container).className).toContain("st-key");
    // The server said no: the browser does not ask behind its back.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the sign-up form keeps its own Terms and 18+ boxes", () => {
    at("/signup");
    const { container } = renderPage(SignupPage, false);
    expect(container.querySelector("input[data-age-confirm]")).toBeTruthy();
    expect(screen.getByText(en.signup.ageConfirm)).toBeTruthy();
  });

  it("a Google failure that came back in the URL is still explained, with no button and no divider", () => {
    at("/login?error=google_denied");
    const { container } = renderPage(LoginPage, false);
    expect(screen.getByRole("alert").textContent).toBe(en.site.auth.google.errDenied);
    expect(container.querySelector(".ns-google-btn")).toBeNull();
    expect(container.querySelector(".ns-google-or")).toBeNull();
    expect(submit(container).hasAttribute("data-tone")).toBe(false);
  });
});

// jsdom has no stylesheet engine, so the look is pinned on the stylesheet itself.
describe("the Google key follows Google's light button", () => {
  const css = readFileSync(join(__dirname, "..", "components/auth/google-button.css"), "utf8");
  const rule = (sel: string) => {
    const m = css.match(new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`));
    expect(m, sel).not.toBeNull();
    return m![1];
  };

  it("white fill, #747775 stroke, #1F1F1F label, fixed (not theme) colours", () => {
    const btn = rule(".ns-google-btn");
    expect(btn).toMatch(/background:\s*#ffffff;/i);
    expect(btn).toMatch(/border:\s*1px solid #747775;/i);
    expect(btn).toMatch(/color:\s*#1f1f1f;/i);
    expect(btn).not.toMatch(/var\(--ns-text\)/);
  });

  it("48 to 52 px tall, full width, rounded like the inputs", () => {
    const btn = rule(".ns-google-btn");
    const height = Number(btn.match(/min-height:\s*(\d+)px/)![1]);
    expect(height).toBeGreaterThanOrEqual(48);
    expect(height).toBeLessThanOrEqual(52);
    expect(btn).toMatch(/width:\s*100%/);
    const next = readFileSync(join(__dirname, "..", "components/site/site-next.css"), "utf8");
    const inputRadius = next.match(/\.nx \.st-field input \{[^}]*border-radius:\s*(\d+px)/)![1];
    expect(css).toContain(`.nx .ns-google-btn { border-radius: ${inputRadius}; }`);
    // Not the pill it used to be.
    expect(css).not.toMatch(/\.ns-google-btn[^{]*\{[^}]*border-radius:\s*999px/);
  });

  it("the busy spinner is drawn in colours that show on white in both themes", () => {
    const spin = rule(".ns-google-spin");
    expect(spin).not.toMatch(/var\(--ns-/);
  });
});
