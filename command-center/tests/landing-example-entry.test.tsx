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
import { IDEA_NEXT } from "@/lib/site/idea-handoff";
import { WELCOME_CREDITS } from "@/lib/pricing";
import { publicNavLinks } from "@/components/legal/PublicShell";

afterEach(cleanup);

const LOCALES: Locale[] = ["en", "ru", "uz"];
const NO_MONEY: MoneyAnchor = { pack: { kind: "none" }, api: null, site: null };

function renderLanding(locale: Locale) {
  return render(<Landing t={dictionaries[locale]} locale={locale} pricing={{ kind: "announced" }} anchor={NO_MONEY} showcase={[]} />);
}

/** Words that would promise a result, a render or a speed from a box that only carries words to sign-up. */
const CLAIMS = {
  en: /\b(video is ready|rendered|in \d+ (?:seconds|minutes)|instantly|free video)\b/i,
  ru: /(видео готово|отрендер|за \d+ (?:сек|мин)|мгновенно|бесплатное видео)/i,
  uz: /(video tayyor|render qilin|\d+ (?:soniya|daqiqa)da|bir zumda|bepul video)/i,
} as const;

/**
 * The first screen is the street-stall hero the owner kept (components/landing/home/HomeHero.tsx, 2026-11-22), drawn since the same
 * day "in the style" of kling.ai's: the title, one line and one glass bar. Its old #try demo left the landing with it (a second
 * "type a topic" box under the idea box said the same thing twice); what the old pins guarded still holds and is pinned here: a way
 * down the page that lands on a real section (the header's "How it works", now that the first screen has no link of its own), an
 * entry that starts and spends nothing (CLAUDE.md #3), and the pricing link and the welcome promise just under the first screen.
 */
describe("landing hero → the idea box, and #how from the page's nav", () => {
  it.each(LOCALES)("%s: the only way out of the first screen is the idea box (to sign-up, the Studio next); the nav leads to #how", (locale) => {
    const { container } = renderLanding(locale);
    const hero = container.querySelector("section.hm-hero") as HTMLElement;
    expect(hero).toBeTruthy();
    const t = dictionaries[locale];
    // No link at all: the idea box's own key is the first screen's one call to action, as the reference's one bar is.
    expect(hero.querySelectorAll("a")).toHaveLength(0);
    // "How it works" is still one click from the first screen: the header every public page carries leads there.
    expect(publicNavLinks(t).find((l) => l.href === "/#how")?.label).toBe(t.site.nav.how);
    // The box is a GET form to sign-up with the Studio as `next`; its field has no name, so the words never enter an address.
    const form = hero.querySelector("form") as HTMLFormElement;
    expect(form.getAttribute("action")).toBe("/signup");
    expect(form.getAttribute("method")).toBe("get");
    expect(hero.querySelectorAll("form")).toHaveLength(1);
    const named = [...form.querySelectorAll("[name]")].map((el) => [el.getAttribute("name"), el.getAttribute("value")]);
    expect(named).toEqual([["next", IDEA_NEXT]]);
    const field = form.querySelector("[data-testid='idea-field']") as HTMLInputElement;
    expect(field.tagName).toBe("INPUT");
    expect(field.hasAttribute("name")).toBe(false);
    expect(form.querySelectorAll("button[type='submit']")).toHaveLength(1);
    // Lean: no price, no promises list and no pill above the fold (they are just under it, in .nx-facts).
    expect(hero.querySelector(".nx-pill, .nx-note, .nx-price, .nx-trust, .nx-btn")).toBeNull();
  });

  it.each(LOCALES)("%s: #how is exactly one labelled section, the one the nav's \"How it works\" targets", (locale) => {
    const { container } = renderLanding(locale);
    const targets = container.querySelectorAll("#how");
    expect(targets).toHaveLength(1);
    expect(targets[0].tagName).toBe("SECTION");
    const labelled = targets[0].getAttribute("aria-labelledby");
    expect(labelled).toBe("how-title");
    expect(container.querySelector(`#${labelled}`)).toBeTruthy();
    // The old demo's anchor is gone with it: no link on the page may point at a section that is not there.
    for (const a of container.querySelectorAll('a[href^="#"]')) {
      const id = a.getAttribute("href")!.slice(1);
      if (id) expect(container.querySelector(`[id="${id}"]`), `#${id}`).toBeTruthy();
    }
  });

  it.each(LOCALES)("%s: says nothing starts and nothing is charged, makes no outcome or speed claim, keeps the pricing link and the welcome promise", (locale) => {
    const t = dictionaries[locale];
    const h = t.landingHome.hero;
    const { container } = renderLanding(locale);
    const hero = container.querySelector("section.hm-hero") as HTMLElement;
    expect(hero.textContent).toContain(h.idea.note);
    for (const words of [h.title, h.subline, h.lead, h.idea.note, h.idea.submit]) {
      expect(words).not.toMatch(CLAIMS[locale]);
      expect(words).not.toMatch(/\d/);
    }
    // The pricing link and the one place the free-credits promise is made: just under the first screen.
    const pricing = container.querySelector('.nx-facts a.nx-link[href="/pricing"]');
    expect(pricing?.textContent).toBe(t.site.hero.secondary);
    const note = container.querySelector(".nx-facts .nx-note");
    expect(note?.textContent).toBe(fmt(t.site.hero.note, { n: String(WELCOME_CREDITS) }));
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
