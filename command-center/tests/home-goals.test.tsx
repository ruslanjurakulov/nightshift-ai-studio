// @vitest-environment jsdom
/**
 * Home's six goal cards (HOME_FORMATS) above the create form. A card is a link
 * into that form (the composer's own hand-off, runHandoffHref) with a starter
 * topic, the format's usual length and the viewer's language. It starts nothing
 * and prices nothing: no request is sent, and the form it opens shows the price
 * and asks twice. With no runnable channel, no right to run, or no Run now
 * there are no cards, because they would lead to a dead end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/home",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { HomeHub } from "@/components/home/HomeHub";
import { HOME_FORMATS, defaultLanguage, lengthSeconds, runPrefillFromQuery, type HomeChannel } from "@/lib/home";

const LOCALES: Locale[] = ["en", "ru", "uz"];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 404 })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ch = (over: Partial<HomeChannel> = {}): HomeChannel => ({
  id: "chan-a",
  slug: "chronos",
  name: "Chronos",
  avatar: null,
  language: "Uzbek",
  standing: "live",
  autoPublish: false,
  lastVideo: null,
  nextRun: null,
  waiting: 0,
  ...over,
});

function home(over: { assistant?: { canRun: boolean; runConfigured: boolean } | null; withRun?: boolean; locale?: Locale; channels?: HomeChannel[]; currentSlug?: string | null } = {}) {
  const { assistant = { canRun: true, runConfigured: true }, withRun = true, locale = "en", channels = [ch()], currentSlug = "chronos" } = over;
  return render(
    <I18nProvider locale={locale}>
      <HomeHub
        channels={channels}
        currentSlug={currentSlug}
        orgId={null}
        allPrivate
        storyboards={[]}
        assistant={assistant ? { models: [], ...assistant } : undefined}
        run={withRun ? <div data-testid="run-form" /> : undefined}
      />
    </I18nProvider>,
  );
}
const goals = () => screen.queryByRole("region", { name: dictionaries.en.home.formatsTitle }) ?? document.querySelector("#home-goals");

describe("Home goal cards", () => {
  it.each(LOCALES)("%s: six links, each into the create form with the starter topic, length and language", (locale) => {
    home({ locale });
    const t = dictionaries[locale];
    const list = document.querySelector(".home-goals") as HTMLElement;
    const links = within(list).getAllByRole("link");
    expect(links).toHaveLength(HOME_FORMATS.length);
    for (const f of HOME_FORMATS) {
      const a = list.querySelector(`a[data-goal="${f.id}"]`) as HTMLAnchorElement;
      expect(a).toBeTruthy();
      expect(a.textContent).toContain(t.home.formats[f.id].title);
      const url = new URL(a.getAttribute("href")!, "https://x.test");
      expect(url.pathname).toBe("/chronos/create");
      expect(url.hash).toBe("#run");
      // What the create page's own parser takes from the query: exactly the card's choices.
      const q = Object.fromEntries(url.searchParams);
      expect(runPrefillFromQuery(q)).toEqual({ brief: t.home.formats[f.id].starter, duration: String(lengthSeconds(f.length)), language: defaultLanguage(locale) });
    }
  });

  it("is links, not buttons: a card cannot submit anything, and a click sends no request", () => {
    home();
    const list = document.querySelector(".home-goals") as HTMLElement;
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
    const first = list.querySelector("a") as HTMLAnchorElement;
    first.addEventListener("click", (e) => e.preventDefault()); // jsdom cannot navigate
    fireEvent.click(first);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the form for the channel in the URL, else the first runnable one, never a draft", () => {
    home({ channels: [ch({ slug: "draft-one", standing: "draft" }), ch({ id: "b", slug: "second" }), ch({ id: "c", slug: "third" })], currentSlug: "third" });
    expect(document.querySelector('.home-goals a')!.getAttribute("href")).toMatch(/^\/third\/create\?/);
    cleanup();
    home({ channels: [ch({ slug: "draft-one", standing: "draft" }), ch({ id: "b", slug: "second" })], currentSlug: "draft-one" });
    expect(document.querySelector('.home-goals a')!.getAttribute("href")).toMatch(/^\/second\/create\?/);
  });

  it.each([
    ["the viewer may not run", { assistant: { canRun: false, runConfigured: true } }],
    ["Run now is not configured", { assistant: { canRun: true, runConfigured: false } }],
    ["there is no create form on the page", { withRun: false }],
    ["there is no runnable channel", { channels: [ch({ standing: "draft" })], withRun: false }],
  ])("has no cards when %s", (_why, over) => {
    home(over);
    expect(document.querySelector(".home-goals")).toBeNull();
    expect(goals()).toBeNull();
  });

  it.each(LOCALES)("%s: the pricing and refund promises beside the form are still there, and the cards promise no result or speed", (locale) => {
    home({ locale });
    const t = dictionaries[locale];
    const page = document.body.textContent ?? "";
    expect(page).toContain(t.home.promisePrice);
    expect(page).toContain(t.home.promiseRefund);
    const cards = document.querySelector("#home-goals")!.closest("section")!.textContent ?? "";
    expect(cards).not.toMatch(/\d+\s?(credits?|кредит|kredit)|[$€₽]/i);
    expect(cards).not.toMatch(/fast|быстр|tez|guarantee|гарант|kafolat/i);
  });
});
