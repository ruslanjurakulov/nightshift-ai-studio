// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/atelier/a",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, type Locale } from "@/lib/i18n";
import { conceptCopy } from "@/lib/i18n/site/concepts";
import { ConceptA } from "@/components/concepts/ConceptA";
import { ConceptB } from "@/components/concepts/ConceptB";
import { ConceptC } from "@/components/concepts/ConceptC";
import type { MoneyAnchor } from "@/lib/landing";
import { PROVIDER_BRANDS } from "./helpers/brands";

afterEach(cleanup);

const LOCALES: Locale[] = ["en", "ru", "uz"];
const NONE: MoneyAnchor = { pack: { kind: "none" }, api: null, site: null };
const PRICED: MoneyAnchor = {
  pack: { kind: "priced", id: "starter", credits: 1000, price: "$10" } as MoneyAnchor["pack"],
  api: { perMinuteCents: 120, minimumCents: 60 },
  site: { perMinute: 100, minimum: 20, usd: { cents: 100, pack: "starter" } },
};
const VARIANTS = { A: ConceptA, B: ConceptB, C: ConceptC } as const;

describe.each(Object.entries(VARIANTS))("Concept %s", (_name, Concept) => {
  it.each(LOCALES)("renders one h1, one primary key, a price line and no unknowns as numbers (%s)", (locale) => {
    const t = dictionaries[locale];
    const { container } = render(<Concept t={t} locale={locale} anchor={NONE} />);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1")?.textContent).toContain(t.site.hero.titleA);
    // exactly one lit primary key: the sign-up link (drawn keys inside illustrations are not links)
    const keys = [...container.querySelectorAll("a.st-key")];
    expect(keys).toHaveLength(1);
    expect(keys[0].getAttribute("href")).toBe("/signup");
    // nothing priced, so the price words say so and no figure or "free" is invented
    expect(container.textContent).toContain(t.site.anchor.none);
    expect(container.textContent).not.toMatch(/NaN|undefined|\bnull\b/);
    expect(container.textContent).not.toMatch(/[$€£₽]\s?\d/);
  });

  it("states a known price with the live price-list wording", () => {
    const t = dictionaries.en;
    const { container } = render(<Concept t={t} locale="en" anchor={PRICED} />);
    expect(container.textContent).toContain("100 credits a minute of finished video");
    expect(container.textContent).toContain("at least 20 credits a run");
    expect(container.textContent).toContain("$10 for 1,000 credits");
    expect(container.textContent).not.toContain(t.site.anchor.none);
  });

  it.each(LOCALES)("names no AI provider, model or competitor, and has no emoji (%s)", (locale) => {
    const { container } = render(<Concept t={dictionaries[locale]} locale={locale} anchor={NONE} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(PROVIDER_BRANDS);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("nothing that looks pressable inside the illustration is a button or a link", () => {
    const { container } = render(<Concept t={dictionaries.en} locale="en" anchor={NONE} />);
    for (const img of container.querySelectorAll('[role="img"]')) {
      expect(img.querySelector("a, button, input, select, textarea")).toBeNull();
    }
  });
});

describe("concept copy", () => {
  it("has the same keys, none empty, in en, ru and uz", () => {
    const shape = (v: unknown): unknown =>
      typeof v === "string" ? (v.trim() ? "s" : "EMPTY") : Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, shape(x)]));
    expect(shape(conceptCopy.ru)).toEqual(shape(conceptCopy.en));
    expect(shape(conceptCopy.uz)).toEqual(shape(conceptCopy.en));
    expect(JSON.stringify(shape(conceptCopy.en))).not.toContain("EMPTY");
  });

  it("spells Uzbek apostrophes one way", () => {
    const whole = readFileSync(join(__dirname, "..", "lib/i18n/site/concepts.ts"), "utf8");
    const text = whole.slice(whole.indexOf("  uz: {"));
    expect([...text.matchAll(/[A-Za-zʻʼ]'(?![A-Za-z])|[A-Za-z]'[A-Za-z]/g)].map((m) => m[0])).toEqual([]);
  });
});

describe("the motion contract", () => {
  it("imports Motion only through the kit (no motion.*, no framer-motion, no import * as m, no gsap)", () => {
    for (const f of ["ConceptA", "ConceptB", "ConceptC", "Playhead", "ConceptShell"]) {
      const src = readFileSync(join(__dirname, "..", "components/concepts", `${f}.tsx`), "utf8");
      expect(src).not.toMatch(/framer-motion|import \* as m\b|from "gsap|from "motion\/react";\s*$/m);
      expect(src).not.toMatch(/\bmotion\.(div|span|li)\b/);
    }
  });
});
