// @vitest-environment jsdom
/**
 * The first-run path to a first result: the landing hero offers the free
 * example (and only the example) beside the one filled key, /welcome offers a
 * no-channel person the picture, clip and voice desks, and an empty Home says
 * the same under "Connect a channel". Every link target is a route that
 * exists (tests/create-page-no-channel.test.tsx renders the page itself), and
 * the new words make no promise about outcomes or speed.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/welcome",
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
import { Landing } from "@/components/landing/Landing";
import { WelcomeFlow } from "@/components/welcome/WelcomeFlow";
import { HomeHub } from "@/components/home/HomeHub";
import type { MoneyAnchor } from "@/lib/landing";
import { SECTIONS, isSection } from "@/lib/channels";
import { deskFromQuery, deskHref, isMediaDesk } from "@/lib/creative/desks";

afterEach(cleanup);

const LOCALES: Locale[] = ["en", "ru", "uz"];
const NO_MONEY: MoneyAnchor = { pack: { kind: "none" }, api: null, site: null };

/** Outcome and money promises the new copy must not make (the owner's hypotheses are not claims). */
const CLAIMS: Record<Locale, RegExp> = {
  // Outcome and money words, then speed words: how soon a result arrives is a promise too, and nothing measures it yet.
  en: /earn|income|revenue|\bviews?\b|monetiz|guarantee|profit|grow|viral|\$\d|fast|instant|quick|sooner|minutes/i,
  ru: /заработ|доход|просмотр|монетиз|гаранти|прибыл|вирус|рост|быстр|мгновенн|за минуты/i,
  uz: /daromad|tomosha|monetizats|kafolat|foyda|viral|oʻsish|tez|zumda|daqiqalarda/i,
};

function renderLanding(locale: Locale) {
  return render(<Landing t={dictionaries[locale]} locale={locale} pricing={{ kind: "announced" }} anchor={NO_MONEY} showcase={[]} />);
}

describe("the landing hero offers the free example next to the one primary key", () => {
  for (const locale of LOCALES) {
    it(`renders both entries in ${locale}, and the example link lands on the real #try section`, () => {
      const t = dictionaries[locale];
      const { container } = renderLanding(locale);
      const hero = container.querySelector(".nx-hero") as HTMLElement;

      const primary = within(hero).getByRole("link", { name: t.site.hero.cta });
      expect(primary.getAttribute("href")).toBe("/signup");

      const demo = within(hero).getByRole("link", { name: new RegExp(t.site.hero.demo) });
      expect(demo.getAttribute("href")).toBe("#try");
      // The honest sub-label is part of the link's own words, so a screen reader hears it with the name.
      expect(demo.textContent).toContain(t.site.hero.demoNote);

      // The anchor resolves: exactly one section carries the id, and it holds the example.
      const targets = container.querySelectorAll("#try");
      expect(targets.length).toBe(1);
      expect(targets[0].tagName).toBe("SECTION");
      expect(targets[0].getAttribute("aria-labelledby")).toBe("try-title");
      expect(container.querySelector("#try-title")).toBeTruthy();
    });

    it(`keeps "${locale}" Start free the only filled key in the hero`, () => {
      const { container } = renderLanding(locale);
      const hero = container.querySelector(".nx-hero") as HTMLElement;
      expect(hero.querySelectorAll(".nx-btn").length).toBe(1);
      expect(hero.querySelector(".nx-sample")?.classList.contains("nx-btn")).toBe(false);
    });
  }

  it("keeps pricing as a quiet link under the example (shown only from 640 to 1023 px by CSS), and the closing call still links to it", () => {
    const { container } = renderLanding("en");
    const hero = container.querySelector(".nx-hero") as HTMLElement;
    const pricing = hero.querySelector('a[href="/pricing"]') as HTMLElement;
    const demo = hero.querySelector('a[href="#try"]') as HTMLElement;
    expect(pricing.className).toContain("nx-hero-price");
    expect(pricing.className).not.toContain("nx-btn");
    expect(demo.compareDocumentPosition(pricing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll('a[href="/pricing"]').length).toBeGreaterThan(1);
    // The rule that hides it on phones and on the desktop (where the nav has it) is in the stylesheet.
    const css = readFileSync(path.join(process.cwd(), "components/site/site-next.css"), "utf8");
    expect(/\.nx-hero-copy \.nx-actions \.nx-hero-price \{ display: none; \}/.test(css)).toBe(true);
    expect(/@media \(min-width: 640px\) and \(max-width: 1023px\) \{[\s\S]{0,200}?\.nx-hero-price \{ display: inline-flex/.test(css)).toBe(true);
  });

  it("says in the sub-label that the example only shows a plan and creates nothing", () => {
    expect(dictionaries.en.site.hero.demoNote).toMatch(/nothing is created/i);
    expect(dictionaries.ru.site.hero.demoNote).toMatch(/ничего не создаётся/i);
    expect(dictionaries.uz.site.hero.demoNote).toMatch(/hech narsa yaratilmaydi/i);
    // The same promise the example itself makes further down.
    expect(dictionaries.en.site.try.lead).toMatch(/nothing is generated/i);
  });
});

describe("the new copy makes no outcome claim", () => {
  for (const locale of LOCALES) {
    it(`${locale}: hero example, welcome media step and home link carry no earnings, views, monetization or guarantee words`, () => {
      const d = dictionaries[locale];
      const strings = [
        d.site.hero.demo,
        d.site.hero.demoNote,
        d.signup.stepMedia,
        d.signup.stepMediaBody,
        d.signup.stepCreateBody,
        d.signup.stepCreateNeedsChannel,
        d.home.tryMedia,
        d.home.tryMediaNote,
      ];
      for (const s of strings) {
        expect(s.length).toBeGreaterThan(5);
        expect(s).not.toMatch(CLAIMS[locale]);
      }
    });

    it(`${locale}: says the media desks are not a full YouTube video, and names the connected channel the full video needs`, () => {
      const d = dictionaries[locale];
      expect(d.signup.stepMediaBody).toMatch(/YouTube/);
      // The full video's own step names the requirement in the product's own word ("connected"), not a new one.
      expect(d.signup.stepCreateNeedsChannel).toMatch(/YouTube/);
      expect(d.signup.stepCreateNeedsChannel).not.toMatch(/verified|подтвержд|tasdiqlangan/i);
      expect(d.signup.stepCreateBody).not.toMatch(/verified|подтвержд\w+ канал|tasdiqlangan kanal/i);
    });
  }
});

function renderWelcome(props: Partial<React.ComponentProps<typeof WelcomeFlow>> = {}, locale: Locale = "en") {
  render(
    <I18nProvider locale={locale}>
      <WelcomeFlow
        needsWorkspace={false}
        unavailable={false}
        hasChannel={false}
        canConnectYouTube={false}
        showCredits
        welcomeCredits={100}
        contactEmail={null}
        {...props}
      />
    </I18nProvider>,
  );
  // Step 1 of 2 ("about") -> step 2 of 2 ("next").
  fireEvent.click(screen.getByRole("button", { name: dictionaries[locale].signup.skip }));
}

describe("/welcome step 3 for a person with no channel", () => {
  for (const locale of LOCALES) {
    it(`${locale}: offers the no-channel media desk and keeps the channel links`, async () => {
      const t = dictionaries[locale];
      renderWelcome({}, locale);
      const row = (await screen.findByRole("heading", { name: t.signup.stepMedia })).closest("li") as HTMLElement;
      expect(within(row).getByRole("link", { name: new RegExp(t.signup.open) }).getAttribute("href")).toBe("/all-channels/create?desk=image");
      expect(row.textContent).toContain(t.signup.stepMediaBody);

      const channel = (await screen.findByRole("heading", { name: t.signup.stepChannel })).closest("li") as HTMLElement;
      expect(within(channel).getByRole("link").getAttribute("href")).toMatch(/^\/all-channels\/channels\/new/);
      // The YouTube step still leads to the channel list or the request, unchanged.
      const yt = (await screen.findByRole("heading", { name: t.signup.stepYoutube })).closest("li") as HTMLElement;
      expect(yt.textContent).toContain(t.signup.stepYoutubeRestricted);
    });
  }

  it("numbers the rows without a gap or a repeat", async () => {
    renderWelcome();
    const nums = [...document.querySelectorAll(".g5-next-step .g5-num")].map((n) => n.textContent);
    expect(nums).toEqual(["01", "02", "03", "04", "05", "06"]);
  });

  it("does not repeat the offer for someone who already has a channel", async () => {
    renderWelcome({ hasChannel: true, canConnectYouTube: true });
    expect(screen.queryByRole("heading", { name: dictionaries.en.signup.stepMedia })).toBeNull();
    const nums = [...document.querySelectorAll(".g5-next-step .g5-num")].map((n) => n.textContent);
    expect(nums).toEqual(["✓", "02", "03", "04", "05"]);
  });

  it("tells only a person without a channel that a full video needs a connected channel", () => {
    renderWelcome();
    const full = (document.querySelectorAll(".g5-next-step")[5] as HTMLElement).textContent ?? "";
    expect(full).toContain(dictionaries.en.signup.stepCreateNeedsChannel);
    cleanup();
    renderWelcome({ hasChannel: true });
    expect(document.body.textContent).not.toContain(dictionaries.en.signup.stepCreateNeedsChannel);
  });

  // The strings as they were on main, copied here on purpose: comparing with the dictionary key would pass after any edit.
  // The policy is an open owner decision (the OAuth start route lets a customer org admin connect); this PR must not move it.
  const POLICY_AS_ON_MAIN: Record<Locale, string> = {
    en: "For now the Nightshift team switches YouTube connection on: until Google finishes reviewing our upload access, only accounts we add can grant it. Request it and we'll enable it for your channel.",
    ru: "Пока подключение YouTube включает команда Nightshift: до завершения проверки Google нашего доступа к загрузке разрешение могут выдать только добавленные нами аккаунты. Отправьте запрос — и мы включим его для вашего канала.",
    uz: "Hozircha YouTube ulanishini Nightshift jamoasi yoqadi: Google yuklash huquqimizni tekshirishni tugatmaguncha ruxsatni faqat biz qoʻshgan hisoblar bera oladi. Soʻrov yuboring — kanalingiz uchun yoqib beramiz.",
  };
  for (const locale of LOCALES) {
    it(`${locale}: leaves the open channel-connect policy text exactly as it was on main`, () => {
      expect(dictionaries[locale].signup.stepYoutubeRestricted).toBe(POLICY_AS_ON_MAIN[locale]);
      renderWelcome({ canConnectYouTube: false, contactEmail: "team@example.com" }, locale);
      expect(screen.getByText(POLICY_AS_ON_MAIN[locale])).toBeTruthy();
    });
  }

  it("keeps the request-by-email button for a person the team has to enable", () => {
    renderWelcome({ canConnectYouTube: false, contactEmail: "team@example.com" });
    expect(screen.getByRole("link", { name: dictionaries.en.signup.requestConnection }).getAttribute("href")).toMatch(/^mailto:team@example\.com/);
  });
});

describe("the empty Home keeps Connect a channel and adds the media desk quietly", () => {
  for (const locale of LOCALES) {
    it(`${locale}: both links, the connect button first`, () => {
      const t = dictionaries[locale];
      render(
        <I18nProvider locale={locale}>
          <HomeHub channels={[]} currentSlug={null} orgId={null} allPrivate={false} />
        </I18nProvider>,
      );
      const hero = screen.getByRole("region", { name: t.home.heroTitle });
      const connect = within(hero).getByRole("link", { name: new RegExp(t.home.connect) });
      expect(connect.getAttribute("href")).toBe("/chronos/channels/new");
      expect(connect.className).toContain("studio-cta");

      const media = within(hero).getByTestId("home-try-media");
      expect(media.getAttribute("href")).toBe("/chronos/create?desk=image");
      expect(media.className).not.toContain("studio-cta");
      expect(media.textContent).toContain(t.home.tryMedia);
      expect(media.textContent).toContain(t.home.tryMediaNote);
      // Source order: the connect button comes before the quiet link.
      expect(connect.compareDocumentPosition(media) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  }
});

describe("the media link resolves", () => {
  it("is a real desk on a real route the middleware treats as a section", () => {
    expect(deskHref("image")).toBe("/create?desk=image");
    expect(deskFromQuery({ desk: "image" })).toBe("image");
    expect(isMediaDesk("image")).toBe(true);
    expect(isSection("create")).toBe(true);
    expect(SECTIONS).toContain("create");
    expect(existsSync(path.join(process.cwd(), "app/(app)/[channel]/create/page.tsx"))).toBe(true);
  });
});
