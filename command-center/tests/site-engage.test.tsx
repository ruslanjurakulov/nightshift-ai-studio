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
import { buildPlan, cleanTopic, TOPIC_MAX } from "@/lib/site/demo-plan";
import { freeMinutes, priceRatesFrom, quoteCents, quoteCredits } from "@/lib/site/price-check";
import { setMotionPaused } from "@/lib/site/motion";
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
    expect(container.querySelector("#price-check")).toBeNull();
    unmount();
    const priced = landing(PRICED);
    expect(priced.container.querySelector("#price-check")).not.toBeNull();
  });

  it("moves the price when the slider moves, from the published rate and nothing else", () => {
    const { container } = landing(PRICED);
    const section = container.querySelector("#price-check") as HTMLElement;
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

  it("plays the example out: nothing shows until a topic is asked for, then every section appears with the topic in it, labelled as an example", () => {
    vi.useFakeTimers();
    const t = dictionaries.en.site.try;
    const { container } = landing();
    const section = container.querySelector("#try") as HTMLElement;
    const cards = () => [...section.querySelectorAll(".nx-try-card")];
    expect(cards().every((c) => c.getAttribute("data-on") === "false" && c.hasAttribute("inert"))).toBe(true);
    expect(section.textContent).toContain(t.tag);

    // An empty ask is refused in words, with focus back on the field.
    fireEvent.click(within(section).getByRole("button", { name: t.run }));
    expect(within(section).getByRole("status").textContent).toBe(t.noTopic);
    expect(cards().every((c) => c.getAttribute("data-on") === "false")).toBe(true);

    fireEvent.change(within(section).getByLabelText(t.fieldLabel), { target: { value: "How tides work" } });
    fireEvent.click(within(section).getByRole("button", { name: t.run }));
    act(() => void vi.advanceTimersByTime(260));
    expect(cards().filter((c) => c.getAttribute("data-on") === "true").length).toBeGreaterThanOrEqual(1);
    expect(cards().filter((c) => c.getAttribute("data-on") === "true").length).toBeLessThan(cards().length);
    act(() => void vi.advanceTimersByTime(5000));
    expect(cards().every((c) => c.getAttribute("data-on") === "true")).toBe(true);
    expect(cards().map((c) => c.textContent).join(" ")).toContain("How tides work");
    expect(within(section).getByRole("status").textContent).toBe(t.ready);
    // The way out: "Make this for real" goes to sign-up, and says what the real thing adds.
    const cta = within(section).getByRole("link", { name: t.cta });
    expect(cta.getAttribute("href")).toBe("/signup");
    expect(section.textContent).toContain(t.real);
  });

  it("shows the whole plan at once when the visitor has paused motion", () => {
    const t = dictionaries.en.site.try;
    setMotionPaused(true);
    const { container } = landing();
    const section = container.querySelector("#try") as HTMLElement;
    fireEvent.click(within(section).getByRole("button", { name: t.topics[0] }));
    expect([...section.querySelectorAll(".nx-try-card")].every((c) => c.getAttribute("data-on") === "true")).toBe(true);
  });

  it("compares by hand and with Nightshift using only who does each step: no hours, no percentages, and the topic and the publish press stay with the person", () => {
    const { container } = landing();
    const cmp = container.querySelector("#compare") as HTMLElement;
    expect(cmp.textContent).not.toMatch(/\d/);
    expect([...cmp.querySelectorAll(".nx-cmp-row")].map((r) => r.getAttribute("data-yours") === "true")).toEqual([true, false, false, false, false, true]);
  });

  it("carries one sticky start bar that is inert until it is shown, and a pause switch that sets the page's motion", () => {
    const t = dictionaries.en.site;
    const { container } = landing();
    const bar = container.querySelector(".nx-bar") as HTMLElement;
    expect(bar.getAttribute("data-shown")).toBe("false");
    expect(bar.hasAttribute("inert")).toBe(true);
    expect(within(bar).getByText(t.bar.cta).closest("a")!.getAttribute("href")).toBe("/signup");
    expect(bar.querySelector("button")!.getAttribute("aria-label")).toBe(t.bar.dismiss);

    const toggle = screen.getByRole("button", { name: t.fx.pause });
    fireEvent.click(toggle);
    expect(document.documentElement.getAttribute("data-motion")).toBe("paused");
    expect(screen.getByRole("button", { name: t.fx.play })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.fx.play }));
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
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
    render(<MotionToggle pause="Pause" play="Play" />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(document.documentElement.getAttribute("data-motion")).toBe("paused");
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
  it.each(LOCALES.map((l) => l.code))("%s: the hero stage and every still-backed capability show the note as visible text", (code) => {
    const { container } = landing(NO_MONEY, code);
    const note = dictionaries[code].site.samples.note;
    const stage = container.querySelector(".nx-stage") as HTMLElement;
    const stageNote = stage.querySelector(".nx-stage-note") as HTMLElement;
    expect(stageNote.textContent).toBe(note);
    expect(stageNote.closest("[aria-hidden]")).toBeNull();
    const figs = [...container.querySelectorAll("figure.nx-demo")].filter((f) => f.querySelector("img"));
    expect(figs).toHaveLength(4);
    for (const f of figs) {
      const cap = f.querySelector("figcaption.nx-demo-note") as HTMLElement;
      expect(cap.textContent).toBe(note);
      expect(cap.closest("[aria-hidden]")).toBeNull();
    }
  });
});

