// @vitest-environment jsdom
/**
 * The site the day the first model sample is merged, simulated: the data file and its generated module hold the test fixture
 * (in place of the real ones, whatever they hold). Pins what changes then and what must not: the landing shows the gallery after the showcases, the
 * footer's credits say some samples are AI-generated, and NO model or maker is named anywhere on the page but inside the sample's
 * own card. Plus /welcome's last button, which opens the Studio form a visitor asked for before signing up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/lib/site/showcase.json", async () => {
  const { FIXTURE_ENTRY } = await import("./fixtures/showcase-entry");
  return { default: { entries: [FIXTURE_ENTRY] } };
});
vi.mock("@/components/site/showcase-assets", async () => {
  const { FIXTURE_FILES } = await import("./fixtures/showcase-entry");
  return { SHOWCASE_FILES: FIXTURE_FILES };
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, LOCALES } from "@/lib/i18n";
import { I18nProvider } from "@/lib/i18n/context";
import { Landing } from "@/components/landing/Landing";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { WelcomeFlow } from "@/components/welcome/WelcomeFlow";
import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";
import type { MoneyAnchor } from "@/lib/landing";
import { PROVIDER_BRANDS } from "./helpers/brands";
import { FIXTURE_JOB } from "./fixtures/showcase-entry";

afterEach(cleanup);

const NO_MONEY: MoneyAnchor = { pack: { kind: "none" }, api: null, site: null };

describe("with one sample merged", () => {
  it("reads the entry from the data file", () => {
    expect(SHOWCASE_ENTRIES.map((e) => e.jobId)).toEqual([FIXTURE_JOB]);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the landing shows the gallery after the showcases, and names the model only inside its card", (code) => {
    const t = dictionaries[code];
    const { container } = render(<Landing t={t} locale={code} pricing={{ kind: "announced" }} anchor={NO_MONEY} showcase={[]} />);
    const section = container.querySelector("section#samples") as HTMLElement;
    expect(section).toBeTruthy();
    // After the two showcases, before the hands-on example.
    const order = [...container.querySelectorAll("section[id]")].map((s) => s.id);
    expect(order.indexOf("samples")).toBeGreaterThan(order.indexOf("approvals"));
    expect(order.indexOf("samples")).toBeLessThan(order.indexOf("try"));
    expect(section.querySelector(`[data-showcase-entry="${FIXTURE_JOB}"]`)?.textContent).toMatch(/Runway/);
    const rest = container.cloneNode(true) as HTMLElement;
    rest.querySelectorAll("[data-showcase-entry]").forEach((n) => n.remove());
    expect(rest.textContent).not.toMatch(PROVIDER_BRANDS);
    expect(rest.innerHTML).not.toMatch(PROVIDER_BRANDS);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the footer's credits add that some samples are AI-generated, and name no model", (code) => {
    const t = dictionaries[code];
    const { container } = render(<PublicFooter t={t} />);
    const credits = container.querySelector(".st-credits") as HTMLElement;
    expect(credits.textContent).toContain(t.site.credits.generated);
    expect(credits.textContent).toContain(t.site.credits.lead);
    expect(container.textContent).not.toMatch(PROVIDER_BRANDS);
  });
});

describe("/welcome after a sample's Try it", () => {
  function renderWelcome(next: string | null) {
    render(
      <I18nProvider locale="en">
        <WelcomeFlow needsWorkspace={false} unavailable={false} hasChannel={false} canConnectYouTube={false} showCredits welcomeCredits={null} contactEmail={null} next={next} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: dictionaries.en.signup.skip }));
  }

  it("the last button opens the Studio form the visitor asked for", () => {
    const next = "/all-channels/create?tool=i2v&model=runway-gen4.5&prompt=lanterns";
    renderWelcome(next);
    const btn = screen.getByRole("link", { name: dictionaries.en.signup.finishStudio });
    expect(btn.getAttribute("href")).toBe(next);
  });

  it("without one, it is the Command Center as before", () => {
    renderWelcome(null);
    expect(screen.getByRole("link", { name: dictionaries.en.signup.finish }).getAttribute("href")).toBe("/all-channels");
  });
});
