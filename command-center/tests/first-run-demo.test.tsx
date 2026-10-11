// @vitest-environment jsdom
/**
 * The first-run path to a first result: the landing hero offers the free
 * example (and only the example) beside the one filled key, /welcome offers a
 * no-channel person the picture, clip and voice desks, and an empty Home says
 * the same under "Connect a channel". Every link target is a route that
 * exists, and the new words make no promise about outcomes.
 */
import { existsSync } from "node:fs";
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
  en: /earn|income|revenue|\bviews?\b|monetiz|guarantee|profit|grow|viral|\$\d/i,
  ru: /заработ|доход|просмотр|монетиз|гаранти|прибыл|вирус|рост/i,
  uz: /daromad|tomosha|monetizats|kafolat|foyda|viral|oʻsish/i,
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

  it("demotes pricing out of the hero without losing it: the closing call still links to /pricing", () => {
    const { container } = renderLanding("en");
    const hero = container.querySelector(".nx-hero") as HTMLElement;
    expect(hero.querySelector('a[href="/pricing"]')).toBeNull();
    expect(container.querySelector('a[href="/pricing"]')).toBeTruthy();
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
        d.home.tryMedia,
        d.home.tryMediaNote,
      ];
      for (const s of strings) {
        expect(s.length).toBeGreaterThan(5);
        expect(s).not.toMatch(CLAIMS[locale]);
      }
    });

    it(`${locale}: says it is not a full YouTube video, and that no channel is needed`, () => {
      const d = dictionaries[locale];
      expect(d.signup.stepMediaBody).toMatch(/YouTube/);
      expect(d.home.tryMediaNote).toMatch(/YouTube/);
      // The full video's own step names the requirement instead of hiding it.
      expect(d.signup.stepCreateBody).toMatch(/YouTube/);
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

  it("leaves the open channel-connect policy text exactly as it was", () => {
    renderWelcome({ canConnectYouTube: false, contactEmail: "team@example.com" });
    expect(screen.getByText(dictionaries.en.signup.stepYoutubeRestricted)).toBeTruthy();
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

  it("needs no channel: the image desk is gated on the organization alone, never on a channel", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(path.join(process.cwd(), "app/(app)/[channel]/create/page.tsx"), "utf8");
    // GenerateSection renders when there is an open organization; the channel-bound run is its own desk.
    expect(src).toMatch(/isMediaDesk\(desk\) &&\s*\(genOrgId \?/);
    expect(src).toMatch(/desk === "youtube" && <YouTubeDesk/);
  });
});
