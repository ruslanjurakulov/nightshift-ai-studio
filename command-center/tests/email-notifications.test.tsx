// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/organization",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const rpc = vi.fn();
let client: unknown = null;
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, LOCALES, type Locale } from "@/lib/i18n";
import { EmailNotifications } from "@/components/notifications/EmailNotifications";
import type { EmailPrefs } from "@/lib/email-prefs";

const saved = (over: Record<string, unknown>) => ({
  data: { ready: true, weekly_every_days: null, locale: "en", locale_chosen: false, stored: true, ...over },
  error: null,
});
const initial: EmailPrefs = { ready: true, weeklyEveryDays: null, locale: "en", localeChosen: false, stored: false };

function mount(locale: Locale = "en", prefs: EmailPrefs = initial) {
  return render(
    <I18nProvider locale={locale}>
      <EmailNotifications initial={prefs} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  rpc.mockReset().mockResolvedValue(saved({}));
  client = { rpc };
});
afterEach(() => cleanup());

const e = dictionaries.en.emailNotifications;

describe("Settings → E-mail", () => {
  it("shows ready mail on and the weekly summary off, as the database defaults say", () => {
    mount();
    expect(screen.getByRole("switch", { name: e.readyLabel }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText(e.weeklyLabel) as HTMLSelectElement).value).toBe("0");
    expect(screen.getByText(e.weeklyHint)).toBeTruthy();
  });

  it("turning ready mail off is one call that also carries the language the page is read in", async () => {
    rpc.mockResolvedValue(saved({ ready: false, locale: "ru" }));
    mount("ru");
    const sw = screen.getByRole("switch", { name: dictionaries.ru.emailNotifications.readyLabel });
    fireEvent.click(sw);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("email_prefs_set", { p_ready: false, p_weekly: null, p_locale: "ru" }));
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    expect(await screen.findByText(dictionaries.ru.emailNotifications.saved)).toBeTruthy();
  });

  it("choosing a rhythm sends only the weekly value and shows what the database answered", async () => {
    rpc.mockResolvedValue(saved({ weekly_every_days: 14 }));
    mount();
    const select = screen.getByLabelText(e.weeklyLabel) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "14" } });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("email_prefs_set", { p_ready: null, p_weekly: 14, p_locale: "en" }));
    await waitFor(() => expect(select.value).toBe("14"));
  });

  it("a failed save puts the switch back and says so; a malformed answer is a failure too", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    mount();
    const sw = screen.getByRole("switch", { name: e.readyLabel });
    fireEvent.click(sw);
    expect(await screen.findByText(e.saveFailed)).toBeTruthy();
    expect(sw.getAttribute("aria-checked")).toBe("true");
    rpc.mockResolvedValue({ data: { ready: "maybe" }, error: null });
    fireEvent.click(sw);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("ignores a second press while the first is saving", async () => {
    let release: (v: unknown) => void = () => {};
    rpc.mockReturnValue(new Promise((r) => (release = r)));
    mount();
    const sw = screen.getByRole("switch", { name: e.readyLabel });
    fireEvent.click(sw);
    fireEvent.click(sw);
    expect(rpc).toHaveBeenCalledTimes(1);
    release(saved({ ready: false }));
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
  });
  it("offers exactly the app's languages, each in its own name, with the current one selected", () => {
    mount("ru", { ...initial, locale: "uz", localeChosen: true });
    const select = screen.getByLabelText(dictionaries.ru.emailNotifications.languageLabel) as HTMLSelectElement;
    expect(select.value).toBe("uz");
    expect(Array.from(select.options).map((o) => [o.value, o.text])).toEqual(LOCALES.map((l) => [l.code, l.label]));
    expect(screen.getByText(dictionaries.ru.emailNotifications.languageHint)).toBeTruthy();
  });

  it("choosing a language is one call that carries only the language, and shows what the database answered", async () => {
    rpc.mockResolvedValue(saved({ locale: "uz", locale_chosen: true }));
    mount("en");
    const select = screen.getByLabelText(e.languageLabel) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "uz" } });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("email_prefs_set_language", { p_locale: "uz" }));
    expect(rpc).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(select.value).toBe("uz"));
  });

  it("never sends a language the app does not have, and a failed save leaves the old one", async () => {
    mount("en");
    const select = screen.getByLabelText(e.languageLabel) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "de" } });
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    fireEvent.change(select, { target: { value: "ru" } });
    expect(await screen.findByText(e.saveFailed)).toBeTruthy();
    expect(select.value).toBe("en");
  });
});
