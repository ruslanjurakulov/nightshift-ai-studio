// @vitest-environment jsdom
/**
 * The public site's media-first cards (components/site/media-card.css, TapReveal.tsx, lib/site/card-words.ts), applied to the
 * explore grid, the Effects section and the phone's Shorts feed.
 *
 * Owner decision 22 Nov: no model name on public cards; it travels only in the Studio link. At rest a card is its media and one
 * AI mark; the caption (a bold title and one grey line) shows on hover, keyboard focus or a first tap on a phone; the click opens
 * the Studio with the sample's tool, model and words. What would break if these failed: a model name or id creeping back into a
 * card's text, alt, title, aria or data attributes; a card that loses its AI label (generated media must be labelled); a phone
 * tap that leaves for sign-up before the person read the card; a mouse or keyboard click that is swallowed; the whole prompt
 * printed on a card that has its own short line; a malformed card line that hides a whole sample.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, LOCALES } from "@/lib/i18n";
import { CARD_LINE_MAX, SHOWCASE_ENTRIES, parseCardLine, parseShowcaseEntry } from "@/lib/site/showcase";
import { cardWords, firstSentence } from "@/lib/site/card-words";
import { tryHref } from "@/lib/site/showcase-link";
import { EFFECTS } from "@/lib/effects/catalog";
import { ShowcaseGallery } from "@/components/site/ShowcaseGallery";
import { EffectsGallery } from "@/components/site/EffectsGallery";
import { TapReveal } from "@/components/site/TapReveal";
import { shortsItems } from "@/components/site/shorts";
import { showcaseItems } from "@/components/site/ShowcaseGallery";
import { PROVIDER_BRANDS } from "./helpers/brands";
import { FIXTURE_ENTRY, FIXTURE_FILES } from "./fixtures/showcase-entry";

afterEach(cleanup);

const ROOT = join(__dirname, "..");
const REGISTRY = JSON.parse(readFileSync(join(ROOT, "..", "schemas", "model_registry.json"), "utf8")) as { models: { id: string; display_name: string }[] };

/** Every word a reader or a crawler could take from `el` except its links' hrefs: text, and every other attribute's value. */
function wordsExceptHrefs(el: Element): string {
  const parts = [el.textContent ?? ""];
  for (const n of [el, ...el.querySelectorAll("*")]) for (const a of n.attributes) if (a.name !== "href") parts.push(a.value);
  return parts.join("\n");
}

/** The registry's models a piece of markup names, by display name or by id, outside hrefs. */
function namedModels(el: Element): string[] {
  const words = wordsExceptHrefs(el);
  return REGISTRY.models.filter((m) => words.includes(m.display_name) || new RegExp(`(^|[^a-z0-9.-])${m.id.replace(/[.]/g, "\\.")}($|[^a-z0-9.-])`).test(words)).map((m) => m.id);
}

describe("no model name on the public cards (owner decision 22 Nov)", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the shipped gallery names no registry model or maker outside its links' model=, and every card has the AI mark and a caption", (code) => {
    const d = dictionaries[code];
    const { container } = render(<ShowcaseGallery t={d} locale={code} />);
    if (showcaseItems().length === 0) return;
    const section = container.querySelector("section#samples")!;
    expect(namedModels(section)).toEqual([]);
    expect(wordsExceptHrefs(section)).not.toMatch(PROVIDER_BRANDS);
    const cards = [...section.querySelectorAll("[data-showcase-entry]")];
    for (const c of cards) {
      expect(c.querySelector(".mf-ai")?.textContent).toBe(d.site.gallery.badge);
      expect(c.querySelector(".mf-cap .mf-desc")).toBeTruthy();
      expect(c.hasAttribute("data-model")).toBe(false);
    }
    // The model the sample was made with is still in the link where it is on sale: the Studio needs it to preselect.
    const withModel = cards.filter((c) => /[?&]model%3D|[?&]model=/.test(c.querySelector("a")?.getAttribute("href") ?? ""));
    const onSale = showcaseItems().filter(({ e }) => !e.operatorPreview && !(e.shutdownOn && e.shutdownOn <= new Date().toISOString().slice(0, 10)));
    expect(withModel.length).toBe(onSale.length);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the Effects section names no model; each card is its frame, one corner mark that tells a result from a drawing, and a caption", (code) => {
    const d = dictionaries[code];
    const { container } = render(<EffectsGallery t={d} />);
    const section = container.querySelector("section#effects")!;
    expect(namedModels(section)).toEqual([]);
    expect(wordsExceptHrefs(section)).not.toMatch(PROVIDER_BRANDS);
    for (const e of EFFECTS) {
      const card = section.querySelector(`[data-effect="${e.id}"]`)!;
      const link = card.querySelector("a.mf-card[data-mf-card]")!;
      expect(link).toBeTruthy();
      expect(card.querySelectorAll("a")).toHaveLength(1);
      const sampled = card.querySelector(".fx-frame")!.hasAttribute("data-sample");
      // An AI label only on a real result; a drawing says it is one (never "AI-generated" on something that is not).
      expect(link.querySelector(".mf-ai")?.textContent).toBe(sampled ? d.site.gallery.badge : d.effects.site.drawing);
      expect(link.querySelector(".mf-cap .mf-title")?.textContent).toBe(d.effects.items[e.id].name);
      expect(link.querySelector(".mf-cap .mf-desc")?.textContent).toBe(d.effects.items[e.id].line);
      expect(link.querySelector(".mf-cap .mf-facts")?.textContent).toContain(d.effects.kinds[e.capability]);
      expect(document.getElementById(link.getAttribute("aria-describedby")!)).toBe(link.querySelector(".mf-cap"));
    }
  });

  it("the Shorts feed's items carry no model name, only the link that preselects it", () => {
    const tall = { ...FIXTURE_ENTRY, operatorPreview: false, modelId: "minimax-hailuo-2.3", modelName: "MiniMax Hailuo 2.3", capability: "t2v", width: 1280, height: 2240 };
    const [item] = shortsItems([{ e: tall, f: FIXTURE_FILES[FIXTURE_ENTRY.jobId] }], false, new Date("2026-11-22T00:00:00Z"));
    expect(Object.keys(item)).not.toContain("modelName");
    const { href, ...rest } = item;
    expect(JSON.stringify(rest)).not.toContain("MiniMax");
    expect(JSON.stringify(rest)).not.toContain(tall.modelId);
    expect(href).toBe(tryHref(tall, false));
    expect(decodeURIComponent(href!)).toContain(`model=${tall.modelId}`);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the gallery's words that said a card names its model are gone", (code) => {
    const s = dictionaries[code].site;
    expect(Object.keys(s.gallery)).not.toEqual(expect.arrayContaining(["tryAria"]));
    for (const k of ["open", "detail", "close", "made", "source", "altSource"]) expect(Object.keys(s.gallery)).not.toContain(k);
    expect(Object.keys(s)).not.toContain("models");
    expect(Object.keys(s.autopilot.shorts)).not.toContain("madeBy");
  });
});

describe("the card line (showcase.json cardLine)", () => {
  const LINE = { en: "Registan at blue hour.", ru: "Регистан в синий час.", uz: "Registon moviy soatda." };

  it("parses a well-formed one; absent, null or malformed is null and never drops the sample", () => {
    expect(parseShowcaseEntry({ ...FIXTURE_ENTRY, cardLine: LINE })?.cardLine).toEqual(LINE);
    const { cardLine: _drop, ...without } = FIXTURE_ENTRY;
    for (const v of [undefined, null, "Registan", [], { en: "x" }, { ...LINE, uz: "" }, { ...LINE, ru: 7 }, { ...LINE, en: "a".repeat(CARD_LINE_MAX + 1) }, { ...LINE, en: "‮​ " }]) {
      const e = parseShowcaseEntry(v === undefined ? without : { ...FIXTURE_ENTRY, cardLine: v });
      expect(e, JSON.stringify(v)).not.toBeNull();
      expect(e!.cardLine, JSON.stringify(v)).toBeNull();
    }
    // Controls and bidi overrides are taken out, runs of space folded.
    expect(parseCardLine({ ...LINE, en: `Regis‮tan\u0000  at\nblue hour.` })?.en).toBe("Registan at blue hour.");
    expect(parseCardLine({ ...LINE, en: "🏮".repeat(CARD_LINE_MAX) })?.en).toBe("🏮".repeat(CARD_LINE_MAX));
    // Every shipped entry parsed (no card line yet is fine: the fallback covers it).
    for (const e of SHOWCASE_ENTRIES) expect(e.cardLine === null || typeof e.cardLine.en === "string").toBe(true);
  });

  it("the card shows the line in its language, else the prompt's first sentence", () => {
    expect(cardWords({ cardLine: LINE, prompt: "long prompt. more" }, "ru")).toBe(LINE.ru);
    expect(cardWords({ cardLine: null, prompt: "  A tram in rain.  Close-up, 35mm." }, "uz")).toBe("A tram in rain.");
    expect(cardWords({ cardLine: null, prompt: "" }, "en")).toBe("");
    expect(firstSentence("v1.2 of the shot, no stop here")).toBe("v1.2 of the shot, no stop here");
    const long = firstSentence("word ".repeat(80));
    expect(long.endsWith("…")).toBe(true);
    expect(Array.from(long).length).toBeLessThanOrEqual(CARD_LINE_MAX + 1);
  });
});

describe("TapReveal: the first tap on a phone shows the caption, the second opens the card", () => {
  function grid() {
    return render(
      <div>
        <ul>
          <li>
            <a href="#one" data-mf-card="" data-testid="one">
              <img alt="AI-generated clip" />
            </a>
          </li>
          <li>
            <a href="#two" data-mf-card="" data-testid="two">
              two
            </a>
          </li>
        </ul>
        <TapReveal />
      </div>,
    );
  }
  /** A click as a browser delivers it after a pointer of `kind` went down on `el` (jsdom has no PointerEvent: a MouseEvent with pointerType). */
  function press(el: Element, kind: "touch" | "pen" | "mouse" | null): boolean {
    if (kind) {
      const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
      Object.defineProperty(down, "pointerType", { value: kind });
      el.dispatchEvent(down);
    }
    return fireEvent.click(el);
  }

  it("a touch click on an unrevealed card is held back and reveals it; a second touch click on it goes through", () => {
    const { getByTestId } = grid();
    const one = getByTestId("one");
    expect(press(one.querySelector("img")!, "touch")).toBe(false);
    expect(one.getAttribute("data-revealed")).toBe("true");
    expect(press(one, "touch")).toBe(true);
  });

  it("revealing another card clears the first, and a pen behaves as a finger", () => {
    const { getByTestId } = grid();
    press(getByTestId("one"), "touch");
    expect(press(getByTestId("two"), "pen")).toBe(false);
    expect(getByTestId("two").getAttribute("data-revealed")).toBe("true");
    expect(getByTestId("one").hasAttribute("data-revealed")).toBe(false);
  });

  it("a mouse click and a keyboard Enter (a click with no pointer) are never held back", () => {
    const { getByTestId } = grid();
    expect(press(getByTestId("one"), "mouse")).toBe(true);
    expect(getByTestId("one").hasAttribute("data-revealed")).toBe(false);
    expect(press(getByTestId("two"), null)).toBe(true);
    // A touch earlier does not make a later keyboard click look like one.
    press(getByTestId("one"), "touch");
    expect(press(getByTestId("two"), null)).toBe(true);
  });

  it("renders nothing a reader sees, and is mounted beside each grid (not inside a list)", () => {
    const { container } = grid();
    const span = container.querySelector("[data-tap-reveal]")!;
    expect(span.hasAttribute("hidden")).toBe(true);
    expect(span.parentElement?.tagName).toBe("DIV");
  });
});

describe("the stylesheet", () => {
  const css = readFileSync(join(ROOT, "components/site/media-card.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("hides the caption at rest and shows it for a fine pointer's hover, keyboard focus and a revealed tap", () => {
    expect(css).toMatch(/\.mf-cap \{[^}]*opacity: 0; pointer-events: none;/);
    expect(css).toContain('.mf-card:focus-visible .mf-cap, .mf-card:focus-within .mf-cap, .mf-card[data-revealed="true"] .mf-cap { opacity: 1; }');
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\s*\.mf-card:hover \.mf-cap \{ opacity: 1; \}/);
    // The AI mark is never hidden.
    const ai = css.match(/\.mf-ai \{([^}]*)\}/)![1];
    expect(ai).not.toMatch(/opacity:\s*0|display:\s*none|visibility|text-overflow|nowrap/);
  });

  it("sets the Kling caption scale: a bold 22 px white title, a 16 px grey line, over a foot that ends near-black", () => {
    expect(css).toMatch(/\.mf-title \{[^}]*font-size: 1\.375rem; font-weight: 700;[^}]*color: #fff;/);
    expect(css).toMatch(/\.mf-desc \{[^}]*font-size: 1rem;[^}]*color: rgba\(255, 255, 255, 0\.66\);[^}]*-webkit-line-clamp: 1;/);
    expect(css).toMatch(/\.mf-cap \{[^}]*linear-gradient\(180deg, rgba\(0, 0, 0, 0\) 0%[^)]*\)[^}]*rgba\(0, 0, 0, 0\.82\) 100%\)/);
    expect(css).toMatch(/\.nx-section:is\(#samples, #effects\) \.nx-h2 \{\s*font-size: var\(--ds-fs-display-lg, clamp\(2rem, 1\.5rem \+ 2\.2222vw, 3\.5rem\)\); font-weight: 700;/);
  });

  it("moves the caption only where motion is allowed, and only fades it under the page's pause switch", () => {
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}\n/g, "");
    expect(outside).not.toMatch(/translate|scale\(/);
    expect(css).toMatch(/html\[data-motion="paused"\] \.mf-cap \{ transform: none; transition: opacity/);
  });
});
