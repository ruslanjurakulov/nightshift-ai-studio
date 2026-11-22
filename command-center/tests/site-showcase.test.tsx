// @vitest-environment jsdom
/**
 * The public site's model samples (lib/site/showcase.ts, components/site/ShowcaseGallery.tsx, lib/site/showcase-link.ts).
 *
 * What would break if these failed: a sample naming a model the registry does not have, a public card that names a model at all
 * (owner decision 22 Nov: no model name on public cards; it travels only in the Studio link), or one that links a model's
 * maker or says "Powered by" (the owner decided the public site shows the AI-generated label and the model name only, 2026-11-13;
 * the maker's required credit is shown in the Studio, where the models are used, tests/model-attribution.test.tsx);
 * a cost of 0 standing in for "unknown"; a card pointing at files that are not in the repository; a model name leaking out of its
 * own card onto the rest of the site; a placeholder gallery with nothing real in it; a "Try it" that sends a visitor off-site,
 * spends anything, or loses the words on the way through sign-up.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, LOCALES } from "@/lib/i18n";
import raw from "@/lib/site/showcase.json";
import { SHOWCASE_ENTRIES, parseShowcase, parseShowcaseEntry, showcaseModels } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { GRID_GUTTER_ROWS, ShowcaseGallery, gridSpan, showcaseItems } from "@/components/site/ShowcaseGallery";
import { level, levelOrder } from "@/lib/site/gallery-plan";
import { cutWords, signupTryHref, studioTryHref, tryHref } from "@/lib/site/showcase-link";
import { DEFAULT_AFTER_AUTH, STUDIO_NEXT_PREFIX, afterSignupPath, safeLoginReturn, safeNextPath, studioNext } from "@/lib/safe-redirect";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { prefillFromImprove, IMPROVE_PROMPT_MAX } from "@/lib/creative/improve";
import { prefillFromQuery } from "@/lib/creative/studio";
import { SLOTS } from "@/components/site/samples";
import { PROVIDER_BRANDS } from "./helpers/brands";
import { GALLERY, SAMPLE_CARD, makerCreditProblems, without } from "./helpers/showcase-scope";
import { FIXTURE_ENTRY, FIXTURE_FILES, FIXTURE_JOB } from "./fixtures/showcase-entry";

afterEach(cleanup);

const ROOT = join(__dirname, "..");
const REGISTRY = JSON.parse(readFileSync(join(ROOT, "..", "schemas", "model_registry.json"), "utf8")) as {
  models: { id: string; display_name: string; provider: string; capabilities: string[]; attribution: { text: string; url: string } | null; operator_preview?: boolean; terms_gate?: string | null; shutdown?: { on: string } }[];
};
const MODELS = new Map(REGISTRY.models.map((m) => [m.id, m]));
const t = dictionaries.en;

describe("the data file", () => {
  // It shipped empty, and the first export (#720) made a test that said so fail: what holds for any number of entries is that
  // the page shows every one of them, each as what it is.
  it("shows every shipped entry, and a video's plays its own clip while a picture's has none, never from off-site", () => {
    expect(showcaseItems().map(({ e }) => e.jobId)).toEqual(SHOWCASE_ENTRIES.map((e) => e.jobId));
    for (const e of SHOWCASE_ENTRIES) {
      const clip = SHOWCASE_FILES[e.jobId].clip;
      expect(clip === null, e.jobId).toBe(e.kind === "image");
      for (const src of Object.values(clip ?? {})) expect(src, e.jobId).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i);
    }
  });

  it("drops no entry it holds: every entry parses (a malformed one would vanish from the site unseen)", () => {
    expect(SHOWCASE_ENTRIES.length).toBe((raw as { entries: unknown[] }).entries.length);
  });

  it("every entry is a registry model's generation, with the registry's name, maker and credit, a job id, a cost that is a number or unknown, and its files", () => {
    for (const e of [...SHOWCASE_ENTRIES, FIXTURE_ENTRY]) {
      const m = MODELS.get(e.modelId);
      expect(m, e.modelId).toBeTruthy();
      expect(e.modelName).toBe(m!.display_name);
      expect(e.provider).toBe(m!.provider);
      expect(m!.capabilities).toContain(e.capability);
      expect(e.attribution).toEqual(m!.attribution ?? null);
      // Stale when the registry flips: a model that goes on sale must get its link back (and one taken off sale lose it).
      expect(e.operatorPreview, e.modelId).toBe(m!.operator_preview === true);
      // The export refuses a model whose vendor terms are not cleared for public display.
      expect(m!.terms_gate ?? null, e.modelId).toBeNull();
      // The shutdown date is the registry's, and no sample on the site is of a model already shut down: retire the sample, or the
      // card would advertise a model nobody can use (it already stops naming it in its link from that day).
      expect(e.shutdownOn, e.modelId).toBe(m!.shutdown?.on ?? null);
      if (e !== FIXTURE_ENTRY && e.shutdownOn) expect(e.shutdownOn > new Date().toISOString().slice(0, 10), `${e.modelId} is past its shutdown`).toBe(true);
      expect(e.jobId).toMatch(/^[0-9a-f-]{36}$/);
      expect(e.cost.usdEstimate === null || (typeof e.cost.usdEstimate === "number" && e.cost.usdEstimate >= 0)).toBe(true);
      if (e.cost.rows === 0) expect(e.cost.usdEstimate).toBeNull();
      if (e.slot !== null) expect(Object.keys(SLOTS)).toContain(e.slot);
      expect(e.input.kind).not.toBe("upload");
    }
    for (const e of SHOWCASE_ENTRIES) {
      expect(SHOWCASE_FILES[e.jobId], e.jobId).toBeTruthy();
      const dir = join(ROOT, "components/site/showcase", e.jobId);
      const names = e.kind === "video" ? ["clip.mp4", "clip.webm", "clip-sm.mp4", "clip-sm.webm", "poster.webp", "poster-sm.webp"] : ["poster.webp", "poster-sm.webp"];
      for (const n of names) expect(existsSync(join(dir, n)), `${e.jobId}/${n}`).toBe(true);
    }
    // And no files for an entry that is not there.
    expect(Object.keys(SHOWCASE_FILES).sort()).toEqual(SHOWCASE_ENTRIES.map((e) => e.jobId).sort());
  });

  it("the fixture is a well-formed entry, and the shapes that would lie are refused", () => {
    expect(parseShowcaseEntry(FIXTURE_ENTRY)).toEqual(FIXTURE_ENTRY);
    const bad: Record<string, unknown>[] = [
      { ...FIXTURE_ENTRY, jobId: "not-a-uuid" },
      { ...FIXTURE_ENTRY, modelId: "Runway Gen 4.5" },
      // "unknown" written as 0: no row recorded, yet a figure
      { ...FIXTURE_ENTRY, cost: { usdEstimate: 0, priceSource: "guess", rows: 0, vendor: [] } },
      // a figure without where its price came from
      { ...FIXTURE_ENTRY, cost: { usdEstimate: 0.5, priceSource: null, rows: 1, vendor: [] } },
      { ...FIXTURE_ENTRY, cost: { usdEstimate: -1, priceSource: "x", rows: 1, vendor: [] } },
      { ...FIXTURE_ENTRY, attribution: { text: "Powered by Runway", url: "http://runway.com" } },
      { ...FIXTURE_ENTRY, attribution: { text: "Powered by Runway", url: "javascript:alert(1)" } },
      { ...FIXTURE_ENTRY, input: { kind: "upload" } },
      { ...FIXTURE_ENTRY, kind: "audio" },
      { ...FIXTURE_ENTRY, createdAt: "yesterday" },
      { ...FIXTURE_ENTRY, operatorPreview: undefined },
      { ...FIXTURE_ENTRY, shutdownOn: undefined },
      { ...FIXTURE_ENTRY, shutdownOn: "soon" },
      // Over the limit as the page counts it (UTF-16 units): 2001 emoji are 4002 units.
      { ...FIXTURE_ENTRY, prompt: "🏮".repeat(2001) },
    ];
    for (const b of bad) expect(parseShowcaseEntry(b), JSON.stringify(b).slice(0, 120)).toBeNull();
    // A job is shown once, newest first.
    const older = { ...FIXTURE_ENTRY, jobId: "0a0a0a0a-1111-4222-8333-444455556666", createdAt: "2026-10-01T00:00:00Z" };
    expect(parseShowcase({ entries: [older, FIXTURE_ENTRY, FIXTURE_ENTRY] }).map((e) => e.jobId)).toEqual([FIXTURE_JOB, older.jobId]);
    expect(showcaseModels([FIXTURE_ENTRY, FIXTURE_ENTRY])).toHaveLength(1);
  });
});

/**
 * Everything on a card that is not its Studio link and could carry a word: text, and every attribute but `href` (alt, title,
 * aria-*, data-*, class). Owner decision 22 Nov: no model name on public cards; it travels only in the Studio link (`model=`).
 */
function cardWordsExceptLinks(el: Element): string {
  const parts: string[] = [el.textContent ?? ""];
  for (const n of [el, ...el.querySelectorAll("*")]) for (const a of n.attributes) if (a.name !== "href") parts.push(`${a.name}=${a.value}`);
  return parts.join("\n");
}

/** What on `el` names the model `e` (its registry name or id) or any maker, outside the links' hrefs: [] when nothing does. */
function modelLeaks(el: Element, e: { modelId: string; modelName: string }): string[] {
  const words = cardWordsExceptLinks(el);
  const out: string[] = [];
  if (words.includes(e.modelName)) out.push(`names ${e.modelName}`);
  if (words.includes(e.modelId)) out.push(`carries ${e.modelId}`);
  const brand = words.match(PROVIDER_BRANDS);
  if (brand) out.push(`names ${brand[0]}`);
  return out;
}

const onSale = { ...FIXTURE_ENTRY, modelId: "minimax-hailuo-2.3", modelName: "MiniMax Hailuo 2.3", provider: "minimax", operatorPreview: false, attribution: null, capability: "t2v" };
const LINES = { en: "Lanterns over a dark lake.", ru: "Фонари над тёмным озером.", uz: "Qorongʻi koʻl ustida chiroqlar." };

describe("the gallery", () => {
  it("renders nothing with no entry, or with entries whose files are missing (never a placeholder)", () => {
    expect(render(<ShowcaseGallery t={t} locale="en" entries={[]} />).container.innerHTML).toBe("");
    cleanup();
    expect(render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={{}} />).container.innerHTML).toBe("");
    expect(showcaseItems([], SHOWCASE_FILES)).toEqual([]);
    expect(showcaseItems(SHOWCASE_ENTRIES, {})).toEqual([]);
  });

  it.each(LOCALES.map((l) => l.code))("%s: a card is one link to the Studio: its media, one AI mark, and a caption (title, line) for hover; no model anywhere but the link's model=", (code) => {
    const d = dictionaries[code];
    const g = d.site.gallery;
    const { container } = render(<ShowcaseGallery t={d} locale={code} entries={[onSale]} files={FIXTURE_FILES} />);
    const card = container.querySelector(`[data-showcase-entry="${FIXTURE_JOB}"]`) as HTMLElement;
    expect(card).toBeTruthy();
    // Owner decision 22 Nov: the card is one link, straight to the Studio; no dialog (the dialog named the model).
    const links = [...card.querySelectorAll("a[href]")];
    expect(links).toHaveLength(1);
    const link = links[0] as HTMLAnchorElement;
    expect(link.classList.contains("mf-card")).toBe(true);
    expect(link.hasAttribute("data-mf-card")).toBe(true);
    expect(link.getAttribute("href")).toBe(tryHref(onSale, false));
    expect(card.querySelector("button, [aria-haspopup]")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // At rest: the media, and the AI mark always present; the picture's description says what it is, never by whom.
    expect(link.querySelector(".nx-gallery-pic > img")?.getAttribute("alt")).toBe(g.bgClip);
    expect(link.querySelector(".mf-ai")?.textContent).toBe(g.badge);
    // The caption: no format here, so no title and the line may take two rows; the line is the prompt's first sentence (no cardLine).
    const cap = link.querySelector(".mf-cap") as HTMLElement;
    expect(cap.dataset.title).toBe("none");
    expect(cap.querySelector(".mf-title")).toBeNull();
    expect(cap.querySelector(".mf-desc")?.textContent).toBe(onSale.prompt);
    // Not a model, a maker, a date or a dialog's words on the card, in any attribute but the link's href.
    expect(modelLeaks(card, onSale)).toEqual([]);
    expect(card.hasAttribute("data-model")).toBe(false);
    for (const w of [g.notInStudio, g.gone, g.useNote, g.model]) expect(card.textContent).not.toContain(w);
    // The note on what the cards do is said once, under the grid.
    expect(container.textContent!.split(g.tryNoteSignedOut)).toHaveLength(2);
    expect(container.querySelector("h2")?.textContent).toBe(g.title);
    expect(makerCreditProblems(container)).toEqual([]);
  });

  it("signed out the card is sign-up with the Studio form as next (tool, model and words); signed in the form itself; the model travels only there", () => {
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[onSale]} files={FIXTURE_FILES} />);
    const href = container.querySelector(`${SAMPLE_CARD} a`)!.getAttribute("href")!;
    expect(href).toBe(tryHref(onSale, false));
    expect(href.startsWith("/signup?next=")).toBe(true);
    const next = new URL(href, "https://x.test").searchParams.get("next")!;
    const u = new URL(next, "https://x.test");
    expect(u.pathname).toBe("/all-channels/create");
    expect(u.searchParams.get("tool")).toBe("t2v");
    expect(u.searchParams.get("model")).toBe(onSale.modelId);
    expect(u.searchParams.get("prompt")).toBe(onSale.prompt);
    cleanup();
    const inside = render(<ShowcaseGallery t={t} locale="en" signedIn entries={[onSale]} files={FIXTURE_FILES} />).container;
    expect(inside.querySelector(`${SAMPLE_CARD} a`)!.getAttribute("href")).toBe(studioTryHref(onSale));
  });

  it("an operator-preview sample's link opens the tool with its words and no model=", () => {
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />);
    const href = container.querySelector(`${SAMPLE_CARD} a`)!.getAttribute("href")!;
    const next = new URL(new URL(href, "https://x.test").searchParams.get("next")!, "https://x.test");
    expect(next.searchParams.get("tool")).toBe("i2v");
    expect(next.searchParams.has("model")).toBe(false);
    expect(href).not.toContain(FIXTURE_ENTRY.modelId);
    expect(modelLeaks(container, FIXTURE_ENTRY)).toEqual([]);
  });

  it("from the vendor's announced shutdown day the link stops naming the model; before it, it does", () => {
    const ending = { ...onSale, modelId: "openai-gpt-image-2", modelName: "OpenAI GPT Image 2", provider: "openai", capability: "t2i", kind: "image" as const, shutdownOn: "2027-02-10" };
    const model = (now: Date) => {
      const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[ending]} files={FIXTURE_FILES} now={now} />);
      const href = container.querySelector(`${SAMPLE_CARD} a`)!.getAttribute("href")!;
      cleanup();
      return new URL(new URL(href, "https://x.test").searchParams.get("next")!, "https://x.test").searchParams.get("model");
    };
    expect(model(new Date("2027-02-09T12:00:00Z"))).toBe("openai-gpt-image-2");
    expect(model(new Date("2027-02-10T00:00:00Z"))).toBeNull();
  });

  it("a card whose tool has no Studio form is not a link, with the same media, mark and caption", () => {
    const sfx = { ...onSale, capability: "sfx" };
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[sfx]} files={FIXTURE_FILES} />);
    const card = container.querySelector(SAMPLE_CARD)!;
    expect(card.querySelector("a")).toBeNull();
    const box = card.querySelector("[data-mf-card]") as HTMLElement;
    expect(box.classList.contains("mf-card")).toBe(true);
    expect(box.querySelector(".mf-ai")?.textContent).toBe(t.site.gallery.badge);
    expect(box.querySelector(".mf-cap .mf-desc")?.textContent).toBe(sfx.prompt);
    // Reachable by the keyboard, so focus can show the caption the way hover does.
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(modelLeaks(card, sfx)).toEqual([]);
  });

  it.each(LOCALES.map((l) => l.code))("%s: a sample's card line is shown in the page's language, and then the prompt is not on the card at all (it is still whole in the link)", (code) => {
    const lined = { ...onSale, cardLine: LINES };
    const { container } = render(<ShowcaseGallery t={dictionaries[code]} locale={code} entries={[lined]} files={FIXTURE_FILES} />);
    const card = container.querySelector(SAMPLE_CARD)!;
    expect(card.querySelector(".mf-desc")?.textContent).toBe(LINES[code]);
    expect(cardWordsExceptLinks(card)).not.toContain(lined.prompt);
    const href = card.querySelector("a")!.getAttribute("href")!;
    const next = new URL(new URL(href, "https://x.test").searchParams.get("next")!, "https://x.test");
    expect(next.searchParams.get("prompt")).toBe(lined.prompt);
  });

  it("without a card line, the caption is the prompt's first sentence only (the sample's own words), and a sample without words says so", () => {
    const long = { ...onSale, prompt: "A neon tram glides through rain. Close-up on wet rails, 35mm, slow dolly, teal and orange grade." };
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[long]} files={FIXTURE_FILES} />);
    expect(container.querySelector(".mf-desc")?.textContent).toBe("A neon tram glides through rain.");
    cleanup();
    const pic = { ...FIXTURE_ENTRY, kind: "image" as const, capability: "t2i", modelId: "flux-2-pro", modelName: "FLUX.2 Pro", provider: "bfl", attribution: null, prompt: "" };
    const { container: c2 } = render(<ShowcaseGallery t={t} locale="en" entries={[pic]} files={{ [FIXTURE_JOB]: { ...FIXTURE_FILES[FIXTURE_JOB], clip: null } }} />);
    expect(c2.querySelector(".mf-desc")?.textContent).toBe(t.site.gallery.noPrompt);
    expect(c2.querySelector(".nx-gallery-pic > img")?.getAttribute("alt")).toBe(t.site.gallery.bgImage);
    expect(c2.querySelector("video, .nx-clip-pause")).toBeNull();
    expect(modelLeaks(c2, pic)).toEqual([]);
  });

  it("a format's sample has the format's name as the caption's title, over the picture, never as a block under the card", () => {
    const fmtCard = { id: "fruit", job: FIXTURE_JOB, title: "Fruit drama", body: "Talking food in a soap-opera scene.", entry: FIXTURE_ENTRY };
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} formats={[fmtCard]} />);
    const cap = container.querySelector(`${SAMPLE_CARD} .mf-cap`) as HTMLElement;
    const title = cap.querySelector(".mf-title") as HTMLElement;
    expect(title.textContent).toBe("Fruit drama");
    expect(title.dataset.format).toBe("fruit");
    expect(cap.dataset.title).toBeUndefined();
    expect(container.textContent).not.toContain(fmtCard.body);
  });

  it("no model is named anywhere in the section, and the touch helper is there once", () => {
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY, { ...onSale, jobId: "0e0e0e0e-1111-4222-8333-444455556666" }]} files={{ ...FIXTURE_FILES, "0e0e0e0e-1111-4222-8333-444455556666": FIXTURE_FILES[FIXTURE_JOB] }} />);
    const section = container.querySelector(GALLERY)!;
    expect(modelLeaks(section, FIXTURE_ENTRY)).toEqual([]);
    expect(modelLeaks(section, onSale)).toEqual([]);
    expect(section.querySelectorAll("[data-tap-reveal]")).toHaveLength(1);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the gallery's and the credits' own words name no model or maker, and say AI-generated", (code) => {
    const s = dictionaries[code].site;
    expect(JSON.stringify(s.gallery)).not.toMatch(PROVIDER_BRANDS);
    expect(s.credits.generated).not.toMatch(PROVIDER_BRANDS);
    const AI = /AI-generated|нейросет|sunʼiy intellekt/i;
    expect(s.gallery.badge).toMatch(AI);
    expect(s.credits.generated).toMatch(AI);
    expect(s.gallery.bgClip).toMatch(AI);
    expect(s.gallery.bgImage).toMatch(AI);
    // The words under the grid say what a card does, not which model it opens (the Studio says that, with the price).
    for (const w of [s.gallery.lead, s.gallery.tryNote, s.gallery.tryNoteSignedOut]) expect(w).not.toMatch(/\{model\}/);
    expect(s.gallery.notInStudio + s.gallery.gone + s.gallery.useNote).not.toMatch(/coming|soon|скоро|появится|tez orada|paydo/i);
    expect(s.gallery.use).not.toBe(s.gallery.try);
    expect(s.gallery.title).toContain("Nightshift");
  });

  it("the stylesheet lays the cards out media first: a two-column masonry on a phone (nothing scrolls sideways), three and four above it, row by row, tight gutters", () => {
    const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");
    expect(css).toMatch(/\.nx-gallery \{ --cols: 2; display: block; columns: var\(--cols\);/);
    expect(css).not.toMatch(/\.nx-gallery \{[^}]*overflow-x/);
    expect(css).toMatch(/\.nx-gallery-card \{ position: relative; break-inside: avoid; margin: 0 0 8px;/);
    expect(css).toMatch(/@media \(min-width: 760px\) \{\n  \.nx-gallery \{ --cols: 3; \}/);
    expect(css).toMatch(/@media \(min-width: 1240px\) \{ \.nx-gallery \{ --cols: 4; \} \}/);
    expect(css).toMatch(/\.nx-gallery-box \{[^}]*container-type: inline-size;/);
    const grid = css.slice(css.indexOf("@supports (width: 1cqw) {"), css.indexOf("}\n}", css.indexOf("@supports (width: 1cqw) {")));
    expect(grid).toMatch(/\.nx-gallery \{ --cw: calc\(100cqw \/ \(var\(--cols\) \+ 0\.04 \* \(var\(--cols\) - 1\)\)\); display: grid; grid-template-columns: repeat\(var\(--cols\), minmax\(0, 1fr\)\); grid-auto-rows: calc\(var\(--cw\) \/ 100\);/);
    expect(grid).toContain(".nx-gallery-card { grid-row-end: span var(--span, 60); margin: 0 0 calc(var(--cw) * 0.04); }");
    expect(grid).not.toMatch(/(?<![-\w])columns:|grid-auto-flow: column/);
    expect(css).not.toMatch(/\.nx-gallery-pic \{[^}]*aspect-ratio/);
    expect(css).not.toMatch(/\.nx-gallery-attr|\.nx-ai-attr|\.nx-gallery-body|\.nx-gallery-over|\.nx-gallery-open/);
    expect(existsSync(join(ROOT, "components/site/sample-detail.css"))).toBe(false);
  });

  it("each card spans its file's height in grid rows, so two files a few pixels apart line up, and the grid has one pause key, not one per card", () => {
    expect(gridSpan(1280, 720)).toBe(56 + GRID_GUTTER_ROWS);
    expect(gridSpan(1280, 718)).toBe(gridSpan(1280, 720));
    expect(gridSpan(1280, 2240)).toBe(175 + GRID_GUTTER_ROWS);
    const tallJob = "0f0f0f0f-1111-4222-8333-444455556666";
    const tall = { ...FIXTURE_ENTRY, jobId: tallJob, width: 1280, height: 2240 };
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY, tall]} files={{ ...FIXTURE_FILES, [tallJob]: FIXTURE_FILES[FIXTURE_JOB] }} />);
    const cards = [...container.querySelectorAll<HTMLElement>(SAMPLE_CARD)];
    expect(cards.map((c) => c.style.getPropertyValue("--span"))).toEqual([String(gridSpan(FIXTURE_ENTRY.width, FIXTURE_ENTRY.height)), String(gridSpan(1280, 2240))]);
    const pauses = [...container.querySelectorAll(".nx-clip-pause")];
    expect(pauses).toHaveLength(1);
    expect(pauses[0].closest(SAMPLE_CARD)).toBeNull();
    expect(pauses[0].parentElement?.className).toBe("nx-gallery-box");
    expect(pauses[0].textContent).toBe(t.site.fx.pause);
    expect(cards.map((c) => c.dataset.showcaseEntry)).toEqual([FIXTURE_JOB, tallJob]);
    const spans = cards.map((c) => Number(c.style.getPropertyValue("--span")));
    for (const cols of [3, 4]) {
      const cells = level(spans, cols).cells;
      cards.forEach((c, i) => {
        expect(c.style.getPropertyValue(`--c${cols}`)).toBe(String(cells[i].col));
        expect(c.style.getPropertyValue(`--r${cols}`)).toBe(String(cells[i].row));
        expect(c.style.getPropertyValue(`--s${cols}`)).toBe(String(cells[i].span));
      });
    }
    const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");
    expect(css).toContain("@media (min-width: 760px) { .nx-gallery-card { grid-column: var(--c3, auto); grid-row: var(--r3, auto) / span var(--s3, var(--span, 60)); } }");
    expect(css).toContain("@media (min-width: 1240px) { .nx-gallery-card { grid-column: var(--c4, auto); grid-row: var(--r4, auto) / span var(--s4, var(--span, 60)); } }");
    expect(css).toMatch(/\.nx-gallery-pic \.nx-art \{[^}]*object-fit: cover; object-position: center;/);
  });

  it("each card keeps its clip's own shape: a 9:16 sample stands tall, a 16:9 one lies wide, its box sized from the file before it loads", () => {
    const tall = { ...FIXTURE_ENTRY, width: 1280, height: 2276 };
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[tall]} files={FIXTURE_FILES} />);
    const card = container.querySelector(`#sample-${FIXTURE_JOB}`) as HTMLElement;
    expect(card.dataset.shape).toBe("tall");
    expect((card.querySelector(".nx-gallery-pic") as HTMLElement).style.aspectRatio).toBe("1280 / 2276");
    cleanup();
    const wide = render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />).container;
    expect((wide.querySelector(`#sample-${FIXTURE_JOB}`) as HTMLElement).dataset.shape).toBe("wide");
    cleanup();
    expect(render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} exclude={[FIXTURE_JOB]} />).container.innerHTML).toBe("");
  });
});

/**
 * The gallery over the real data file, not the fixture: the page-wide tests (public-pages, site-engage, site-engage-5) read the
 * page with the gallery or its cards taken out, so this is where what the cards themselves say is held, for whatever the owner
 * has merged. With nothing merged it renders nothing.
 */
describe("the shipped samples", () => {
  it.each(LOCALES.map((l) => l.code))("%s: every card is its media, the AI mark and a caption, links to tryHref, and names no model or maker outside the link's model= (owner decision 22 Nov)", (code) => {
    const d = dictionaries[code];
    const g = d.site.gallery;
    const { container } = render(<ShowcaseGallery t={d} locale={code} />);
    const items = showcaseItems();
    if (items.length === 0) {
      expect(container.innerHTML).toBe("");
      return;
    }
    const section = container.querySelector(GALLERY) as HTMLElement;
    expect(section).toBeTruthy();
    expect(without(section, SAMPLE_CARD).innerHTML).not.toMatch(PROVIDER_BRANDS);
    const cards = [...section.querySelectorAll<HTMLElement>(SAMPLE_CARD)];
    const planned = levelOrder(items.map(({ e }) => gridSpan(e.width, e.height))).map((i) => items[i].e.jobId);
    expect(cards.map((c) => c.dataset.showcaseEntry)).toEqual(planned);
    const s = d.site.samples;
    for (const card of cards) {
      const { e, f } = items.find(({ e }) => e.jobId === card.dataset.showcaseEntry)!;
      const m = MODELS.get(e.modelId);
      if (!m) throw new Error(`${e.jobId}: ${e.modelId} is not in schemas/model_registry.json`);
      const clip = e.kind === "video" && f.clip !== null;
      expect(card.querySelector(".mf-ai")?.textContent, e.jobId).toBe(g.badge);
      expect(card.querySelector(".mf-cap .mf-desc")?.textContent?.trim().length, e.jobId).toBeGreaterThan(0);
      expect(card.querySelector(".nx-gallery-pic")?.getAttribute("data-clip") ?? null).toBe(clip ? "sample" : null);
      expect(card.querySelector(".nx-gallery-pic > img")?.getAttribute("alt")).toBe(clip ? g.bgClip : g.bgImage);
      const link = card.querySelector("a[href]");
      expect(link?.getAttribute("href") ?? null, e.jobId).toBe(tryHref(e, false));
      if (link) expect(link.getAttribute("href")!.startsWith("/signup")).toBe(true);
      expect(modelLeaks(card, { modelId: m.id, modelName: m.display_name }), e.jobId).toEqual([]);
      expect(makerCreditProblems(card), e.jobId).toEqual([]);
      for (const stock of [s.tag, s.frameTag, s.clipTag, s.note]) expect(card.textContent).not.toContain(stock);
      expect(card.innerHTML).not.toMatch(/pexels/i);
    }
  });
});


describe("Try it", () => {
  const sample = { capability: "i2v", modelId: "runway-gen4.5", prompt: "Paper lanterns drift up over a dark lake" };

  it("signed in: the Studio form under the all-channels workspace, with the tool, the model and the words", () => {
    const href = studioTryHref(sample)!;
    const u = new URL(href, "https://x.test");
    expect(u.pathname).toBe("/all-channels/create");
    expect(u.searchParams.get("tool")).toBe("i2v");
    expect(u.searchParams.get("model")).toBe("runway-gen4.5");
    expect(u.searchParams.get("prompt")).toBe(sample.prompt);
    expect(tryHref(sample, true)).toBe(href);
  });

  it("signed out: sign-up, with the Studio form as a same-origin next that survives the callback and /welcome", () => {
    const href = signupTryHref(sample)!;
    expect(href.startsWith("/signup?next=")).toBe(true);
    const next = new URL(href, "https://x.test").searchParams.get("next")!;
    expect(safeNextPath(next)).toBe(next);
    expect(studioNext(next)).toBe(next);
    const after = afterSignupPath(next);
    expect(after).not.toBe(DEFAULT_AFTER_AUTH);
    // The callback keeps it whole, and /welcome reads the Studio form back out of it.
    expect(safeLoginReturn(after, "/x")).toBe(after);
    expect(studioNext(new URL(after, "https://x.test").searchParams.get("next"))).toBe(next);
  });

  it("long words are cut on a word so the form still fits through sign-up, in any script; never half a character", () => {
    for (const words of ["lantern ".repeat(200), "фонарь над тёмным озером ".repeat(40), "chiroq qorongʻi koʻl ustida ".repeat(40), "🏮 ".repeat(300)]) {
      const href = signupTryHref({ ...sample, prompt: words })!;
      const next = new URL(href, "https://x.test").searchParams.get("next")!;
      expect(afterSignupPath(next)).not.toBe(DEFAULT_AFTER_AUTH);
      const kept = new URL(next, "https://x.test").searchParams.get("prompt") ?? "";
      expect(kept.length).toBeGreaterThan(0);
      expect(words.startsWith(kept)).toBe(true);
      expect(/[\uD800-\uDBFF]$/.test(kept)).toBe(false);
    }
    expect(cutWords("one two three", 9)).toBe("one two");
    expect(cutWords("onetwothree", 5)).toBe("onetw");
  });

  it("signed in, the words are bounded as the Studio box takes them from a link, with control and bidi characters out", () => {
    const u = new URL(studioTryHref({ ...sample, prompt: "z".repeat(5000) })!, "https://x.test");
    expect(u.searchParams.get("prompt")).toHaveLength(IMPROVE_PROMPT_MAX);
    const v = new URL(studioTryHref({ ...sample, prompt: `move${String.fromCodePoint(0x202e)} the${String.fromCodePoint(0)} sky` })!, "https://x.test");
    expect(v.searchParams.get("prompt")).toBe("move the sky");
  });

  it("an operator-preview model is left out of the link, in and out of sign-up; the tool and the words stay", () => {
    const preview = { ...sample, operatorPreview: true };
    const u = new URL(studioTryHref(preview)!, "https://x.test");
    expect(u.searchParams.has("model")).toBe(false);
    expect(u.searchParams.get("tool")).toBe("i2v");
    expect(u.searchParams.get("prompt")).toBe(sample.prompt);
    const next = new URL(signupTryHref(preview)!, "https://x.test").searchParams.get("next")!;
    expect(new URL(next, "https://x.test").searchParams.has("model")).toBe(false);
    // ...and a model customers can use is named.
    expect(new URL(studioTryHref({ ...sample, operatorPreview: false })!, "https://x.test").searchParams.get("model")).toBe(sample.modelId);
  });

  it("invisible characters never travel in the words: zero-width, tags, soft hyphen, letter marks, variation-selector runs", () => {
    const c = (...cps: number[]) => String.fromCodePoint(...cps);
    const hidden =
      `lan${c(0x200b)}te${c(0xad)}rns${c(0xfeff)}${c(0x61c)}${c(0x180e)} ${c(0x2063)}ri${c(0xe0100)}se` +
      `${c(0xe0041, 0xe0042)}${c(0xfe00, 0xfe01, 0xfe0f)}`;
    expect(new URL(studioTryHref({ ...sample, prompt: hidden })!, "https://x.test").searchParams.get("prompt")).toBe("lanterns rise");
    expect(prefillFromImprove(prefillFromQuery("t2v", undefined), { prompt: hidden })!.prompt).toBe("lanterns rise");
    // One variation selector after a symbol is how an emoji is written, and it stays.
    const heart = `love ${c(0x2764, 0xfe0f)}`;
    expect(new URL(studioTryHref({ ...sample, prompt: heart })!, "https://x.test").searchParams.get("prompt")).toBe(heart);
  });

  it("a tool the Studio has no form for, or a malformed model id, gets no button", () => {
    expect(tryHref({ ...sample, capability: "sfx" }, true)).toBeNull();
    expect(tryHref({ ...sample, capability: "video_character_swap" }, false)).toBeNull();
    expect(tryHref({ ...sample, modelId: "../../evil" }, true)).toBeNull();
  });

  it("a tool that takes no words carries none", () => {
    const u = new URL(studioTryHref({ capability: "remove_bg", modelId: "some-model", prompt: "ignored" })!, "https://x.test");
    expect(u.searchParams.has("prompt")).toBe(false);
  });
});

describe("sign-up carries only a Studio form", () => {
  it("anything else is plain /welcome", () => {
    for (const bad of [null, "", "//evil.example/create", "https://evil.example/all-channels/create", "/auth/callback", "/pricing", "/a/b/create", "/all-channels/createx", "/\\evil.com/create", "/api/create", "/oauth/create", "/auth/create", "/admin/create", "/login/create", "/signup/create", "/welcome/create", "/chronos/create"]) {
      expect(afterSignupPath(bad), String(bad)).toBe(DEFAULT_AFTER_AUTH);
    }
    expect(afterSignupPath("/all-channels/create?tool=t2v")).toBe(`${DEFAULT_AFTER_AUTH}?next=${encodeURIComponent("/all-channels/create?tool=t2v")}`);
  });

  it("is pinned to the all-channels workspace, the only one the link builder emits", () => {
    expect(STUDIO_NEXT_PREFIX).toBe(`/${ALL_CHANNELS_SLUG}/create`);
    expect(studioTryHref({ capability: "t2v", modelId: "some-model", prompt: "x" })!.startsWith(`${STUDIO_NEXT_PREFIX}?`)).toBe(true);
  });

  it("a form too long to fit through the callback is dropped, not cut", () => {
    expect(afterSignupPath(`/all-channels/create?prompt=${"a".repeat(480)}`)).toBe(DEFAULT_AFTER_AUTH);
  });

  it("the sign-up page and the Google button both send a new account through /welcome with the form", () => {
    const page = readFileSync(join(ROOT, "app/signup/page.tsx"), "utf8");
    expect(page).toContain("afterSignupPath(new URLSearchParams(window.location.search).get(\"next\"))");
    expect(page).toContain("encodeURIComponent(after)");
    expect(page).toContain("router.push(after)");
    const google = readFileSync(join(ROOT, "components/auth/GoogleButton.tsx"), "utf8");
    expect(google).toContain('mode === "signup" && studioNext(asked) ? afterSignupPath(asked) : asked');
  });
});

describe("the Studio reads the words back from a link", () => {
  it("for the text tools too (t2v, t2i), cleaned and bounded; it only fills the form", () => {
    expect(prefillFromImprove(prefillFromQuery("t2v", undefined), { prompt: ` lanterns${String.fromCodePoint(0x202e)} rise ` })!.prompt).toBe("lanterns rise");
    expect(prefillFromImprove(prefillFromQuery("t2i", undefined), { prompt: "z".repeat(9000) })!.prompt).toHaveLength(IMPROVE_PROMPT_MAX);
    expect(prefillFromImprove(prefillFromQuery("i2v", undefined), { prompt: "drift" })!.prompt).toBe("drift");
  });

  it("not for a tool the link was never meant to fill (speech keeps its own way in)", () => {
    expect(prefillFromImprove(prefillFromQuery("tts", undefined), { prompt: "say this" })!.prompt).toBe("");
  });
});
