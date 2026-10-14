// @vitest-environment jsdom
/**
 * Every sign-out, expired session and account switch lands on /login; arriving
 * there removes any create draft left in this tab (lib/create-draft.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { dictionaries, fmt } from "../lib/i18n";
import { DRAFT_PREFIX } from "../lib/create-draft";

vi.mock("@/lib/i18n/public-context", () => ({ usePublicI18n: () => ({ t: dictionaries.en, locale: "en", fmt, setLocale: () => {} }) }));
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

describe("/login", () => {
  it("removes every create draft in the tab and leaves everything else", async () => {
    window.sessionStorage.setItem(`${DRAFT_PREFIX}v1.u1.o1.c1`, "{}");
    window.sessionStorage.setItem(`${DRAFT_PREFIX}v1.u2.o2.c2`, "{}");
    window.sessionStorage.setItem("unrelated", "keep");
    render(<LoginPage />);
    await act(async () => {});
    expect(Object.keys(window.sessionStorage).filter((k) => k.startsWith(DRAFT_PREFIX))).toEqual([]);
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep");
  });
});
