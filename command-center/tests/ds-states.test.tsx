// @vitest-environment jsdom
/**
 * The shared states S5 added (components/ds/States.tsx). What would break without these: an insufficient-credits state
 * that shows a number the server never sent, a provider-down state that offers to substitute a model (rule 4), a session
 * state that promises a draft was kept when it was not, and any of the three in English to a Russian or Uzbek reader.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n/context";
import { InsufficientCredits, ProviderUnavailable, SessionExpired } from "@/components/ds/States";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

afterEach(cleanup);

const wrap = (ui: React.ReactNode, locale: "en" | "ru" | "uz" = "en") => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);

describe("InsufficientCredits", () => {
  it("shows the server's two numbers and one way forward", () => {
    wrap(<InsufficientCredits needed={1200} available={300} addCreditsHref="/billing" />);
    const state = screen.getByRole("alert");
    expect(state.textContent).toContain("1,200");
    expect(state.textContent).toContain("300");
    expect(screen.getByRole("link", { name: en.common.noCreditsAdd }).getAttribute("href")).toBe("/billing");
  });

  it("reads 'unknown' for a number the server did not send, never 0", () => {
    wrap(<InsufficientCredits needed={null} available={null} addCreditsHref="/billing" />);
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toContain(en.common.unknown);
    expect(text).not.toMatch(/\b0\b/);
  });
});

describe("ProviderUnavailable", () => {
  it("names the provider and offers only the person's own choices", () => {
    const choose = vi.fn();
    wrap(<ProviderUnavailable provider="ElevenLabs" onChooseAnother={choose} />);
    expect(screen.getByRole("alert").textContent).toContain("ElevenLabs");
    fireEvent.click(screen.getByRole("button", { name: en.common.providerDownChoose }));
    expect(choose).toHaveBeenCalledOnce();
  });

  it("has no way to pick a substitute by itself", () => {
    // Rule 4: the only props are the provider's name, the person's choose/retry and layout.
    wrap(<ProviderUnavailable provider="Kling" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(en.common.providerDownBody).toMatch(/will not swap in another/);
  });
});

describe("SessionExpired", () => {
  it("promises a kept draft only when the caller says it holds one", () => {
    wrap(<SessionExpired signInHref="/login?next=/x" />);
    expect(screen.getByRole("alert").textContent).toContain(en.common.sessionExpiredBody);
    expect(screen.getByRole("alert").textContent).not.toContain(en.common.sessionExpiredKept);
    cleanup();
    wrap(<SessionExpired signInHref="/login?next=/x" draftKept />);
    expect(screen.getByRole("alert").textContent).toContain(en.common.sessionExpiredKept);
    expect(screen.getByRole("link", { name: en.common.sessionExpiredSignIn }).getAttribute("href")).toBe("/login?next=/x");
  });
});

describe("copy", () => {
  const keys = [
    "noCreditsTitle",
    "noCreditsBody",
    "noCreditsAdd",
    "providerDownTitle",
    "providerDownBody",
    "providerDownChoose",
    "sessionExpiredTitle",
    "sessionExpiredBody",
    "sessionExpiredKept",
    "sessionExpiredSignIn",
  ] as const;

  it("exists in en, ru and uz, translated, with the placeholders kept", () => {
    for (const k of keys) {
      for (const d of [ru, uz]) {
        expect(d.common[k], k).toBeTruthy();
        expect(d.common[k], k).not.toBe(en.common[k]);
        for (const ph of en.common[k].match(/\{\w+\}/g) ?? []) expect(d.common[k], `${k} ${ph}`).toContain(ph);
      }
    }
  });

  it("writes Uzbek with the modifier letters, not ASCII apostrophes", () => {
    for (const k of keys) expect(uz.common[k], k).not.toMatch(/['`’]/);
  });

  it("renders in Russian", () => {
    wrap(<InsufficientCredits needed={5} available={1} addCreditsHref="/b" />, "ru");
    expect(screen.getByRole("alert").textContent).toContain(ru.common.noCreditsTitle);
  });
});
