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
import { aiMarkOf } from "./helpers/ai-mark";
import { FIXTURE_ENTRY, FIXTURE_FILES } from "./fixtures/showcase-entry";
import raw from "@/lib/site/showcase.json";
import { CARD_TITLE_MAX, CARD_TITLES, cardTitle } from "@/lib/site/card-titles";

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
      // "AI" on screen in every language (owner decision 22 Nov), its full meaning for a screen reader in the link's description.
      expect(aiMarkOf(c.querySelector(".mf-ai"))).toEqual({ seen: d.site.gallery.badge, said: d.site.gallery.badgeName });
      const link = c.querySelector("a.mf-card-link");
      // The link is described by the mark itself, whose spoken words are the full label (the "AI" half is aria-hidden).
      if (link) expect(link.getAttribute("aria-describedby")!.split(" ")).toContain(c.querySelector(".mf-ai")!.id);
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
      expect(card.hasAttribute("data-mf-card")).toBe(true);
      const link = card.querySelector("a.mf-card-link")!;
      expect(link).toBeTruthy();
      expect(link.parentElement).toBe(card);
      expect(card.querySelectorAll("a")).toHaveLength(1);
      const sampled = card.querySelector(".fx-frame")!.hasAttribute("data-sample");
      // "AI" only on a real result; a drawing says it is one (never an AI label on something that is not).
      if (sampled) expect(aiMarkOf(card.querySelector(".mf-ai"))).toEqual({ seen: d.site.gallery.badge, said: d.site.gallery.badgeName });
      else expect(card.querySelector(".mf-ai")?.textContent).toBe(d.effects.site.drawing);
      expect(card.querySelector(".mf-cap .mf-title")?.textContent).toBe(d.effects.items[e.id].name);
      expect(card.querySelector(".mf-cap .mf-desc")?.textContent).toBe(d.effects.items[e.id].line);
      expect(card.querySelector(".mf-cap .mf-facts")?.textContent).toContain(d.effects.kinds[e.capability]);
      // The link's description: the caption, and whether the frame is a real result or a drawing (the frame's own badge), and
      // for a real result that it is AI-generated.
      const described = link.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id));
      expect(described).toContain(card.querySelector(".mf-cap"));
      const words = described.map((n) => n?.textContent ?? "").join(" ");
      expect(words).toContain(sampled ? d.effects.sample : d.effects.noSample);
      if (sampled) expect(words).toContain(d.site.gallery.badgeName);
      else expect(words).not.toContain(d.site.gallery.badgeName);
    }
  });

  it("the Shorts feed's items carry no model name, only the link that preselects it", () => {
    const tall = { ...FIXTURE_ENTRY, operatorPreview: false, modelId: "minimax-hailuo-2.3", modelName: "MiniMax Hailuo 2.3", capability: "t2v", width: 1280, height: 2240 };
    const [item] = shortsItems([{ e: tall, f: FIXTURE_FILES[FIXTURE_ENTRY.jobId] }], false, new Date("2026-11-22T00:00:00Z"), "ru");
    expect(Object.keys(item)).not.toContain("modelName");
    const { href, ...rest } = item;
    expect(JSON.stringify(rest)).not.toContain("MiniMax");
    expect(JSON.stringify(rest)).not.toContain(tall.modelId);
    expect(href).toBe(tryHref(tall, false));
    expect(decodeURIComponent(href!)).toContain(`model=${tall.modelId}`);
    // The slide shows the card's line, not the whole prompt; the prompt's first sentence is English whatever the page's language.
    expect(item.line).toBe(firstSentence(tall.prompt));
    expect(item.lang).toBe("en");
    const lined = shortsItems([{ e: { ...tall, cardLine: { en: "Lanterns.", ru: "Фонари.", uz: "Chiroqlar." } }, f: FIXTURE_FILES[FIXTURE_ENTRY.jobId] }], false, new Date("2026-11-22T00:00:00Z"), "ru")[0];
    expect([lined.line, lined.lang]).toEqual(["Фонари.", "ru"]);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the gallery's words that said a card names its model are gone", (code) => {
    const s = dictionaries[code].site;
    expect(Object.keys(s.gallery)).not.toEqual(expect.arrayContaining(["tryAria"]));
    for (const k of ["open", "detail", "close", "made", "source", "altSource"]) expect(Object.keys(s.gallery)).not.toContain(k);
    expect(Object.keys(s.autopilot.shorts)).not.toContain("madeBy");
    expect(Object.keys(s.gallery)).not.toContain("try");
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

  it("the card shows the line in its language (marked with it), else the prompt's first sentence (marked English)", () => {
    expect(cardWords({ cardLine: LINE, prompt: "long prompt. more" }, "ru")).toEqual({ text: LINE.ru, lang: "ru", source: "cardLine" });
    expect(cardWords({ cardLine: null, prompt: "  A tram in rain.  Close-up, 35mm." }, "uz")).toEqual({ text: "A tram in rain.", lang: "en", source: "prompt" });
    expect(cardWords({ cardLine: null, prompt: "" }, "en").text).toBe("");
    expect(firstSentence("v1.2 of the shot, no stop here")).toBe("v1.2 of the shot, no stop here");
    const long = firstSentence("word ".repeat(80));
    expect(long.endsWith("…")).toBe(true);
    expect(Array.from(long).length).toBeLessThanOrEqual(CARD_LINE_MAX + 1);
  });

  it("does not end a sentence on an abbreviation, and never leaves a comma or dash before the ellipsis", () => {
    expect(firstSentence("St. Petersburg at dusk. Drone shot.")).toBe("St. Petersburg at dusk.");
    expect(firstSentence("Dr. Who vs. a robot, e.g. in rain. Then more.")).toBe("Dr. Who vs. a robot, e.g. in rain.");
    expect(firstSentence("Mr. and Mrs. Smith i.e. the couple dance. End.")).toBe("Mr. and Mrs. Smith i.e. the couple dance.");
    // A cut that lands after a comma or a dash drops it before the ellipsis.
    const words = `${"lantern ".repeat(16)}rise, ${"glow ".repeat(30)}`;
    const cut = firstSentence(words);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toMatch(/[,;:—–-]…$/);
    expect(firstSentence(`${"a".repeat(130)} bb, — ${"c".repeat(20)}`)).toBe(`${"a".repeat(130)} bb…`);
  });
});

describe("TapReveal: the first tap on a phone shows the caption, the second opens the card", () => {
  // The cards as the grids draw them: the media, a caption and a control laid over the clip (the sound key), then the stretched link.
  function grid() {
    return render(
      <div>
        <ul>
          <li data-mf-card="" data-testid="one">
            <img alt="AI-generated clip" />
            <span className="mf-cap">one</span>
            <button type="button" data-tap-ignore="" data-testid="sound">
              sound
            </button>
            <a href="#one" className="mf-card-link" data-testid="one-link">
              one
            </a>
          </li>
          <li data-mf-card="" data-testid="two">
            <a href="#two" className="mf-card-link" data-testid="two-link">
              two
            </a>
          </li>
        </ul>
        <p data-testid="outside">outside</p>
        <TapReveal />
      </div>,
    );
  }
  /** A pointerdown of `kind` (jsdom has no PointerEvent: a MouseEvent with pointerType). */
  function down(el: Element, kind: string, type = "pointerdown") {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "pointerType", { value: kind });
    el.dispatchEvent(ev);
  }
  /** A click as a browser delivers it after a pointer of `kind` went down on `el`; `detail` 1 is a real press, 0 a keyboard's. */
  function press(el: Element, kind: "touch" | "pen" | "mouse" | null, detail = 1): boolean {
    if (kind) down(el, kind);
    return fireEvent.click(el, { detail });
  }

  it("a touch click on an unrevealed card is held back and reveals it; a second touch click on it goes through", () => {
    const { getByTestId } = grid();
    expect(press(getByTestId("one-link"), "touch")).toBe(false);
    expect(getByTestId("one").getAttribute("data-revealed")).toBe("true");
    expect(press(getByTestId("one-link"), "touch")).toBe(true);
  });

  it("revealing another card clears the first, a pen behaves as a finger, and a tap outside every card clears it", () => {
    const { getByTestId } = grid();
    press(getByTestId("one-link"), "touch");
    expect(press(getByTestId("two-link"), "pen")).toBe(false);
    expect(getByTestId("two").getAttribute("data-revealed")).toBe("true");
    expect(getByTestId("one").hasAttribute("data-revealed")).toBe(false);
    down(getByTestId("outside"), "touch");
    expect(getByTestId("two").hasAttribute("data-revealed")).toBe(false);
  });

  it("a mouse click and a keyboard Enter (detail 0) are never held back, even right after a touch went down", () => {
    const { getByTestId } = grid();
    expect(press(getByTestId("one-link"), "mouse")).toBe(true);
    expect(getByTestId("one").hasAttribute("data-revealed")).toBe(false);
    expect(press(getByTestId("two-link"), null, 0)).toBe(true);
    down(getByTestId("one-link"), "touch");
    expect(press(getByTestId("one-link"), null, 0)).toBe(true);
    expect(getByTestId("one").hasAttribute("data-revealed")).toBe(false);
  });

  it("a gesture the browser cancelled leaves nothing behind: pointerdown, pointercancel, then a click is not held", () => {
    const { getByTestId } = grid();
    down(getByTestId("one-link"), "touch");
    down(getByTestId("one-link"), "touch", "pointercancel");
    expect(press(getByTestId("one-link"), null)).toBe(true);
    expect(getByTestId("one").hasAttribute("data-revealed")).toBe(false);
  });

  it("a tap on a control laid over the card (data-tap-ignore) is not held and reveals nothing", () => {
    const { getByTestId } = grid();
    expect(press(getByTestId("sound"), "touch")).toBe(true);
    expect(getByTestId("one").hasAttribute("data-revealed")).toBe(false);
  });

  it("a card whose link already had focus before the tap (a screen reader's) opens at once: its caption is showing", () => {
    const { getByTestId } = grid();
    (getByTestId("one-link") as HTMLAnchorElement).focus();
    expect(press(getByTestId("one-link"), "touch")).toBe(true);
    expect(getByTestId("one").hasAttribute("data-revealed")).toBe(false);
  });

  it("coming back to the page (pageshow) hides a revealed caption", () => {
    const { getByTestId } = grid();
    press(getByTestId("one-link"), "touch");
    window.dispatchEvent(new Event("pageshow"));
    expect(getByTestId("one").hasAttribute("data-revealed")).toBe(false);
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
    expect(css).toContain('.mf-card:focus-within .mf-cap, .mf-card:has(.mf-card-link:focus-visible) .mf-cap, .mf-card[data-revealed="true"] .mf-cap { opacity: 1; }');
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\s*\.mf-card:hover \.mf-cap \{ opacity: 1; \}/);
    // The AI mark is never hidden.
    const ai = css.match(/\.mf-ai \{([^}]*)\}/)![1];
    expect(ai).not.toMatch(/opacity:\s*0|display:\s*none|visibility|text-overflow|nowrap/);
  });

  it("sets the Kling caption scale: a bold 22 px white title, a 16 px grey line, over a foot that ends near-black", () => {
    expect(css).toMatch(/\.mf-title \{[^}]*font-size: 1\.375rem; font-weight: 700;[^}]*color: #fff;/);
    expect(css).toMatch(/\.mf-desc \{[^}]*font-size: 1rem;[^}]*color: rgba\(255, 255, 255, 0\.66\);[^}]*-webkit-line-clamp: 1;/);
    expect(css).toMatch(/\.mf-cap \{[^}]*linear-gradient\(180deg, rgba\(0, 0, 0, 0\) 0%[^)]*\)[^}]*rgba\(0, 0, 0, 0\.82\) 100%\)/);
    // 48 px at 1440 (1rem + 32px), 32 px at 360: the owner's ~48 px section heads.
    expect(css).toContain(".nx-section:is(#samples, #effects) .nx-h2 { font-size: clamp(2rem, 1rem + 2.2222vw, 3rem); font-weight: 700; }");
    // A title may take two balanced lines (Russian and Uzbek run longer); an effect's line two rows; its facts 14 px.
    expect(css).toMatch(/\.mf-title \{[^}]*text-wrap: balance;[^}]*-webkit-line-clamp: 2;/);
    expect(css).toContain(".efx-card .mf-desc { -webkit-line-clamp: 2; line-clamp: 2; }");
    expect(css).toMatch(/\.mf-facts \{[^}]*font-size: 14px;[^}]*color: rgba\(255, 255, 255, 0\.72\);/);
  });

  it("lays one stretched link over the card, the caption and mark above it taking no clicks, and the focus ring above them", () => {
    expect(css).toMatch(/\.mf-card-link \{ position: absolute; inset: 0; z-index: 1;/);
    expect(css).toMatch(/\.mf-cap \{[^}]*z-index: 2;[^}]*pointer-events: none;/);
    expect(css).toMatch(/\.mf-ai \{[^}]*z-index: 3;[^}]*pointer-events: none;/);
    expect(css).toMatch(/\.mf-card::after \{[^}]*z-index: 4;[^}]*pointer-events: none;/);
    expect(css).toContain(".mf-card:has(.mf-card-link:focus-visible)::after { box-shadow: inset 0 0 0 3px #ffa940; }");
  });

  it("on a phone shows the title alone (three hyphenated lines, clear of the mark's row), three 18 px lines to 1023 px, 22/16 px above", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 480px) {"));
    expect(phone).toMatch(/\.nx-gallery \.mf-title \{ font-size: 0\.9375rem; -webkit-line-clamp: 3; line-clamp: 3; hyphens: auto; \}/);
    expect(phone).toMatch(/\.nx-gallery \.mf-desc \{ display: none; \}/);
    expect(phone).toMatch(/\.mf-cap \{ max-height: calc\(100% - 34px\);/);
    expect(css).toContain("@media (min-width: 481px) and (max-width: 1023px) {\n  .nx-gallery .mf-title { font-size: 1.125rem; -webkit-line-clamp: 3; line-clamp: 3; }");
    expect(phone).toContain(".mf-ai { top: 6px; right: 6px; padding: 1px 6px; font-size: 12px; }");
    expect(css).not.toMatch(/@media \(max-width: (?:4(?:8[1-9]|9\d)|[5-9]\d\d)px\)/);
  });

  it("moves the caption only where motion is allowed, and only fades it under the page's pause switch", () => {
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}\n/g, "");
    expect(outside).not.toMatch(/translate|scale\(/);
    expect(css).toMatch(/html\[data-motion="paused"\] \.mf-cap \{ transform: none; transition: opacity/);
  });
});

/**
 * The cards' hand-written titles (lib/site/card-titles.ts). What would break: a card with no title showing half an English
 * prompt on the Russian page (Pixel, 22 Nov), a title too long for a phone card, or a title that names a model or a maker
 * (owner decision 22 Nov: no model name on public cards).
 */
describe("card titles", () => {
  const entries = (raw as { entries: { jobId: string; modelId: string; modelName: string }[] }).entries;

  it("every sample in the data file has a title in en, ru and uz, at most 32 characters, naming no model or maker", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      const t = CARD_TITLES[e.jobId];
      expect(t, `${e.jobId} has no title`).toBeTruthy();
      for (const l of ["en", "ru", "uz"] as const) {
        const title = t[l];
        expect(title.trim().length, `${e.jobId} ${l}`).toBeGreaterThan(2);
        expect(Array.from(title).length, `${e.jobId} ${l}: ${title}`).toBeLessThanOrEqual(CARD_TITLE_MAX);
        expect(title, `${e.jobId} ${l}`).not.toMatch(PROVIDER_BRANDS);
        for (const m of REGISTRY.models) {
          expect(title, `${e.jobId} ${l}`).not.toContain(m.display_name);
          expect(title.toLowerCase(), `${e.jobId} ${l}`).not.toContain(m.id);
        }
      }
      // Russian in Cyrillic; Uzbek in its Latin script with ʻ (U+02BB) and ʼ (U+02BC), never a typewriter or curly quote.
      expect(t.ru).toMatch(/[а-яё]/i);
      expect(t.uz).not.toMatch(/['‘’`]/);
      expect(t.uz).not.toMatch(/[а-яё]/i);
    }
    // No title for a sample that is not in the data file (a stale one would hide a missing one).
    expect(Object.keys(CARD_TITLES).sort()).toEqual(entries.map((e) => e.jobId).sort());
  });

  it.each(LOCALES.map((l) => l.code))("%s: each shipped card's caption is its title in the page's language over the prompt's first sentence marked English", (code) => {
    const { container } = render(<ShowcaseGallery t={dictionaries[code]} locale={code} />);
    for (const card of container.querySelectorAll<HTMLElement>("[data-showcase-entry]")) {
      const job = card.dataset.showcaseEntry!;
      const title = card.querySelector(".mf-cap .mf-title");
      // A format's own title wins where the sample shows one; every other card shows its hand-written title.
      if (!title?.hasAttribute("data-format")) expect(title?.textContent, job).toBe(cardTitle(job, code));
      const line = card.querySelector(".mf-cap .mf-desc")!;
      const e = SHOWCASE_ENTRIES.find((x) => x.jobId === job)!;
      if (e.cardLine) expect([line.textContent, line.getAttribute("lang")]).toEqual([e.cardLine[code], code]);
      else if (e.prompt.trim()) {
        expect(line.textContent).toBe(firstSentence(e.prompt));
        expect(line.getAttribute("lang")).toBe("en");
        expect(line.getAttribute("data-src")).toBe("prompt");
      }
    }
  });
});

describe("the Shorts feed is media first", () => {
  it("at rest shows the clip and the AI mark; a tap on the clip shows the title, the line and Use; the next tap hides them", async () => {
    const { ShortsFeed } = await import("@/components/site/ShortsFeed");
    const d = dictionaries.ru;
    const g = d.site.gallery;
    const tallJob = SHOWCASE_ENTRIES.find((e) => e.kind === "video")?.jobId ?? FIXTURE_ENTRY.jobId;
    const tall = { ...FIXTURE_ENTRY, jobId: tallJob, capability: "t2v", operatorPreview: false, modelId: "minimax-hailuo-2.3", width: 1280, height: 2240 };
    const items = shortsItems([{ e: tall, f: FIXTURE_FILES[FIXTURE_ENTRY.jobId] }], false, new Date("2026-11-22T00:00:00Z"), "ru");
    render(<ShortsFeed items={items} copy={d.site.autopilot.shorts} g={{ badge: g.badge, badgeName: g.badgeName, use: g.use, useNote: g.useNote, noPrompt: g.noPrompt }} />);
    fireEvent.click(document.querySelector(".nx-shorts-open")!);
    const slide = document.querySelector<HTMLElement>(".nx-shorts-slide")!;
    expect(aiMarkOf(slide.querySelector(".mf-ai"))).toEqual({ seen: g.badge, said: g.badgeName });
    expect(slide.hasAttribute("data-shown")).toBe(false);
    // The title in the page's language when the sample has one; the line is the card's, never the whole prompt.
    const title = cardTitle(tallJob, "ru");
    if (title) expect(slide.querySelector(".nx-shorts-title")?.textContent).toBe(title);
    expect(slide.querySelector(".nx-shorts-prompt")?.textContent).toBe(firstSentence(tall.prompt));
    // The link is in the page all along (a keyboard reaches it, and its :focus-visible shows the caption), always "Use".
    const link = slide.querySelector<HTMLAnchorElement>("a.nx-shorts-use")!;
    expect(link.textContent).toContain(g.use);
    expect(link.getAttribute("href")).toBe(tryHref(tall, false));
    fireEvent.click(slide.querySelector(".nx-shorts-media")!);
    expect(slide.getAttribute("data-shown")).toBe("true");
    // The first tap mounted the clip (nothing starts by itself here). It takes no focus: it is aria-hidden and has no controls,
    // and a focused clip kept the caption up through the second tap (Pixel, 22 Nov: :focus-within matched it).
    const video = slide.querySelector("video");
    expect(video).toBeTruthy();
    expect(video!.hasAttribute("tabindex")).toBe(false);
    fireEvent.click(slide.querySelector(".nx-shorts-media")!);
    expect(slide.hasAttribute("data-shown")).toBe(false);
    // Nothing else in the slide shows the caption: no element inside its caption has focus after the taps.
    expect(slide.querySelector(".nx-shorts-cap")!.contains(document.activeElement)).toBe(false);
  });

  it("hides the caption until shown, takes no taps on it but the link's, and only fades", () => {
    const css = readFileSync(join(ROOT, "components/site/autopilot-demo.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toContain(".nx-shorts-shade, .nx-shorts-cap { opacity: 0; }");
    expect(css).toContain(".nx-shorts-cap { pointer-events: none; }");
    // Shown by a tap (data-shown) or by the keyboard on the caption's link only; never by :focus-within on the whole slide, which a
    // focused clip matched, so the second tap could not hide the caption.
    expect(css).toContain('.nx-shorts-slide:is([data-shown="true"], :has(.nx-shorts-cap :focus-visible)) :is(.nx-shorts-shade, .nx-shorts-cap) { opacity: 1; }');
    expect(css).toContain('.nx-shorts-slide:is([data-shown="true"], :has(.nx-shorts-cap :focus-visible)) .nx-shorts-use { pointer-events: auto; }');
    expect(css).not.toMatch(/\.nx-shorts-slide[^{]*:focus-within/);
    const shorts = css.slice(css.indexOf(".nx-shorts {"));
    expect(shorts).not.toMatch(/\.nx-shorts-(?:cap|shade)[^{]*\{[^}]*(?:transform|translate)/);
  });

  it("keeps the feed's AI mark under its top bar, not on the Close key: the rule wins over .mf-ai's own, after the phone query", () => {
    const mc = readFileSync(join(ROOT, "components/site/media-card.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = ".nx-shorts .mf-ai.nx-shorts-ai { top: calc(64px + env(safe-area-inset-top)); right: 12px; }";
    expect(mc).toContain(rule);
    expect(mc.indexOf(rule)).toBeGreaterThan(mc.lastIndexOf("@media (max-width: 480px)"));
    // Not in autopilot-demo.css, whose @layer loses to the unlayered .mf-ai.
    expect(readFileSync(join(ROOT, "components/site/autopilot-demo.css"), "utf8")).not.toMatch(/\.nx-shorts-ai\s*\{/);
  });
});

/**
 * The clip's sound toggle (#937, components/site/SoundToggle.tsx) sits inside a gallery card's media, over the card's stretched
 * link (z-index 5 above 1) and marked data-tap-ignore. What would break: a finger on the speaker revealing the caption or opening
 * the Studio instead of turning the sound on.
 */
describe("a sound toggle inside a gallery card", () => {
  it("is not held by TapReveal, reveals nothing and never reaches the card's link; it turns the sound on", async () => {
    const { I18nContext } = await import("@/lib/i18n/public-context");
    const { SoundToggle } = await import("@/components/site/SoundToggle");
    const { registerSound, setSoundLive, resetSoundForTests } = await import("@/lib/site/sound");
    const { act } = await import("@testing-library/react");
    const onSale = { ...FIXTURE_ENTRY, operatorPreview: false, modelId: "minimax-hailuo-2.3", capability: "t2v" };
    const { container } = render(<ShowcaseGallery t={dictionaries.en} locale="en" entries={[onSale]} files={FIXTURE_FILES} />);
    const card = container.querySelector<HTMLElement>("[data-mf-card]")!;
    const link = card.querySelector<HTMLAnchorElement>("a.mf-card-link")!;
    const opened = vi.fn();
    link.addEventListener("click", opened);
    // Where LoopClip draws it: inside the card's media box, a sibling of the link, not inside it.
    const slot = document.createElement("div");
    card.querySelector(".nx-gallery-pic")!.appendChild(slot);
    const video = document.createElement("video");
    const ctx = { locale: "en", t: dictionaries.en, fmt: () => "", setLocale: () => undefined, full: false } as never;
    render(
      <I18nContext.Provider value={ctx}>
        <SoundToggle clip="card-sound" />
      </I18nContext.Provider>,
      { container: slot },
    );
    act(() => {
      registerSound("card-sound", video);
      setSoundLive(video, true);
    });
    const button = card.querySelector<HTMLButtonElement>("button.nx-clip-sound")!;
    expect(button).toBeTruthy();
    expect(button.hasAttribute("data-tap-ignore")).toBe(true);
    expect(link.contains(button)).toBe(false);
    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(down, "pointerType", { value: "touch" });
    act(() => {
      button.dispatchEvent(down);
      fireEvent.click(button, { detail: 1 });
    });
    expect(card.hasAttribute("data-revealed")).toBe(false);
    expect(opened).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(video.muted).toBe(false);
    // The stylesheet lays it above the card's link and focus ring.
    const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");
    expect(css).toMatch(/\.nx-clip-sound \{ position: absolute; z-index: 5;/);
    resetSoundForTests();
  });
});
