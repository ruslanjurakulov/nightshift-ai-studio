// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * The "Add to Home Screen" tip: only for a touch device that is not already the installed app, only after the quiet
 * delay, once per device, and on Android only when the browser itself offered an install.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, LOCALES } from "@/lib/i18n";
import { InstallHint } from "@/components/shell/InstallHint";
import { INSTALL_HINT_DELAY_MS, INSTALL_HINT_KEY } from "@/lib/install-hint";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

function device({ ua, coarse = true, standalone = false }: { ua: string; coarse?: boolean; standalone?: boolean }) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(navigator, "maxTouchPoints", { value: coarse ? 5 : 0, configurable: true });
  window.matchMedia = ((q: string) => ({
    matches: q.includes("pointer: coarse") ? coarse : q.includes("display-mode: standalone") ? standalone : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function mount(locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <InstallHint />
    </I18nProvider>,
  );
}

const wait = () => act(() => vi.advanceTimersByTimeAsync(INSTALL_HINT_DELAY_MS + 50));

function installEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: ReturnType<typeof vi.fn>; userChoice: Promise<{ outcome: string }> };
  e.prompt = vi.fn(async () => {});
  e.userChoice = Promise.resolve({ outcome });
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("iOS Safari", () => {
  it("shows the Share instruction after the delay, not before, and no install button", async () => {
    device({ ua: IPHONE_SAFARI });
    mount();
    expect(screen.queryByRole("region")).toBeNull();
    await wait();
    const card = screen.getByRole("region", { name: dictionaries.en.installHint.title });
    expect(card.textContent).toContain(dictionaries.en.installHint.ios);
    expect(screen.queryByRole("button", { name: dictionaries.en.installHint.add })).toBeNull();
  });

  it("is dismissible and is then not shown again on this device", async () => {
    device({ ua: IPHONE_SAFARI });
    const first = mount();
    await wait();
    fireEvent.click(screen.getByRole("button", { name: dictionaries.en.installHint.gotIt }));
    expect(screen.queryByRole("region")).toBeNull();
    expect(window.localStorage.getItem(INSTALL_HINT_KEY)).not.toBeNull();
    first.unmount();
    mount();
    await wait();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("is once per device even if it was ignored rather than pressed", async () => {
    device({ ua: IPHONE_SAFARI });
    const first = mount();
    await wait();
    expect(screen.getByRole("region")).toBeTruthy();
    first.unmount();
    mount();
    await wait();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("still works, once per load, when storage is blocked", async () => {
    device({ ua: IPHONE_SAFARI });
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mount();
    await wait();
    expect(screen.getByRole("region")).toBeTruthy();
    get.mockRestore();
    set.mockRestore();
  });
});

describe("where it must stay away", () => {
  it("a desktop (no touch pointer), even where the browser fires its install event", async () => {
    device({ ua: ANDROID_CHROME, coarse: false });
    mount();
    window.dispatchEvent(installEvent());
    await wait();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("the installed app", async () => {
    device({ ua: IPHONE_SAFARI, standalone: true });
    mount();
    await wait();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("Android without an install offer from the browser: nothing to show", async () => {
    device({ ua: ANDROID_CHROME });
    mount();
    await wait();
    expect(screen.queryByRole("region")).toBeNull();
  });
});

describe("Android", () => {
  it("appears only once the browser fired its install event, and Add calls the browser's own prompt", async () => {
    device({ ua: ANDROID_CHROME });
    mount();
    const e = installEvent();
    act(() => {
      window.dispatchEvent(e);
    });
    // The browser's own mini-bar is held back: one offer, not two.
    expect(e.defaultPrevented).toBe(true);
    expect(screen.queryByRole("region")).toBeNull();
    await wait();
    expect(screen.getByRole("region").textContent).toContain(dictionaries.en.installHint.android);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: dictionaries.en.installHint.add }));
    });
    expect(e.prompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("Not now closes it without calling the prompt", async () => {
    device({ ua: ANDROID_CHROME });
    mount();
    const e = installEvent();
    act(() => {
      window.dispatchEvent(e);
    });
    await wait();
    fireEvent.click(screen.getByRole("button", { name: dictionaries.en.installHint.notNow }));
    expect(e.prompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("closes itself when the app gets installed some other way", async () => {
    device({ ua: ANDROID_CHROME });
    mount();
    act(() => {
      window.dispatchEvent(installEvent());
    });
    await wait();
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(screen.queryByRole("region")).toBeNull();
  });
});

describe("copy", () => {
  it.each(LOCALES.map((l) => l.code))("%s has every line, and no provider or role words", (locale) => {
    const h = dictionaries[locale].installHint;
    for (const v of Object.values(h)) expect(v.trim().length).toBeGreaterThan(1);
    expect(Object.keys(h).sort()).toEqual(Object.keys(dictionaries.en.installHint).sort());
    expect(JSON.stringify(h)).not.toMatch(/gemini|openai|gpt|claude|anthropic|veo|elevenlabs|owner|editor|viewer/i);
  });
  it("the touch targets are 44px: the stylesheet gives both buttons 2.75rem", () => {
    const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
    expect(css).toMatch(/\.install-hint-actions > button \{ min-height: 2\.75rem;/);
  });
});
