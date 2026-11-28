// @vitest-environment jsdom
/**
 * Public pages and the 404 for a visitor who is signed in (audit 2026-11-21, L1-03): they were offered "Sign in" and
 * "Start free" on Pricing, the docs and the 404, as if they had no account. What would break without this: a signed-in
 * person sent back through sign-up; or the fix making a static public page read the session on the server (dynamic).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/pricing",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { PublicShell } from "@/components/legal/PublicShell";
import { APP_HOME, hasSessionCookie } from "@/lib/session-hint";

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const SESSION = "sb-abcdefghijklmnopqrst-auth-token";

function clearCookies() {
  for (const c of document.cookie.split(";")) {
    const name = c.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

afterEach(() => {
  cleanup();
  clearCookies();
});

function shell(locale: "en" | "ru" | "uz") {
  const t = dictionaries[locale];
  return (
    <PublicI18nProvider locale={locale} t={publicDictionary(t)}>
      <PublicShell t={t}>
        <p>page</p>
      </PublicShell>
    </PublicI18nProvider>
  );
}

const hrefs = () => [...document.querySelectorAll<HTMLAnchorElement>("header.st-header a[href]")].map((a) => a.getAttribute("href"));

describe("hasSessionCookie: the name of the Supabase session cookie, never its value", () => {
  it("is true for the session cookie and its first chunk, and for nothing else", () => {
    expect(hasSessionCookie(`${SESSION}=base64-x`)).toBe(true);
    expect(hasSessionCookie(`ns_locale=uz; ${SESSION}.0=base64-x; ${SESSION}.1=y`)).toBe(true);
    expect(hasSessionCookie("")).toBe(false);
    expect(hasSessionCookie("ns_locale=uz; theme=dark")).toBe(false);
    // An emptied cookie (a sign-out that expired it) is not a session; neither is the PKCE verifier.
    expect(hasSessionCookie(`${SESSION}=`)).toBe(false);
    expect(hasSessionCookie(`${SESSION}-code-verifier=abc`)).toBe(false);
    expect(hasSessionCookie(`x${SESSION}=abc`)).toBe(false);
  });

  it("opens the app at the every-channel index, which sends each account to its own start", () => {
    expect(APP_HOME).toBe("/all-channels");
  });
});

describe("the public header, signed out: unchanged", () => {
  it("renders Sign in and Start free on the server, and no Open app key", () => {
    const html = renderToStaticMarkup(shell("en"));
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/signup"');
    expect(html).not.toContain(`href="${APP_HOME}"`);
  });

  it("keeps them in the browser when there is no session cookie", () => {
    render(shell("uz"));
    expect(hrefs()).toContain("/login");
    expect(hrefs()).toContain("/signup");
    expect(screen.queryByTestId("public-open-app")).toBeNull();
  });
});

describe("the public header, signed in: one Open app key", () => {
  for (const [locale, word] of [
    ["en", "Open app"],
    ["ru", "Кабинет"],
    ["uz", "Kabinet"],
  ] as const) {
    it(`${locale}: "${word}" replaces Sign in and Start free, in the bar and the phone's menu`, async () => {
      document.cookie = `${SESSION}=base64-x; path=/`;
      render(shell(locale));
      const key = await waitFor(() => screen.getByTestId("public-open-app"));
      expect(key.textContent).toBe(word);
      expect(key.getAttribute("href")).toBe(APP_HOME);
      expect(hrefs()).not.toContain("/login");
      expect(hrefs()).not.toContain("/signup");
      // One Open app key in the bar, and the phone sheet's pinned key (its foot) is the same one destination.
      const keys = [...document.querySelectorAll<HTMLAnchorElement>(`header.st-header a[href="${APP_HOME}"]`)];
      expect(keys.filter((a) => !a.closest(".st-menu-root"))).toHaveLength(1);
      expect(keys.filter((a) => a.closest(".st-menu-foot"))).toHaveLength(1);
      expect(keys).toHaveLength(2);
    });
  }

  it("has the word in all three dictionaries", () => {
    expect(dictionaries.en.site.nav.openApp).toBe("Open app");
    expect(dictionaries.ru.site.nav.openApp).toBe("Кабинет");
    expect(dictionaries.uz.site.nav.openApp).toBe("Kabinet");
  });
});

describe("no server-side session read on a public page", () => {
  it("PublicShell, the swap and the 404 read no cookies() or headers(), and the swap imports no dictionary", () => {
    const read = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8");
    for (const f of ["components/legal/PublicShell.tsx", "components/legal/SessionSwap.tsx", "app/not-found.tsx", "lib/session-hint.ts"]) {
      expect(read(f), f).not.toMatch(/\bcookies\(\)|\bheaders\(\)|@supabase\/|createClient/);
    }
    expect(read("components/legal/SessionSwap.tsx")).not.toMatch(/@\/lib\/i18n/);
  });
});
