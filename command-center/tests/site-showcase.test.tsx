// @vitest-environment jsdom
/**
 * The public site's model samples (lib/site/showcase.ts, components/site/ShowcaseGallery.tsx, lib/site/showcase-link.ts).
 *
 * What would break if these failed: a sample naming a model the registry does not have, or without the maker's required credit;
 * a cost of 0 standing in for "unknown"; a card pointing at files that are not in the repository; a model name leaking out of its
 * own card onto the rest of the site; a placeholder gallery with nothing real in it; a "Try it" that sends a visitor off-site,
 * spends anything, or loses the words on the way through sign-up.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, fmt, LOCALES } from "@/lib/i18n";
import raw from "@/lib/site/showcase.json";
import { SHOWCASE_ENTRIES, modelLeftOut, parseShowcase, parseShowcaseEntry, showcaseModels } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { ShowcaseGallery, showcaseItems } from "@/components/site/ShowcaseGallery";
import { cutWords, signupTryHref, studioTryHref, tryHref } from "@/lib/site/showcase-link";
import { DEFAULT_AFTER_AUTH, STUDIO_NEXT_PREFIX, afterSignupPath, safeLoginReturn, safeNextPath, studioNext } from "@/lib/safe-redirect";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { prefillFromImprove, IMPROVE_PROMPT_MAX } from "@/lib/creative/improve";
import { prefillFromQuery } from "@/lib/creative/studio";
import { SLOTS } from "@/components/site/samples";
import { PROVIDER_BRANDS } from "./helpers/brands";
import { GALLERY, SAMPLE_CARD, without } from "./helpers/showcase-scope";
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

describe("the gallery", () => {
  it("renders nothing with no entry, or with entries whose files are missing (never a placeholder)", () => {
    expect(render(<ShowcaseGallery t={t} locale="en" entries={[]} />).container.innerHTML).toBe("");
    cleanup();
    expect(render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={{}} />).container.innerHTML).toBe("");
    expect(showcaseItems([], SHOWCASE_FILES)).toEqual([]);
    expect(showcaseItems(SHOWCASE_ENTRIES, {})).toEqual([]);
  });

  it.each(LOCALES.map((l) => l.code))("%s: one entry shows the badge, the model and its credit link, the prompt, the date and Try this prompt", (code) => {
    const d = dictionaries[code];
    const { container } = render(<ShowcaseGallery t={d} locale={code} entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />);
    const card = container.querySelector(`[data-showcase-entry="${FIXTURE_JOB}"]`) as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.querySelector(".nx-result-badge")?.textContent).toBe(d.site.gallery.badge);
    expect(card.textContent).toContain("Runway Gen-4.5");
    const credit = within(card).getByRole("link", { name: "Powered by Runway" });
    expect(credit.getAttribute("href")).toBe("https://runway.com");
    expect(credit.getAttribute("target")).toBe("_blank");
    expect(credit.getAttribute("rel")).toBe("noopener noreferrer");
    expect(card.textContent).toContain(FIXTURE_ENTRY.prompt);
    expect(card.querySelector("time")?.getAttribute("dateTime")).toBe(FIXTURE_ENTRY.createdAt);
    expect(card.querySelector("img")?.getAttribute("alt")).toContain("Runway Gen-4.5");
    // An operator preview: the card says, as a fact, that the model is not in the Studio, and the button neither names it in its
    // link nor in its accessible name; it is its visible words, described by the sample's prompt.
    const tryIt = within(card).getByRole("link", { name: d.site.gallery.try });
    expect(tryIt.getAttribute("href")).toBe(signupTryHref(FIXTURE_ENTRY));
    expect(tryIt.textContent).toBe(d.site.gallery.try);
    expect(tryIt.hasAttribute("aria-label")).toBe(false);
    expect(document.getElementById(tryIt.getAttribute("aria-describedby")!)?.textContent).toBe(FIXTURE_ENTRY.prompt);
    expect(card.querySelector(".nx-gallery-unavailable")?.textContent).toBe(d.site.gallery.notInStudio);
    expect(tryIt.getAttribute("href")).not.toContain("model");
    // The heading and the note say what the section is, in this language.
    expect(container.querySelector("h2")?.textContent).toBe(d.site.gallery.title);
    expect(container.textContent).toContain(d.site.gallery.tryNoteSignedOut);
  });

  it("signed in, Try it is the Studio form itself", () => {
    const { container } = render(<ShowcaseGallery t={t} locale="en" signedIn entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />);
    const href = container.querySelector(".nx-gallery-try")?.getAttribute("href");
    expect(href).toBe(studioTryHref(FIXTURE_ENTRY));
    expect(container.textContent).toContain(t.site.gallery.tryNote);
  });

  it("a model customers can use: no not-available line, and the button names the model in its link and its accessible name", () => {
    const onSale = { ...FIXTURE_ENTRY, modelId: "minimax-hailuo-2.3", modelName: "MiniMax Hailuo 2.3", provider: "minimax", operatorPreview: false, attribution: null };
    const { container } = render(<ShowcaseGallery t={t} locale="en" signedIn entries={[onSale]} files={FIXTURE_FILES} />);
    expect(container.querySelector(".nx-gallery-unavailable")).toBeNull();
    const btn = container.querySelector(".nx-gallery-try")!;
    expect(new URL(btn.getAttribute("href")!, "https://x.test").searchParams.get("model")).toBe("minimax-hailuo-2.3");
    expect(btn.getAttribute("aria-label")).toBe("Try this prompt: MiniMax Hailuo 2.3");
  });

  it("from the vendor's announced shutdown day, the card says the model is no longer in the Studio and stops naming it", () => {
    const ending = { ...FIXTURE_ENTRY, modelId: "openai-gpt-image-2", modelName: "OpenAI GPT Image 2", provider: "openai", operatorPreview: false, attribution: null, capability: "t2i", shutdownOn: "2027-02-10" };
    const before = render(<ShowcaseGallery t={t} locale="en" signedIn entries={[ending]} files={FIXTURE_FILES} now={new Date("2027-02-09T23:59:00Z")} />).container;
    expect(before.querySelector(".nx-gallery-unavailable")).toBeNull();
    expect(new URL(before.querySelector(".nx-gallery-try")!.getAttribute("href")!, "https://x.test").searchParams.get("model")).toBe("openai-gpt-image-2");
    cleanup();
    const after = render(<ShowcaseGallery t={t} locale="en" signedIn entries={[ending]} files={FIXTURE_FILES} now={new Date("2027-02-10T00:00:00Z")} />).container;
    expect(after.querySelector(".nx-gallery-unavailable")?.textContent).toBe(t.site.gallery.gone);
    const btn = after.querySelector(".nx-gallery-try")!;
    expect(new URL(btn.getAttribute("href")!, "https://x.test").searchParams.has("model")).toBe(false);
    expect(btn.hasAttribute("aria-label")).toBe(false);
    expect(modelLeftOut(ending, new Date("2027-02-10T00:00:00Z"))).toBe("shut_down");
    expect(modelLeftOut({ operatorPreview: true, shutdownOn: null })).toBe("preview");
    expect(modelLeftOut({ operatorPreview: false, shutdownOn: null })).toBeNull();
  });

  it("a picture has no clip and no pause button; a sample without words says so instead of showing an empty quote", () => {
    const pic = { ...FIXTURE_ENTRY, kind: "image" as const, capability: "t2i", modelId: "flux-2-pro", modelName: "FLUX.2 Pro", provider: "bfl", attribution: null, prompt: "" };
    const files = { [FIXTURE_JOB]: { ...FIXTURE_FILES[FIXTURE_JOB], clip: null } };
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[pic]} files={files} />);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector(".nx-clip-pause")).toBeNull();
    expect(container.querySelector(".nx-gallery-pic")?.hasAttribute("data-clip")).toBe(false);
    expect(container.querySelector(".nx-gallery-attr")).toBeNull();
    expect(container.querySelector(".nx-gallery-prompt")?.textContent).toBe(t.site.gallery.noPrompt);
  });

  it.each(LOCALES.map((l) => l.code))("%s: a clip animated from another sample's picture shows that picture, its model and its maker's credit; any other input shows none", (code) => {
    const d = dictionaries[code];
    const stillJob = "0d0d0d0d-1111-4222-8333-444455556666";
    const still = { ...FIXTURE_ENTRY, jobId: stillJob, kind: "image" as const, capability: "t2i", modelId: "ideogram-3", modelName: "Ideogram 3", provider: "ideogram", attribution: { text: "Powered by Ideogram", url: "https://ideogram.ai" }, input: { kind: "none" as const }, width: 1280, height: 718 };
    const alive = { ...FIXTURE_ENTRY, input: { kind: "operator_job" as const, jobId: stillJob, assetId: "0e0e0e0e-1111-4222-8333-444455556666" } };
    const files = { ...FIXTURE_FILES, [stillJob]: { poster: "/still.webp", posterSm: "/still-sm.webp", clip: null } };
    const { container } = render(<ShowcaseGallery t={d} locale={code} entries={[alive, still]} files={files} />);
    const card = container.querySelector(`[data-showcase-entry="${FIXTURE_JOB}"]`) as HTMLElement;
    const fig = card.querySelector(".nx-gallery-source") as HTMLElement;
    expect(fig.dataset.sourceEntry).toBe(stillJob);
    const img = fig.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/still-sm.webp");
    expect(img.getAttribute("alt")).toBe(fmt(d.site.gallery.altSource, { model: "Ideogram 3" }));
    expect(fig.textContent).toContain(d.site.gallery.source);
    expect(within(fig).getByRole("link", { name: "Powered by Ideogram" }).getAttribute("href")).toBe("https://ideogram.ai");
    // The clip's own credit is still the clip's maker's.
    expect(within(card).getByRole("link", { name: "Powered by Runway" })).toBeTruthy();
    // The picture's own card shows no source, and neither does an animation of site art or of a job that is not a sample here.
    expect(container.querySelector(`[data-showcase-entry="${stillJob}"] .nx-gallery-source`)).toBeNull();
    cleanup();
    expect(render(<ShowcaseGallery t={d} locale={code} entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />).container.querySelector(".nx-gallery-source")).toBeNull();
    cleanup();
    expect(render(<ShowcaseGallery t={d} locale={code} entries={[alive]} files={FIXTURE_FILES} />).container.querySelector(".nx-gallery-source")).toBeNull();
  });

  it("is the only place a model is named: outside the entry cards the section names no provider, and each card's model is a registry model with a job id", () => {
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />);
    const cards = [...container.querySelectorAll<HTMLElement>("[data-showcase-entry]")];
    expect(cards).toHaveLength(1);
    for (const c of cards) {
      expect(c.dataset.showcaseEntry).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(MODELS.has(c.dataset.model ?? "")).toBe(true);
    }
    const outside = container.cloneNode(true) as HTMLElement;
    outside.querySelectorAll("[data-showcase-entry]").forEach((n) => n.remove());
    expect(outside.textContent).not.toMatch(PROVIDER_BRANDS);
    expect(outside.innerHTML).not.toMatch(PROVIDER_BRANDS);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the gallery's and the credits' own words name no model or maker, and say AI-generated", (code) => {
    const s = dictionaries[code].site;
    expect(JSON.stringify(s.gallery)).not.toMatch(PROVIDER_BRANDS);
    expect(s.credits.generated).not.toMatch(PROVIDER_BRANDS);
    const AI = /AI-generated|нейросет|sunʼiy intellekt/i;
    expect(s.gallery.badge).toMatch(AI);
    expect(s.credits.generated).toMatch(AI);
    expect(s.gallery.altClip).toContain("{model}");
    expect(s.gallery.tryAria.startsWith(s.gallery.try)).toBe(true);
    expect(s.gallery.notInStudio + s.gallery.gone).not.toMatch(PROVIDER_BRANDS);
    // Statements of fact, not promises (CLAUDE.md #5): nothing about when or whether it will come.
    expect(s.gallery.notInStudio + s.gallery.gone).not.toMatch(/coming|soon|скоро|появится|tez orada|paydo/i);
    // The heading claims nothing about which models are on sale.
    expect(s.gallery.title).toContain("Nightshift");
  });

  it("the stylesheet lays the cards out in one column on a phone and gives the credit link a touch-sized target", () => {
    const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");
    expect(css).toMatch(/\.nx-gallery \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(min-width: 860px\) \{ \.nx-gallery \{ grid-template-columns: repeat\(2/);
    expect(css).toMatch(/\.nx-gallery-attr \{[^}]*min-height: 44px/);
  });
});

/**
 * The gallery over the real data file, not the fixture: the page-wide tests (public-pages, site-engage, site-engage-5) read the
 * page with the gallery or its cards taken out, so this is where what the cards themselves say is held, for whatever the owner
 * has merged. With nothing merged it renders nothing.
 */
describe("the shipped samples", () => {
  it.each(LOCALES.map((l) => l.code))("%s: a card names a model only as its registry name, credit, picture description and button; is labelled AI-generated; and claims no stock", (code) => {
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
    // The section's own words (heading, lead, notes) name no model; only the cards do.
    expect(without(section, SAMPLE_CARD).innerHTML).not.toMatch(PROVIDER_BRANDS);
    const cards = [...section.querySelectorAll<HTMLElement>(SAMPLE_CARD)];
    expect(cards.map((c) => c.dataset.showcaseEntry)).toEqual(items.map(({ e }) => e.jobId));
    for (const card of cards) {
      const { e, f } = items.find(({ e }) => e.jobId === card.dataset.showcaseEntry)!;
      const m = MODELS.get(e.modelId);
      if (!m) throw new Error(`${e.jobId}: ${e.modelId} is not in schemas/model_registry.json`);
      expect(card.dataset.model).toBe(m.id);
      const clip = e.kind === "video" && f.clip !== null;

      // Labelled as an AI generation, on the picture, clip or not; and nothing on it says stock or names a photographer.
      expect(card.querySelector(".nx-result-badge")?.textContent, e.jobId).toBe(g.badge);
      expect(card.querySelector(".nx-gallery-pic")?.getAttribute("data-clip") ?? null).toBe(clip ? "sample" : null);
      expect(card.querySelector("[data-sample], [data-art-id], [data-kind], .nx-result-credit, .nx-show-note")).toBeNull();
      const s = d.site.samples;
      for (const stock of [s.tag, s.frameTag, s.clipTag, s.note]) expect(card.textContent).not.toContain(stock);
      expect(card.innerHTML).not.toMatch(/pexels/i);

      // Every place the card may name its model, each exactly as the registry has it; with those taken out, nothing names one
      // (the prompt included: the words a job was given are shown, and they must not name a model or maker either).
      const rest = card.cloneNode(true) as HTMLElement;
      rest.removeAttribute("data-model");
      // A clip animated from another sample's picture shows that picture: named, credited and described exactly as that picture's
      // own card is, and only when the input really is that sample's job.
      const fig = rest.querySelector<HTMLElement>(".nx-gallery-source");
      const src = e.kind === "video" && e.input.kind === "operator_job" ? items.find((it) => it.e.jobId === (e.input as { jobId: string }).jobId) : undefined;
      expect(fig?.dataset.sourceEntry ?? null, e.jobId).toBe(src?.e.jobId ?? null);
      if (fig && src) {
        const sm = MODELS.get(src.e.modelId)!;
        expect(fig.querySelector("strong")?.textContent).toBe(sm.display_name);
        // (Under vitest an imported file has no .src, so both sides are empty there; next build fills them.)
        expect(fig.querySelector("img")?.getAttribute("src") ?? null).toBe(src.f.posterSm ?? null);
        expect(fig.querySelector("img")?.getAttribute("alt")).toBe(fmt(g.altSource, { model: sm.display_name }));
        const sc = fig.querySelector(".nx-gallery-attr");
        expect(sc?.textContent ?? null).toBe(sm.attribution?.text ?? null);
        expect(sc?.getAttribute("href") ?? null).toBe(sm.attribution?.url ?? null);
        fig.remove();
      }
      const name = rest.querySelector(".nx-gallery-model strong")!;
      expect(name.textContent).toBe(m.display_name);
      name.remove();
      const credit = rest.querySelector(".nx-gallery-attr");
      if (m.attribution) {
        expect(credit?.textContent).toBe(m.attribution.text);
        expect(credit?.getAttribute("href")).toBe(m.attribution.url);
        credit!.remove();
      } else expect(credit).toBeNull();
      const img = rest.querySelector("img")!;
      expect(img.getAttribute("alt")).toBe(fmt(clip ? g.altClip : g.altImage, { model: m.display_name }));
      img.removeAttribute("alt");
      const tryIt = rest.querySelector(".nx-gallery-try");
      expect(tryIt?.getAttribute("href") ?? null).toBe(tryHref(e, false));
      if (tryIt) {
        const label = tryIt.getAttribute("aria-label");
        expect(label).toBe(modelLeftOut(e) ? null : fmt(g.tryAria, { model: m.display_name }));
        tryIt.removeAttribute("aria-label");
        tryIt.removeAttribute("href");
      }
      expect(rest.textContent, e.jobId).not.toMatch(PROVIDER_BRANDS);
      expect(rest.innerHTML, e.jobId).not.toMatch(PROVIDER_BRANDS);
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
