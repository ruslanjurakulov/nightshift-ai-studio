// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

import { dictionaries, LOCALES } from "@/lib/i18n";
import { Landing } from "@/components/landing/Landing";
import { MotionToggle } from "@/components/site/MotionToggle";
import { buildPlan, cleanTopic, pickStill, STILL_IDS, TOPIC_MAX } from "@/lib/site/demo-plan";
import { freeMinutes, priceRatesFrom, quoteCents, quoteCredits } from "@/lib/site/price-check";
import { setMotionPaused } from "@/lib/site/motion";
import { thumbWords } from "@/components/site/BrandArt";
import { WELCOME_CREDITS } from "@/lib/pricing";
import type { MoneyAnchor } from "@/lib/landing";
import { PROVIDER_BRANDS } from "./helpers/brands";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setMotionPaused(false);
});

const NO_MONEY: MoneyAnchor = { pack: { kind: "none" }, api: null, site: null };
/** 60 credits a minute, at least 10 a run, and the smallest pack is $10 for 1,000 credits ($0.01 a credit). */
const PRICED: MoneyAnchor = {
  pack: { kind: "priced", id: "starter", credits: 1000, price: "$10" },
  api: null,
  site: { perMinute: 60, minimum: 10, usd: { cents: 60, pack: "starter" } },
};

function landing(anchor: MoneyAnchor = NO_MONEY, locale: "en" | "ru" | "uz" = "en") {
  return render(<Landing t={dictionaries[locale]} locale={locale} pricing={{ kind: "announced" }} anchor={anchor} showcase={[]} />);
}

describe("the try-it example's plan builder", () => {
  const sections = dictionaries.en.site.try.sections;

  it("puts the typed words in as plain text: nothing is interpreted, not even a replacement pattern", () => {
    const plan = buildPlan(sections, "$& <b>x</b> $1");
    const text = plan.flatMap((s) => s.items.map((i) => i.v)).join("\n");
    expect(text).toContain("$& <b>x</b> $1");
    expect(text).not.toContain("{topic}");
  });

  it("makes no plan from nothing, and folds whitespace, drops control characters and caps the length", () => {
    expect(buildPlan(sections, "   \n\t ")).toEqual([]);
    expect(cleanTopic("  a \u0000 b\n\nc  ")).toBe("a b c");
    expect(Array.from(cleanTopic("x".repeat(500)))).toHaveLength(TOPIC_MAX);
  });

  it.each(LOCALES.map((l) => l.code))("%s: every section keeps its ids and uses the topic where English does", (code) => {
    const en = dictionaries.en.site.try.sections;
    const t = dictionaries[code].site.try.sections;
    expect(t.map((s) => s.id)).toEqual(en.map((s) => s.id));
    t.forEach((s, i) => {
      expect(s.items).toHaveLength(en[i].items.length);
      s.items.forEach((it, k) => {
        expect(it.v.includes("{topic}"), `${code} ${s.id}[${k}]`).toBe(en[i].items[k].v.includes("{topic}"));
        // A label for every line, and no capitals-only words.
        expect(it.k).not.toBe("");
      });
    });
  });
});

describe("the price check's arithmetic", () => {
  const rates = { perMinute: 60, minimum: 10, centsPerCredit: 1, pack: "starter" as const };

  it("is length times the published rate, never under the smallest quote", () => {
    expect(quoteCredits(5, rates)).toBe(300);
    expect(quoteCredits(1, rates)).toBe(60);
    expect(quoteCredits(0.1, rates)).toBe(10);
    expect(quoteCredits(3, { perMinute: 0.5, minimum: null })).toBe(1.5);
  });

  it("turns credits into dollars only with a dollar price, rounded to the cent", () => {
    expect(quoteCents(300, rates)).toBe(300);
    expect(quoteCents(300, { centsPerCredit: null })).toBeNull();
  });

  it("says how long the welcome grant lasts only when a whole minute fits in it", () => {
    expect(freeMinutes(WELCOME_CREDITS, rates)).toBe(1);
    expect(freeMinutes(50, rates)).toBeNull();
    expect(freeMinutes(100, { perMinute: 5, minimum: 150 })).toBeNull();
  });

  it("builds the rates from the anchor: nothing without a published rate, dollars only from a plain dollar pack", () => {
    expect(priceRatesFrom(NO_MONEY)).toBeNull();
    expect(priceRatesFrom(PRICED)).toEqual({ perMinute: 60, minimum: 10, centsPerCredit: 1, pack: "starter" });
    const euro: MoneyAnchor = { ...PRICED, pack: { kind: "priced", id: "starter", credits: 1000, price: "€9" }, site: { perMinute: 60, minimum: null, usd: null } };
    expect(priceRatesFrom(euro)).toEqual({ perMinute: 60, minimum: null, centsPerCredit: null, pack: null });
  });
});

describe("the landing page's reasons to stay", () => {
  it("has no price check without a published rate (an unpriced site stays unpriced), and has one with it", () => {
    const { container, unmount } = landing(NO_MONEY);
    expect(container.querySelector(".nx-calc")).toBeNull();
    unmount();
    const priced = landing(PRICED);
    expect(priced.container.querySelector("#pricing .nx-calc")).not.toBeNull();
  });

  it("moves the price when the slider moves, from the published rate and nothing else", () => {
    const { container } = landing(PRICED);
    const section = container.querySelector("#pricing") as HTMLElement;
    const slider = within(section).getByRole("slider");
    const out = () => section.querySelector("output")!.textContent;
    expect(out()).toBe("300 credits");
    fireEvent.change(slider, { target: { value: "1" } });
    expect(out()).toBe("60 credits");
    fireEvent.change(slider, { target: { value: "20" } });
    expect(out()).toBe("1,200 credits");
    // Dollars at the pack's price, the smallest quote, and the free grant: all derived from the same three numbers.
    expect(section.textContent).toContain("≈ $12.00 at the Starter price");
    expect(section.textContent).toContain("No run is quoted below 10 credits.");
    expect(section.textContent).toContain(`Your ${WELCOME_CREDITS} free credits cover about 1 min`);
  });

  it("opens already filled with the first sample topic's plan (never an empty placeholder), then plays your own topic out, labelled as an example", () => {
    vi.useFakeTimers();
    const t = dictionaries.en.site.try;
    const { container } = landing();
    const section = container.querySelector("#try") as HTMLElement;
    const cards = () => [...section.querySelectorAll(".nx-try-card")];
    // Before anything is asked: the sample plan is on show, for the first sample topic, and says so.
    expect(cards().every((c) => c.getAttribute("data-on") === "true" && !c.hasAttribute("inert"))).toBe(true);
    expect(cards().map((c) => c.textContent).join(" ")).toContain(t.topics[0]);
    expect(within(section).getByRole("status").textContent).toBe(t.sampleNote.replace("{topic}", t.topics[0]));
    expect(section.textContent).toContain(t.tag);
    expect(section.querySelector(".nx-try-idle, .nx-sk")).toBeNull();

    // An empty ask is refused in words, with the sample left as it was.
    fireEvent.click(within(section).getByRole("button", { name: t.run }));
    expect(within(section).getByRole("status").textContent).toBe(t.noTopic);
    expect(cards().every((c) => c.getAttribute("data-on") === "true")).toBe(true);

    fireEvent.change(within(section).getByLabelText(t.fieldLabel), { target: { value: "How tides work" } });
    fireEvent.click(within(section).getByRole("button", { name: t.run }));
    act(() => void vi.advanceTimersByTime(260));
    expect(cards().filter((c) => c.getAttribute("data-on") === "true").length).toBeLessThan(cards().length);
    expect(within(section).getByRole("status").textContent).toBe(t.drafting);
    act(() => void vi.advanceTimersByTime(5000));
    expect(cards().every((c) => c.getAttribute("data-on") === "true")).toBe(true);
    expect(cards().map((c) => c.textContent).join(" ")).toContain("How tides work");
    expect(within(section).getByRole("status").textContent).toBe(t.ready);
    // The way out: "Make this for real" goes to sign-up, and says what the real thing adds.
    const cta = within(section).getByRole("link", { name: t.cta });
    expect(cta.getAttribute("href")).toBe("/signup");
    expect(section.textContent).toContain(t.real);
  });

  it("shows a stand-in frame on the thumbnail card, chosen by the topic's words, labelled as an example and said to be a stand-in", () => {
    const t = dictionaries.en.site.try;
    const { container } = landing();
    const section = container.querySelector("#try") as HTMLElement;
    // Drawn, not a still: the topic's own words, set on the stage (BrandArt ThumbArt), and the same topic always the same drawing.
    const thumb = () => [...section.querySelectorAll(".nx-try-thumb svg[data-art='thumb'] text")].map((x) => x.textContent);
    expect(section.querySelector(".nx-try-thumb img")).toBeNull();
    const first = thumb();
    expect(first.length).toBeGreaterThan(0);
    fireEvent.click(within(section).getByRole("button", { name: t.topics[1] }));
    expect(thumb()).not.toEqual(first);
    expect(thumb()).toEqual(thumbWords(t.topics[1]));
    expect(section.querySelector(".nx-try-thumb .nx-result-badge")?.textContent).toBe(t.tag);
    expect(section.querySelector(".nx-try-thumb figcaption")?.textContent).toBe(t.thumbNote);
  });

  it("shows the whole plan at once when the visitor has paused motion", () => {
    const t = dictionaries.en.site.try;
    setMotionPaused(true);
    const { container } = landing();
    const section = container.querySelector("#try") as HTMLElement;
    fireEvent.click(within(section).getByRole("button", { name: t.topics[0] }));
    expect([...section.querySelectorAll(".nx-try-card")].every((c) => c.getAttribute("data-on") === "true")).toBe(true);
  });

  it("carries one sticky start bar that is inert until it is shown, and a pause switch that sets the page's motion", () => {
    const t = dictionaries.en.site;
    const { container } = landing();
    const bar = container.querySelector(".nx-bar") as HTMLElement;
    expect(bar.getAttribute("data-shown")).toBe("false");
    expect(bar.hasAttribute("inert")).toBe(true);
    expect(within(bar).getByText(t.bar.cta).closest("a")!.getAttribute("href")).toBe("/signup");
    expect(bar.querySelector("button")!.getAttribute("aria-label")).toBe(t.bar.dismiss);

    // A toggle button: its name stays "Pause motion" and aria-pressed says whether motion is paused. The hero's is one of four
    // (the three clip pictures carry the same switch), and all four agree.
    const all = () => screen.getAllByRole("button", { name: t.fx.pause });
    expect(all()).toHaveLength(4);
    const toggle = container.querySelector(".nx-motion-btn") as HTMLElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(document.documentElement.getAttribute("data-motion")).toBe("paused");
    for (const b of all()) expect(b.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
    for (const b of all()) expect(b.getAttribute("aria-pressed")).toBe("false");
  });

  it("states its promises in the hero (the three the page keeps) and invents no customer, count, rating or countdown", () => {
    const { container } = landing(PRICED);
    const t = dictionaries.en.site;
    const trust = container.querySelector(".nx-trust") as HTMLElement;
    expect([...trust.querySelectorAll("li")].map((li) => li.textContent)).toEqual(t.rules.items.map((i) => i.title));
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/trusted by|testimonials?\b|customers\b|\breviews?\b|\brated\b|\bstars?\b|\d+\s*(?:\+|k|m)?\s*(?:users|creators|channels|people)|only \d+|ends in|left today/i);
    expect(text).not.toMatch(PROVIDER_BRANDS);
  });

  it("labels every example frame as an example and describes it (en, ru, uz)", () => {
    for (const { code } of LOCALES) {
      const s = dictionaries[code].site.samples;
      expect(Object.keys(s.alts).sort()).toEqual(["library", "lighthouse", "moon", "nightmarket", "silkroad", "valley"]);
      for (const alt of Object.values(s.alts)) expect(alt.startsWith(s.tag)).toBe(true);
      expect(s.note.length).toBeGreaterThan(20);
    }
  });
});

describe("the pause switch on its own", () => {
  it("flips the attribute the stylesheet reads and remembers nothing it cannot", () => {
    render(<MotionToggle pause="Pause" />);
    const b = screen.getByRole("button", { name: "Pause" });
    expect(b.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(b);
    expect(document.documentElement.getAttribute("data-motion")).toBe("paused");
    expect(b.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the page's HTML stays small", () => {
  it("passes no client component the whole dictionary: its props travel in the page's HTML (the first build did, and the landing's HTML grew from 258 KB to 572 KB)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const dir of ["components/landing", "components/site"]) {
      for (const file of readdirSync(join(__dirname, "..", dir)).filter((f) => f.endsWith(".tsx"))) {
        const src = readFileSync(join(__dirname, "..", dir, file), "utf8");
        if (!src.startsWith('"use client"')) continue;
        expect(src, `${dir}/${file} takes the whole dictionary`).not.toMatch(/\bt: Dictionary\b/);
      }
    }
  });
});

describe("the AI-still disclosure is printed, not only labelled", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the hero card and each of the three showcases show the note as visible text, and every still carries its badge", (code) => {
    const { container } = landing(NO_MONEY, code);
    const s = dictionaries[code].site.samples;
    const hero = container.querySelector("figure.nx-chat") as HTMLElement;
    expect(hero.querySelector("figcaption")?.textContent).toBe(`${s.note} ${s.clipNote}`);
    expect(hero.querySelector("figcaption")?.closest("[aria-hidden]")).toBeNull();
    const shows = [...container.querySelectorAll("section.nx-show")];
    expect(shows.map((x) => x.id)).toEqual(["video", "studio", "approvals"]);
    for (const x of shows) {
      const note = x.querySelector(".nx-show-note") as HTMLElement;
      expect(note.textContent?.startsWith(s.note)).toBe(true);
      expect(note.closest("[aria-hidden]")).toBeNull();
      expect(x.querySelector(".nx-result-badge")?.textContent).toBe(s.tag);
    }
  });

  it("has no gallery, no rails and no comparison any more: nothing scrolls sideways on the landing and nothing is shown twice", () => {
    const { container } = landing();
    for (const sel of ["#examples", ".nx-caps", "#compare", ".nx-gal", "[aria-roledescription='carousel']", ".nx-tiles", ".nx-rules-rail"]) expect(container.querySelector(sel), sel).toBeNull();
    // Three different stills in the showcases, a fourth in the hero card.
    const used = [...container.querySelectorAll("figure.nx-chat img:not(.nx-fx-fg), section.nx-show img:not(.nx-fx-fg)")].map((i) => i.getAttribute("data-sample"));
    expect(used).toHaveLength(4);
    expect(new Set(used).size).toBe(4);
  });

  it("sets the text of every showcase on a dark overlay: white on the brightest possible still stays above 7:1 (AA needs 4.5)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(join(__dirname, "..", "components/site/site-next.css"), "utf8");
    const lum = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    // A black overlay of alpha a over a pure-white pixel is the worst case a still can offer.
    const worst = (a: number) => {
      const bg = lum(255 * (1 - a));
      return 1.05 / (bg + 0.05);
    };
    const phone = css.match(/\.nx-show-head \{[^}]*rgba\(8, 8, 8, ([\d.]+)\) calc\(100% - 108px\)/);
    expect(phone, "phone overlay stop").toBeTruthy();
    expect(worst(Number(phone![1]))).toBeGreaterThan(7);
    const wide = css.match(/\.nx-show-pic::after \{[^}]*rgba\(8, 8, 8, ([\d.]+)\) 0%, rgba\(8, 8, 8, ([\d.]+)\) 44%/);
    expect(wide, "desktop overlay stops").toBeTruthy();
    expect(worst(Number(wide![1]))).toBeGreaterThan(7);
    expect(worst(Number(wide![2]))).toBeGreaterThan(7);
    // The text column on a desktop is narrower than the dark part of the gradient (46% wide, the overlay is 76%+ opaque to 44%).
    expect(css).toMatch(/\.nx-show-text \{[^}]*width: 46%/);
  });
});

describe("the demo's stand-in frame", () => {
  it.each(LOCALES.map((l) => l.code))("%s: each sample topic maps to its own frame, the same one every time", (code) => {
    const topics = dictionaries[code].site.try.topics;
    expect(topics.map((t) => pickStill(t))).toEqual(["silkroad", "lighthouse", "moon", "nightmarket"]);
    expect(topics.map((t) => pickStill(t))).toEqual(topics.map((t) => pickStill(t)));
  });

  it("falls back to a fixed pick for words it does not know, and never to nothing", () => {
    for (const t of ["zzz", "Qwerty uiop", "какая-то тема", "bilmayman"]) {
      expect(STILL_IDS).toContain(pickStill(t));
      expect(pickStill(t)).toBe(pickStill(t));
    }
  });
});

describe("round 3: stills, header and the draw-in", () => {
  it("draws every still whole (no crop classes on the landing): variety comes from one different still per section", () => {
    const { container } = landing();
    for (const i of container.querySelectorAll("figure.nx-chat img:not(.nx-fx-fg), section.nx-show img:not(.nx-fx-fg)")) expect(i.getAttribute("data-crop")).toBeNull();
  });

  it("makes the header's Start free the same amber key as the page's button (one primary action)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const shell = readFileSync(join(__dirname, "..", "components/legal/PublicShell.tsx"), "utf8");
    expect(shell).toMatch(/href="\/signup" className="st-key" data-size="sm">/);
    expect(shell).not.toContain('data-tone="quiet"');
  });

  it("draws the sample plan in once when the section first scrolls into view, and never when motion is reduced", () => {
    vi.useFakeTimers();
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 5000, bottom: 5600, left: 0, right: 1000, width: 1000, height: 600, x: 0, y: 5000, toJSON: () => ({}) });
    let reduced = false;
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") ? reduced : false, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    const observers: ((e: { isIntersecting: boolean }[]) => void)[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    try {
      const { container, unmount } = landing();
      const cards = () => [...container.querySelectorAll("#try .nx-try-card")];
      // Below the fold: held back (boxes keep their space), the sentence under the field still describes the sample.
      expect(cards().every((c) => c.getAttribute("data-on") === "false")).toBe(true);
      act(() => observers.forEach((cb) => cb([{ isIntersecting: true }])));
      act(() => void vi.advanceTimersByTime(260));
      const some = cards().filter((c) => c.getAttribute("data-on") === "true").length;
      expect(some).toBeGreaterThanOrEqual(1);
      expect(some).toBeLessThan(cards().length);
      act(() => void vi.advanceTimersByTime(4000));
      expect(cards().every((c) => c.getAttribute("data-on") === "true")).toBe(true);
      unmount();
      // Reduced motion: all there from the start, nothing observed.
      reduced = true;
      const again = landing();
      expect([...again.container.querySelectorAll("#try .nx-try-card")].every((c) => c.getAttribute("data-on") === "true")).toBe(true);
    } finally {
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

