// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, fmt, type Locale } from "@/lib/i18n";
import { Landing } from "@/components/landing/Landing";
import type { MoneyAnchor } from "@/lib/landing";
import { WELCOME_CREDITS } from "@/lib/pricing";

afterEach(cleanup);

const LOCALES: Locale[] = ["en", "ru", "uz"];
const NO_MONEY: MoneyAnchor = { pack: { kind: "none" }, api: null, site: null };

function renderLanding(locale: Locale) {
  return render(<Landing t={dictionaries[locale]} locale={locale} pricing={{ kind: "announced" }} anchor={NO_MONEY} showcase={[]} />);
}

/** What the note must say, per locale: this shows a plan and nothing is made. */
const NOT_CREATED = { en: /nothing is created/i, ru: /ничего не создаётся/i, uz: /hech narsa yaratilmaydi/i } as const;
/** Words that would promise a result, a render or a speed from a link that only scrolls. */
const CLAIMS = {
  en: /\b(video is ready|generated|rendered|in \d+ (?:seconds|minutes)|instantly|free video)\b/i,
  ru: /(видео готово|сгенерир|отрендер|за \d+ (?:сек|мин)|мгновенно|бесплатное видео)/i,
  uz: /(video tayyor|generatsiya|render qilin|\d+ (?:soniya|daqiqa)da|bir zumda|bepul video)/i,
} as const;

describe("landing hero → existing #try demo", () => {
  it.each(LOCALES)("%s: one primary button (sign-up), the example is a quiet anchor to #try", (locale) => {
    const { container } = renderLanding(locale);
    const hero = container.querySelector(".nx-hero-copy") as HTMLElement;
    expect(hero).toBeTruthy();
    const buttons = hero.querySelectorAll("a.nx-btn");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("href")).toBe("/signup");
    const sample = hero.querySelector("a.nx-sample") as HTMLAnchorElement;
    expect(sample).toBeTruthy();
    expect(sample.getAttribute("href")).toBe("#try");
    expect(sample.classList.contains("nx-btn")).toBe(false);
    expect(sample.querySelector(".nx-sample-label")?.textContent).toBe(dictionaries[locale].site.hero.demo);
  });

  it.each(LOCALES)("%s: #try is exactly one labelled section, the same one the anchor targets", (locale) => {
    const { container } = renderLanding(locale);
    const targets = container.querySelectorAll("#try");
    expect(targets).toHaveLength(1);
    expect(targets[0].tagName).toBe("SECTION");
    const labelled = targets[0].getAttribute("aria-labelledby");
    expect(labelled).toBe("try-title");
    expect(container.querySelector(`#${labelled}`)).toBeTruthy();
  });

  it.each(LOCALES)("%s: says it is a plan only, makes no outcome or speed claim, keeps the pricing link and the welcome promise", (locale) => {
    const t = dictionaries[locale];
    const { container } = renderLanding(locale);
    const sample = container.querySelector("a.nx-sample") as HTMLElement;
    expect(sample.textContent).toMatch(NOT_CREATED[locale]);
    expect(sample.textContent).not.toMatch(CLAIMS[locale]);
    // Unchanged on this PR: the pricing link and the one place the free-credits promise is made.
    const pricing = container.querySelector('.nx-hero-copy a.nx-link[href="/pricing"]');
    expect(pricing?.textContent).toBe(t.site.hero.secondary);
    const note = container.querySelector(".nx-hero-copy .nx-note");
    expect(note?.textContent).toBe(fmt(t.site.hero.note, { n: String(WELCOME_CREDITS) }));
    expect(sample.textContent).not.toMatch(/\d/);
  });

  it("the sample is written in each language and is not the sign-up label", () => {
    for (const l of LOCALES) {
      const h = dictionaries[l].site.hero;
      expect(h.demo.trim()).not.toBe("");
      expect(h.demo).not.toBe(h.cta);
    }
    expect(new Set(LOCALES.map((l) => dictionaries[l].site.hero.demo)).size).toBe(3);
  });
});

describe("landing hero → #try: stylesheet", () => {
  const css = readFileSync(join(__dirname, "..", "components/site/site-next.css"), "utf8");

  it("keeps a 44px target, never hides overflow, and uses no grid or glow for it", () => {
    const rule = css.match(/\.nx-sample \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/min-height:\s*44px/);
    const sampleRules = css.split("\n").filter((line) => line.includes(".nx-sample"));
    expect(sampleRules.length).toBeGreaterThan(0);
    for (const line of sampleRules) {
      expect(line).not.toMatch(/overflow-x|display:\s*grid|box-shadow|radial-gradient|filter:\s*blur/);
    }
  });

  it("is readable on the dark hero below 1024px and leaves the phone's hidden pricing link alone", () => {
    expect(css).toMatch(/\.nx-hero-top \.nx-sample \{ color: #fff;/);
    expect(css).toMatch(/\.nx-hero-top \.nx-sample-note \{ color: rgba\(255, 255, 255, 0\.86\)/);
    expect(css).toMatch(/@media \(max-width: 639px\) \{\s*\.nx-hero-copy \.nx-actions \.nx-link \{ display: none; \}/);
    expect(css).not.toMatch(/\.nx-sample[^{]*\{[^}]*display:\s*none/);
  });
});
