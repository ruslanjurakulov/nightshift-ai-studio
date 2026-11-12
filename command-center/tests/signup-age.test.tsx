// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { LEGAL_TEXTS, type LegalBlock, type LegalDocument } from "@/lib/legal-docs";

/**
 * The 18+ rule. The model vendors' terms require every end user to be 18 or older (Meta's Model API ToS 10.1: "You and
 * your End Users must be at least 18"), and our vendor letters promised the gate. So the e-mail sign-up has its own
 * required "I confirm I am 18 or older" box, the Google button's consent line says the same, and the Privacy Policy and
 * the Terms state 18 in all three languages. What breaks without these tests: an account created by someone who never
 * said they are an adult, or a policy that still reads 13 in one language.
 */

const h = vi.hoisted(() => ({ signUp: vi.fn(), push: vi.fn(), fetch: vi.fn() }));

vi.mock("@/lib/i18n/public-context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://p.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signUp: h.signUp, getUser: async () => ({ data: { user: { user_metadata: {} } } }) },
    rpc: vi.fn(async () => ({ data: { code: "ok", handle: "ana.k" }, error: null })),
  }),
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

const { default: SignupPage } = await import("../app/signup/page");

const ageBox = () => document.querySelector("input[data-age-confirm]") as HTMLInputElement;
const termsBox = () =>
  [...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].find((b) => !b.hasAttribute("data-age-confirm")) as HTMLInputElement;

async function fill() {
  fireEvent.change(screen.getByLabelText(en.signup.email), { target: { value: "ana@example.com" } });
  fireEvent.change(screen.getByLabelText(new RegExp(`^${en.signup.handleLabel}`)), { target: { value: "ana.k" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
  fireEvent.change(screen.getByLabelText(new RegExp(`^${en.signup.password}`)), { target: { value: "longenough1" } });
  fireEvent.change(screen.getByLabelText(new RegExp(`^${en.signup.confirm}`)), { target: { value: "longenough1" } });
}
async function send() {
  await act(async () => {
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    await vi.advanceTimersByTimeAsync(10);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  h.signUp.mockReset().mockResolvedValue({ data: { user: { identities: [{}] }, session: null }, error: null });
  h.push.mockReset();
  h.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ available: true }) });
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the sign-up form's 18-or-older box", () => {
  it("is its own required, unticked checkbox, labelled with the confirmation", () => {
    render(<SignupPage />);
    const box = ageBox();
    expect(box).toBeTruthy();
    expect(box.type).toBe("checkbox");
    expect(box.required).toBe(true);
    expect(box.checked).toBe(false);
    expect(box.closest("label")?.textContent).toBe(en.signup.ageConfirm);
    expect(screen.getByRole("checkbox", { name: en.signup.ageConfirm })).toBe(box);
    expect(document.querySelectorAll("input[type=checkbox]")).toHaveLength(2);
  });

  it("blocks the submit without it: nothing is sent and the form says why", async () => {
    render(<SignupPage />);
    await fill();
    fireEvent.click(termsBox());
    await send();
    expect(h.signUp).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(en.signup.errAge);
  });

  it("ticking it clears that error, and the account is then created", async () => {
    render(<SignupPage />);
    await fill();
    fireEvent.click(termsBox());
    await send();
    expect(screen.getByRole("alert").textContent).toContain(en.signup.errAge);
    fireEvent.click(ageBox());
    expect(screen.queryByRole("alert")).toBeNull();
    await send();
    expect(h.signUp).toHaveBeenCalledTimes(1);
  });

  it("ticking only the age box is not agreeing to the Terms", async () => {
    render(<SignupPage />);
    await fill();
    fireEvent.click(ageBox());
    await send();
    expect(h.signUp).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(en.signup.errConsent);
  });
});

describe("the 18+ copy, in every language", () => {
  it.each([
    ["uz", uz, "Men 18 yoshga toʻlganimni tasdiqlayman.", "Hisob yaratish uchun 18 yoshga toʻlganingizni tasdiqlang."],
    ["en", en, "I confirm I am 18 or older.", "Confirm that you are 18 or older to create an account."],
    ["ru", ru, "Подтверждаю, что мне исполнилось 18 лет.", "Чтобы создать аккаунт, подтвердите, что вам исполнилось 18 лет."],
  ] as const)("%s: the box and its error", (_l, dict, box, err) => {
    expect(dict.signup.ageConfirm).toBe(box);
    expect(dict.signup.errAge).toBe(err);
  });

  it.each([
    ["uz", uz],
    ["en", en],
    ["ru", ru],
  ] as const)("%s: the Google consent line ends with the 18+ confirmation", (_l, dict) => {
    expect(dict.site.auth.google.consentPost).toMatch(/18/);
  });

  function text(doc: LegalDocument, id: string): string {
    const s = doc.sections.find((x) => x.id === id);
    const strings = (b: LegalBlock): string[] => (typeof b === "string" ? [b] : "list" in b ? b.list : []);
    return s ? s.body.flatMap(strings).join(" ") : "";
  }

  it.each(Object.keys(LEGAL_TEXTS))("%s: the Privacy Policy and the Terms state 18, and no longer 13", (locale) => {
    const t = LEGAL_TEXTS[locale as keyof typeof LEGAL_TEXTS];
    const children = text(t.privacy, "children");
    const accounts = text(t.terms, "accounts");
    expect(children).toMatch(/\b18\b/);
    expect(children).not.toMatch(/\b13\b/);
    expect(accounts).toMatch(/\b18\b/);
    // Both name the Google path too: an account made with the Google button never sees the form's box.
    expect(children).toContain("Google");
    expect(accounts).toContain("Google");
  });
});
