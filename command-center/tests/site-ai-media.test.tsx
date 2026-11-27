// @vitest-environment jsdom
/**
 * Round 10: our own generations in the site's picture slots, the AI-studio landing (the first screen edge to edge, the prompt
 * bar, the facts, the explore grid, the model tiles), and the stock credits that shrink as samples replace the stock pictures.
 *
 * The data file and its generated module hold two fixture samples here (one exported for the "hero" slot
 * through its `slot` field, one only for the gallery), so this is the site the day a slot's sample is merged.
 *
 * What would break if these failed: a slot showing an AI clip under a stock label (or stock footage under an AI one); a slot
 * left empty, or pointing at a file that is not here, before its sample is merged; a model named outside its sample's box; the
 * same clip twice on the landing; a prompt bar that does anything but open the Studio form, or loses the words through sign-up;
 * a count, a price or a "new" badge the page cannot back; a Pexels credit for a picture nobody can see any more, or none for one
 * still shown; a bot branch that deploys a preview.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({ noStock: false }));

vi.mock("@/lib/site/showcase.json", async () => {
  const { FIXTURE_ENTRY } = await import("./fixtures/showcase-entry");
  return {
    default: {
      entries: [
        { ...FIXTURE_ENTRY, slot: "hero" },
        { ...FIXTURE_ENTRY, jobId: "0d0d0d0d-1111-4222-8333-444455556666", modelId: "minimax-h3", modelName: "MiniMax H3", provider: "minimax", attribution: null, capability: "t2v", width: 1280, height: 2240, prompt: "A lemon whispers to an avocado in a fridge", createdAt: "2026-11-11T09:30:00Z" },
        // The landing's first screen (components/site/slots.ts HERO_JOB, written out: a hoisted factory cannot import it), a Runway
        // clip with a maker's credit in its entry, as the real one is.
        { ...FIXTURE_ENTRY, jobId: "4e85c7e4-fd1a-4771-97ee-66c1fb853367", capability: "t2v", prompt: "Orbit, then a night city, then a steaming street stall", createdAt: "2026-11-10T09:30:00Z" },
      ],
    },
  };
});
vi.mock("@/components/site/showcase-assets", async () => {
  const { FIXTURE_FILES, FIXTURE_JOB } = await import("./fixtures/showcase-entry");
  return { SHOWCASE_FILES: { ...FIXTURE_FILES, "0d0d0d0d-1111-4222-8333-444455556666": FIXTURE_FILES[FIXTURE_JOB], "4e85c7e4-fd1a-4771-97ee-66c1fb853367": FIXTURE_FILES[FIXTURE_JOB] } };
});
// The hero's line as it is before its id is set (`ai` null), so the fixture's `slot: "hero"` export fills it; every other slot names a
// real job that is not in this fixture data, so it shows its stock fallback here.
vi.mock("@/components/site/slots", async (orig) => {
  const m = await orig<typeof import("@/components/site/slots")>();
  const S = m.SLOTS as unknown as Record<string, { ai: string | null }>;
  S.hero = { ...S.hero, ai: null };
  return m;
});
vi.mock("@/components/site/stock-in-use", async (orig) => {
  const real = await orig<typeof import("@/components/site/stock-in-use")>();
  return { stockInUse: () => (state.noStock ? [] : real.stockInUse()) };
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

import { dictionaries, fmt, LOCALES } from "@/lib/i18n";
import { Landing } from "@/components/landing/Landing";
import { ChatCard, chatCopy } from "@/components/landing/HeroCard";
import { DOCK_AT, PromptBar, UNDOCK_AT } from "@/components/landing/PromptBar";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { LoopClip } from "@/components/site/LoopClip";
import { motionTap } from "@/lib/site/motion";
import { SLOTS, placeMedia, slotJobs, slotMedia, LANDING_SLOTS } from "@/components/site/samples";
import { HERO_JOB } from "@/components/site/slots";
import { stockInUse } from "@/components/site/stock-in-use";
import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";
import { FORMATS } from "@/lib/site/formats";
import { EXAMPLE_THUMB_JOB } from "@/components/site/samples";
import { PROMPT_MAX, PROMPT_TOOLS, TEXT_TOOL, linkWords, promptHref } from "@/lib/site/prompt-link";
import { IMPROVE_PROMPT_MAX, LINK_PROMPT_TOOLS } from "@/lib/creative/improve";
import { SIGNUP_PATH } from "@/lib/public-paths";
import { DEFAULT_AFTER_AUTH, afterSignupPath, studioNext } from "@/lib/safe-redirect";
import { MEDIA_IDS } from "@/lib/site/media";
import type { MoneyAnchor } from "@/lib/landing";
import { WELCOME_CREDITS } from "@/lib/pricing";
import { PROVIDER_BRANDS } from "./helpers/brands";
import { GALLERY, SAMPLE_CARD, makerCreditProblems, placeLabelProblems, without } from "./helpers/showcase-scope";
import { FIXTURE_ENTRY, FIXTURE_FILES, FIXTURE_JOB } from "./fixtures/showcase-entry";
import { aiMarkOf } from "./helpers/ai-mark";

const ROOT = join(__dirname, "..");
const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");
const NO_MONEY: MoneyAnchor = { pack: { kind: "none" }, api: null, site: null };
const OTHER = "0d0d0d0d-1111-4222-8333-444455556666";
const HERO = "4e85c7e4-fd1a-4771-97ee-66c1fb853367";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.noStock = false;
});

const landing = (code: "en" | "ru" | "uz" = "en") => render(<Landing t={dictionaries[code]} locale={code} pricing={{ kind: "announced" }} anchor={NO_MONEY} showcase={[]} />);

describe("a slot is one line: a sample when it is merged, the stock picture until then", () => {
  const def = { ai: FIXTURE_JOB, id: "cloud", clip: "cloud" } as const;

  it("shows the named sample once its entry and files are here, labelled by its model", () => {
    const m = placeMedia(def, null, [FIXTURE_ENTRY], FIXTURE_FILES);
    expect(m.kind).toBe("ai");
    if (m.kind === "ai") {
      expect(m.entry.jobId).toBe(FIXTURE_JOB);
      expect(m.moving).toBe(true);
    }
  });

  it("keeps the stock picture while the sample's entry or its files are missing: never an empty slot, never a missing file", () => {
    expect(placeMedia(def, null, [], FIXTURE_FILES)).toMatchObject({ kind: "stock", id: "cloud", clip: "cloud", footage: true });
    expect(placeMedia(def, null, [FIXTURE_ENTRY], {})).toMatchObject({ kind: "stock", id: "cloud" });
  });

  it("with `ai` null, takes the newest entry exported for the slot's name (tools/export_showcase.py --slot), else the stock picture", () => {
    const open = { ai: null, id: "moon" } as const;
    expect(placeMedia(open, "landing.final", [{ ...FIXTURE_ENTRY, slot: "landing.final" }], FIXTURE_FILES).kind).toBe("ai");
    expect(placeMedia(open, "landing.final", [{ ...FIXTURE_ENTRY, slot: "hero" }], FIXTURE_FILES)).toMatchObject({ kind: "stock", id: "moon", clip: null, footage: false });
    // A picture (not a clip) fills a slot as a still.
    const still = placeMedia(open, "landing.final", [{ ...FIXTURE_ENTRY, slot: "landing.final", kind: "image", capability: "t2i" }], { [FIXTURE_JOB]: { ...FIXTURE_FILES[FIXTURE_JOB], clip: null } });
    expect(still.kind === "ai" && still.moving).toBe(false);
  });

  it("every slot declares its `ai` line and a stock fallback the site has, and the exporter can still read the slot names", () => {
    for (const [name, s] of Object.entries(SLOTS)) {
      expect("ai" in s, name).toBe(true);
      expect(MEDIA_IDS, name).toContain(s.id);
      if (s.ai !== null) expect(s.ai, name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    // tools/export_showcase.py slot_names(): two-space keys, each opening a "{", between these two markers.
    const src = readFileSync(join(ROOT, "components/site/slots.ts"), "utf8");
    const block = src.slice(src.indexOf("export const SLOTS = {"), src.indexOf("} as const", src.indexOf("export const SLOTS = {")));
    const names = [...block.matchAll(/^\s{2}(?:"([^"]+)"|([A-Za-z0-9_]+)):\s*\{/gm)].map((m) => m[1] ?? m[2]);
    expect(names).toEqual(Object.keys(SLOTS));
  });
});

describe("the landing with our own clip on its first screen", () => {
  it("the fixture's first-screen entry is the landing's HERO_JOB", () => {
    expect(HERO_JOB).toBe(HERO);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the first screen plays our own Studio clip edge to edge, labelled AI-generated: no model name, no prompt button, no maker's credit, no stock word, no price", (code) => {
    const t = dictionaries[code];
    const h = t.landingHome.hero;
    const { container } = landing(code);
    const hero = container.querySelector("section.hm-hero") as HTMLElement;
    const media = hero.querySelector(".hm-hero-media") as HTMLElement;
    expect(media.dataset.showcaseEntry).toBe(HERO);
    expect(media.dataset.clip).toBe("sample");
    const img = media.querySelector("img")!;
    // A backdrop under the headline: decorative (the box is hidden from assistive tech), the page's one high-priority picture (never lazy).
    expect(img.getAttribute("alt")).toBe("");
    expect(media.getAttribute("aria-hidden")).toBe("true");
    expect(img.getAttribute("loading")).not.toBe("lazy");
    expect(img.getAttribute("fetchpriority")).toBe("high");
    expect(img.getAttribute("data-sample-job")).toBe(HERO);
    expect(img.hasAttribute("data-sample")).toBe(false);
    // Labelled for what it is, once, in the visitor's language. The eye sees just "AI" (the owner, 2026-11-22: no longer phrase on
    // the picture); a screen reader hears the whole of it, AI-generated and made in our Studio. No link in the label.
    const credit = hero.querySelector(".hm-hero-credit") as HTMLElement;
    expect(aiMarkOf(credit.querySelector(".hm-badge"))).toEqual({ seen: t.site.gallery.badge, said: h.aiCredit });
    expect(t.site.gallery.badge).toBe("AI");
    expect(h.aiCredit).toMatch(/AI-generated|нейросет|sunʼiy intellekt/i);
    expect(h.aiCredit).toContain("Nightshift Studio");
    // Nothing else is seen: the old "Made in Nightshift Studio" line is gone from view, not hidden by a style.
    const seen = [...credit.childNodes].map((n) => (n instanceof HTMLElement ? [...n.querySelectorAll('[aria-hidden="true"]')].map((x) => x.textContent).join("") : n.textContent ?? "")).join("").trim();
    expect(seen).toBe("AI");
    expect(credit.textContent).not.toContain(h.reelLabel);
    expect(credit.querySelectorAll("a")).toHaveLength(0);
    // The entry asks for "Powered by Runway"; the public site does not show it, nor the model, nor its prompt.
    expect(FIXTURE_ENTRY.attribution).not.toBeNull();
    expect(makerCreditProblems(hero)).toEqual([]);
    expect(hero.textContent).not.toContain(FIXTURE_ENTRY.modelName);
    expect(hero.textContent).not.toMatch(PROVIDER_BRANDS);
    // Not even in an attribute: the first screen names no model at all (a gallery card carries its model in data-model; this box does not).
    expect(hero.innerHTML).not.toMatch(PROVIDER_BRANDS);
    expect(hero.textContent).not.toContain("Orbit, then a night city");
    expect(hero.querySelector(".nx-ai-model, .nx-ai-try, .nx-gallery-try")).toBeNull();
    for (const w of [t.site.samples.tag, t.site.samples.frameTag, t.site.samples.clipTag, t.site.gallery.use, t.site.gallery.useNote]) expect(hero.textContent).not.toContain(w);
    expect(hero.innerHTML).not.toMatch(/pexels/i);
    expect(hero.textContent).not.toMatch(/[$€£₽]/);
    // The first screen's clip is not shown again anywhere on the page. The landing draws no other slot than its closing panel
    // (stock in this fixture), so the old hero slot's sample is free for the gallery, with the other one.
    expect(slotJobs(LANDING_SLOTS)).toEqual([]);
    expect(container.querySelectorAll(`[data-showcase-entry="${HERO}"]:not(#models *)`)).toHaveLength(1);
    expect(container.querySelector(`${GALLERY} [data-showcase-entry="${FIXTURE_JOB}"]`)).toBeTruthy();
    expect(container.querySelector(`${GALLERY} [data-showcase-entry="${OTHER}"]`)).toBeTruthy();
    // A model is named only inside a sample's own box.
    expect(without(container, SAMPLE_CARD).textContent).not.toMatch(PROVIDER_BRANDS);
    expect(without(container, SAMPLE_CARD).innerHTML).not.toMatch(PROVIDER_BRANDS);
  });

  it("puts the first screen's own still in the idea bar as a thumbnail: decorative, the same picture, not a second sample", () => {
    const { container } = landing();
    const still = container.querySelector(".hm-hero-still") as HTMLImageElement;
    const thumb = container.querySelector("section.hm-hero form .hm-idea-row > .hm-idea-thumb") as HTMLElement;
    expect(thumb.getAttribute("aria-hidden")).toBe("true");
    // The small rendition of the very still behind the words (the hero's `src`), as the reference's bar shows its own clip.
    expect(thumb.style.backgroundImage).toBe(`url("${still.getAttribute("src")}")`);
    // Not an <img> and no sample marks: the page's picture count and its no-clip-twice check still see the clip once.
    expect(thumb.tagName).toBe("SPAN");
    expect([...thumb.attributes].map((a) => a.name).sort()).toEqual(["aria-hidden", "class", "style"]);
    // The clip's copy is a canvas over the still (HeroThumb.tsx), not a picture element and not a second video.
    expect(thumb.querySelectorAll("img, video, picture, source")).toHaveLength(0);
    expect([...thumb.children].map((c) => `${c.tagName}.${c.className}`)).toEqual(["CANVAS.hm-idea-thumb-live"]);
    expect(container.querySelectorAll(`[data-showcase-entry="${HERO}"]:not(#models *)`)).toHaveLength(1);
  });

  it("copies the first screen's own clip into the thumbnail once it plays: the video in the hero's box, not another one", async () => {
    const drawImage = vi.fn();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({ drawImage })) as never);
    try {
      const { container } = landing();
      const media = container.querySelector("section.hm-hero .hm-hero-media") as HTMLElement;
      const thumb = container.querySelector("section.hm-hero .hm-idea-thumb") as HTMLElement;
      // The hero's clip as LoopClip leaves it once it plays (no clip mounts in this jsdom, so the test puts it there).
      const video = document.createElement("video");
      for (const [k, v] of Object.entries({ paused: false, readyState: 4, videoWidth: 1280, videoHeight: 720 })) Object.defineProperty(video, k, { value: v, configurable: true });
      await act(async () => {
        media.appendChild(video);
        media.setAttribute("data-live", "true");
        video.dispatchEvent(new Event("playing"));
        await Promise.resolve();
      });
      expect(drawImage).toHaveBeenCalled();
      for (const call of drawImage.mock.calls) expect(call[0]).toBe(video);
      expect(thumb.getAttribute("data-live")).toBe("true");
      expect(container.querySelectorAll("video")).toHaveLength(1);
    } finally {
      getContext.mockRestore();
    }
  });

  it("counts what the page holds: the samples on it and the models that made them, and the welcome grant", () => {
    const { container } = landing();
    const facts = Object.fromEntries([...container.querySelectorAll(".nx-facts-list li")].map((li) => [li.getAttribute("data-fact"), li.querySelector(".nx-facts-n")?.textContent]));
    // The first screen's clip, and the gallery's two.
    expect(facts).toEqual({ samples: "3", models: "2", credits: String(WELCOME_CREDITS) });
  });

  it("gives each model of a sample anywhere on the page one tile (as many as the facts count), inside its sample's box, with no maker's credit, the truth about the Studio and no price", () => {
    const t = dictionaries.en;
    const { container } = landing();
    const tiles = [...container.querySelectorAll<HTMLElement>("#models .nx-model")];
    // In the page's order: Runway (the gallery's first card, and the first screen's clip), then MiniMax. Two models, the number the
    // facts row says.
    expect(tiles.map((x) => x.dataset.model)).toEqual(["runway-gen4.5", "minimax-h3"]);
    expect(container.querySelector("[data-fact='models'] .nx-facts-n")?.textContent).toBe(String(tiles.length));
    // Each tile links to its sample on this page, once: a gallery card, or the box of a place that shows it.
    for (const tile of tiles) {
      const href = tile.querySelector(".nx-model-see")!.getAttribute("href")!;
      expect(href).toBe(`#sample-${tile.dataset.showcaseEntry}`);
      expect(container.querySelectorAll(href)).toHaveLength(1);
    }
    // The first screen's box is such a place: a model whose only sample here is that clip has its tile land on it.
    expect(container.querySelector(`#sample-${HERO}`)?.matches(".hm-hero-media")).toBe(true);
    const runway = tiles[0];
    expect(runway.querySelector(".nx-model-count")?.textContent).toBe(fmt(t.site.models.count, { n: "2" }));
    // Runway asks for "Powered by Runway"; the public site does not show it (it is shown in the Studio, where the model is used).
    expect(FIXTURE_ENTRY.attribution).not.toBeNull();
    expect(makerCreditProblems(runway)).toEqual([]);
    const tile = tiles[1];
    expect(tile.dataset.showcaseEntry).toBe(OTHER);
    expect(tile.querySelector(".nx-model-name")?.textContent).toBe("MiniMax H3");
    // The card quotes the words its sample was made from, under a "Prompt" caption, inside the sample's own box.
    expect(tile.querySelector(".nx-model-kicker")?.textContent).toBe(t.site.gallery.prompt);
    expect(tile.querySelector("q.nx-model-quote")?.textContent).toBe("A lemon whispers to an avocado in a fridge");
    expect(tile.querySelector(".nx-model-quote")?.closest(SAMPLE_CARD)?.getAttribute("data-showcase-entry")).toBe(OTHER);
    expect(tile.querySelector(".nx-gallery-unavailable")?.textContent).toBe(t.site.gallery.notInStudio);
    expect(tile.querySelector(`a[href="#sample-${OTHER}"]`)?.textContent).toBe(t.site.models.see);
    expect(tile.textContent).not.toMatch(/\$|€|credit|new\b/i);
  });

  // Owner decision 22 Nov: no model name on a gallery card; it travels only in the Studio link. Scoped to the gallery: the model
  // tiles and the ribbon (kept by the owner on 27 Nov) name theirs, each inside its sample's box.
  it("no gallery card names its model, in text or any attribute but its Studio link", () => {
    const { container } = landing();
    const gallery = container.querySelector(GALLERY)!;
    for (const card of gallery.querySelectorAll(SAMPLE_CARD)) {
      const words = [card.textContent ?? "", ...[...card.querySelectorAll("*"), card].flatMap((n) => [...n.attributes].filter((a) => a.name !== "href").map((a) => a.value))].join("\n");
      for (const name of ["Runway Gen-4.5", "runway-gen4.5", "MiniMax H3", "minimax-h3"]) expect(words).not.toContain(name);
    }
  });

  it("nothing in the grid or the tiles looks dead: each tile plays its sample's loop like the grid, and every poster drifts until its clip plays, stopped by the pause switch and absent under reduced motion", () => {
    const { container } = landing();
    for (const tile of container.querySelectorAll<HTMLElement>("#models .nx-model")) {
      expect(tile.querySelector(".nx-model-media")?.getAttribute("data-clip")).toBe("sample");
      expect(tile.querySelector("img")?.classList.contains("nx-drift-pic")).toBe(true);
    }
    for (const img of container.querySelectorAll(`${GALLERY} .nx-gallery-pic > img`)) expect(img.classList.contains("nx-drift-pic")).toBe(true);
    const src = readFileSync(join(ROOT, "components/landing/Landing.tsx"), "utf8");
    expect(src).toContain("<ShowcaseClip jobId={e.jobId} together />");
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\n  \.nx-drift-pic \{ animation: nx-poster-drift 16s ease-in-out infinite alternate;/);
    expect(css).toContain('html[data-motion="paused"] .nx-drift-pic { animation-play-state: paused !important; }');
    expect(css).toContain('[data-live="true"] > .nx-drift-pic { animation: none; }');
  });

  it("the explore grid is dark, keeps each clip's shape and plays the clips in view together on a wide screen", () => {
    const { container } = landing();
    const card = container.querySelector(`#sample-${OTHER}`) as HTMLElement;
    expect(card.dataset.shape).toBe("tall");
    expect((card.querySelector(".nx-gallery-pic") as HTMLElement).style.aspectRatio).toBe("1280 / 2240");
    expect(css).toMatch(/\.nx-section#samples \{ background: #0b0b10;/);
    const src = readFileSync(join(ROOT, "components/site/ShowcaseGallery.tsx"), "utf8");
    expect(src).toContain("<ShowcaseClip jobId={e.jobId} together />");
  });
});

describe("a chat card's frame: the slot's picture under a caller's own ask, the example topic's own clip under the default one", () => {
  it("labels a slot's frame as our sample with its badge only (no footnote under the card), and says nothing about stock", () => {
    const t = dictionaries.en;
    const ask = "A lemon whispers to an avocado in a fridge";
    // Only the hero is exported for a slot in the fixture; auth.signup still shows its stock picture, labelled stock.
    const stock = render(<ChatCard copy={chatCopy(t, "auth.signup", ask)} compactClip />).container;
    expect(placeLabelProblems(stock.querySelector(".nx-result-art")!, slotMedia("auth.signup"), t.site)).toEqual([]);
    expect(stock.querySelector("figcaption")?.textContent).toBe(`${t.site.samples.note} ${t.site.samples.clipNote}`);
    cleanup();
    const ai = render(<ChatCard copy={chatCopy(t, "hero", ask)} />).container;
    const art = ai.querySelector(".nx-result-art")!;
    expect(placeLabelProblems(art, slotMedia("hero"), t.site)).toEqual([]);
    expect(ai.querySelector("figcaption")).toBeNull();
    expect(ai.textContent).not.toContain(FIXTURE_ENTRY.modelName);
    expect(ai.textContent).not.toMatch(/Pexels|stock/i);
  });

  // The /pricing card asked for the example video and showed a chocolate pour (owner, 2026-11-14). Whatever a slot holds, the
  // default ask's frame is that example's own clip and nothing else. This fixture's data file does not hold that clip: then the
  // card has no frame at all, never the slot's sample or a stock picture standing in for it (the real data is tests/site-art.test.tsx).
  it("never puts the slot's picture under the default ask: without the example's clip the card has no frame", () => {
    const t = dictionaries.en;
    expect(SHOWCASE_ENTRIES.some((e) => e.jobId === EXAMPLE_THUMB_JOB)).toBe(false);
    for (const slot of ["hero", "auth.signup"] as const) {
      const { container } = render(<ChatCard copy={chatCopy(t, slot)} />);
      expect(container.querySelector(".nx-result-art, img, video, [data-sample], [data-showcase-entry]"), slot).toBeNull();
      expect(container.querySelector(".nx-ui-status")).not.toBeNull();
      expect(container.querySelector("figcaption")).toBeNull();
      cleanup();
    }
  });
});

describe("the stock credits follow what the pages still show", () => {
  it("keep a stock picture while any place shows it (the hero's cloud still plays on /mcp's header)", () => {
    expect(slotMedia("hero").kind).toBe("ai");
    expect(stockInUse()).toContain("cloud");
    expect(stockInUse()).toContain("moon");
  });

  it.each(LOCALES.map((l) => l.code))("%s: with no stock picture left, the footer lists no Pexels credit and says there is none", (code) => {
    state.noStock = true;
    const t = dictionaries[code];
    const { container } = render(<PublicFooter t={t} />);
    const credits = container.querySelector(".st-credits") as HTMLElement;
    expect(credits.textContent).toContain(t.site.credits.leadNoStock);
    expect(credits.innerHTML).not.toMatch(/pexels/i);
    expect(credits.querySelectorAll("li")).toHaveLength(0);
  });
});

describe("the prompt bar opens the Studio form, and nothing else", () => {
  it("builds the Studio form with the tool and the words, through sign-up when signed out, and survives the callback", () => {
    expect(promptHref("t2v", "  paper lanterns over a lake  ", true)).toBe("/all-channels/create?tool=t2v&prompt=paper+lanterns+over+a+lake");
    const out = promptHref("t2i", "a red fox in snow", false)!;
    expect(out.startsWith(`${SIGNUP_PATH}?next=`)).toBe(true);
    const next = new URL(out, "https://x.test").searchParams.get("next")!;
    expect(studioNext(next)).toBe(next);
    expect(afterSignupPath(next)).not.toBe(DEFAULT_AFTER_AUTH);
    // No model is named: the visitor picked none.
    expect(new URL(next, "https://x.test").searchParams.has("model")).toBe(false);
  });

  it("refuses empty words and unknown tools, strips hidden characters, and cuts long words on a word until the form fits through sign-up", () => {
    expect(promptHref("t2v", "   ", false)).toBeNull();
    expect(promptHref("tts" as never, "hello", false)).toBeNull();
    expect(linkWords(`lan${String.fromCodePoint(0x200b)}terns${String.fromCodePoint(0x202e)} rise`)).toBe("lan terns rise");
    const long = promptHref("t2v", "lantern ".repeat(400), false)!;
    const next = new URL(long, "https://x.test").searchParams.get("next")!;
    expect(afterSignupPath(next)).not.toBe(DEFAULT_AFTER_AUTH);
    const kept = new URL(next, "https://x.test").searchParams.get("prompt")!;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.endsWith("lantern")).toBe(true);
  });

  it("agrees with the Studio's own limits (its constants are written out to keep the bar's bundle small)", () => {
    expect(PROMPT_MAX).toBe(IMPROVE_PROMPT_MAX);
    for (const tool of PROMPT_TOOLS) expect(LINK_PROMPT_TOOLS as readonly string[]).toContain(tool);
    expect(SIGNUP_PATH).toBe("/signup");
  });

  it("goes on Enter or Create to the text-to-video form, asks for words when there are none, and a chip fills in a real sample's prompt", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const t = dictionaries.en.site;
    const ideas = [{ id: "soap", label: "Fruit soap opera", tool: "t2v" as const, prompt: "A lemon whispers to an avocado" }];
    const { container } = render(<PromptBar copy={t.prompt} ideas={ideas} />);
    const box = container.querySelector("textarea")!;
    fireEvent.click(within(container).getByRole("button", { name: t.prompt.submit }));
    expect(assign).not.toHaveBeenCalled();
    expect(container.querySelector("[role='alert']")?.textContent).toBe(t.prompt.empty);
    expect(box.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(within(container).getByRole("button", { name: "Fruit soap opera" }));
    expect(box.value).toBe("A lemon whispers to an avocado");
    fireEvent.keyDown(box, { key: "Enter" });
    // Nothing attached is a clip from the words: the one thing the bar makes without a file.
    expect(TEXT_TOOL).toBe("t2v");
    expect(assign).toHaveBeenCalledWith(promptHref("t2v", "A lemon whispers to an avocado", false));
    // The note says nothing starts here, and, while no Studio model is on sale (the bar's default), that nothing can be made there
    // today: never "press Generate" for a form with nothing to pick.
    expect(container.textContent).toContain(t.prompt.noteOutClosed);
    expect(container.textContent).not.toContain(t.prompt.noteOut);
    cleanup();
    const open = render(<PromptBar copy={t.prompt} ideas={[]} studioOpen />).container;
    expect(open.textContent).toContain(t.prompt.noteOut);
  });

  // What would break: the owner asked for no "Video" key (2026-11-14): what is attached decides what is made, not a toggle.
  it("has no output key: only \"+\", the words and the send key, and \"+\" says it takes a picture or a video in every language", () => {
    const t = dictionaries.en.site;
    const { container } = render(<PromptBar copy={t.prompt} ideas={[]} />);
    const keys = [...container.querySelectorAll("form.nx-pbar button")].map((b) => b.getAttribute("aria-label"));
    expect(keys).toEqual([t.prompt.attach, t.prompt.submit]);
    expect(container.querySelector(".nx-pbar-mode")).toBeNull();
    expect(css).not.toContain(".nx-pbar-mode");
    for (const code of LOCALES.map((l) => l.code)) {
      const c = dictionaries[code].site.prompt as Record<string, unknown>;
      expect(c).not.toHaveProperty("mode");
      expect(c).not.toHaveProperty("image");
      expect(String(c.attach).length).toBeGreaterThan(0);
    }
  });

  it("docks as soon as the page scrolls (not once its place has left a tall window), keeps that place's height, tells the page (the start bar steps aside), and undocks back at the top; Escape leaves the box", () => {
    let ro: ResizeObserverCallback | null = null;
    vi.stubGlobal("ResizeObserver", class { constructor(c: ResizeObserverCallback) { ro = c; } observe() {} disconnect() { ro = null; } unobserve() {} });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      // A frame that already ran: no handle left to wait on.
      return 0;
    });
    const scrollTo = (y: number) => {
      Object.defineProperty(window, "scrollY", { configurable: true, value: y });
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
    };
    scrollTo(0);
    const t = dictionaries.en.site;
    const { container } = render(<PromptBar copy={t.prompt} ideas={[]} />);
    const form = container.querySelector("form.nx-pbar") as HTMLFormElement;
    Object.defineProperty(form, "offsetHeight", { configurable: true, value: 64 });
    expect(form.dataset.docked).toBe("false");
    // A little scroll is not enough to leave the first screen...
    scrollTo(DOCK_AT);
    expect(form.dataset.docked).toBe("false");
    // ...one more pixel is: the box comes down with the screen, wherever its place in the first screen still is.
    scrollTo(DOCK_AT + 1);
    expect(form.dataset.docked).toBe("true");
    expect(document.documentElement.getAttribute("data-composer")).toBe("docked");
    expect((container.querySelector(".nx-pbar-slot") as HTMLElement).style.minHeight).toBe("64px");
    // Deep in the page it stays docked.
    scrollTo(20000);
    expect(form.dataset.docked).toBe("true");
    // While docked the box grows (more lines, the empty-box message): its place keeps the height it had when it docked, so nothing
    // the visitor is reading below it moves (a layout shift); the box's live height goes to --nx-dock-h only.
    Object.defineProperty(form, "offsetHeight", { configurable: true, value: 112 });
    act(() => ro?.([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    expect((container.querySelector(".nx-pbar-slot") as HTMLElement).style.minHeight).toBe("64px");
    // The empty-box message is inside the form, so it is on the docked box, not left behind in the first screen.
    fireEvent.submit(form);
    expect(form.querySelector(".nx-pbar-err[role='alert']")?.textContent).toBe(t.prompt.empty);
    // Between the two lines it keeps what it was (no flicker at the edge), and at the top it is back in the first screen.
    scrollTo(UNDOCK_AT + 1);
    expect(form.dataset.docked).toBe("true");
    scrollTo(UNDOCK_AT);
    expect(form.dataset.docked).toBe("false");
    expect(document.documentElement.hasAttribute("data-composer")).toBe(false);
    expect(DOCK_AT).toBeGreaterThan(UNDOCK_AT);
    const box = container.querySelector("textarea")!;
    box.focus();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(document.activeElement).not.toBe(box);
    // Fixed at the bottom centre over the safe area, above the sections and under the sticky header (40) and the Shorts feed (80).
    expect(css).toMatch(/\.nx-pbar\[data-docked="true"\] \{ position: fixed; z-index: 60; left: 50%; bottom: calc\(14px \+ env\(safe-area-inset-bottom\)\);[^}]*transform: translateX\(-50%\);/);
    expect(css).toContain('html[data-composer="docked"] .nx-bar { display: none; }');
    // Scrolled-to fields and anchors stop above the docked box; the lifted first screen stays under the sticky header (40).
    expect(css).toMatch(/html\[data-composer="docked"\]:has\(\.nx-pbar\) \{ scroll-padding-bottom: calc\(/);
    expect(css).toContain('.nx-hero.nx-sh:has(.nx-pbar[data-docked="true"]) { z-index: 39; }');
    expect(css).toMatch(/@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
  });

  it("a page opened already scrolled down starts docked", () => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 1500 });
    const { container } = render(<PromptBar copy={dictionaries.en.site.prompt} ideas={[]} />);
    expect((container.querySelector("form.nx-pbar") as HTMLFormElement).dataset.docked).toBe("true");
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });
  it("before its script runs, Create is off (the server's markup), so no form is ever sent that would drop the words", () => {
    const html = renderToStaticMarkup(<PromptBar copy={dictionaries.en.site.prompt} ideas={[]} />);
    expect(html).toMatch(/<button type="submit" class="nx-pbar-go"[^>]*disabled="">/);
    // Once it runs, Create is on (checked above by pressing it).
    expect(render(<PromptBar copy={dictionaries.en.site.prompt} ideas={[]} />).container.querySelector(".nx-pbar-go")?.hasAttribute("disabled")).toBe(false);
  });

  // The landing's first screen is the idea box now (components/landing/home/IdeaBox.tsx, tests/landing-example-entry.test.tsx); the
  // bar, its chips and its dock are not drawn there, so a second, docked box can never sit over the page.
  it("is not on the landing: the first screen's idea box is the page's one place to type", () => {
    const { container } = landing();
    expect(container.querySelector(".nx-pbar, .nx-pbar-idea, .nx-pbar-slot")).toBeNull();
    // One field to type an idea in, on the whole page, and it is the first screen's (one line since the glass bar, 2026-11-22).
    expect(container.querySelectorAll("textarea, [data-testid='idea-field']")).toHaveLength(1);
    expect(container.querySelector("section.hm-hero input[data-testid='idea-field']")).toBeTruthy();
  });
});

describe("the gallery's clips on a wide screen", () => {
  let play: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    play = vi.fn(() => Promise.resolve());
    HTMLMediaElement.prototype.play = play as never;
    HTMLMediaElement.prototype.pause = vi.fn() as never;
  });

  it("play while each is in view, without waiting to lead, and use the small file; never under reduced motion", () => {
    const observers: { cb: IntersectionObserverCallback }[] = [];
    const stub = (reduce: boolean) => {
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") ? reduce : q.includes("min-width"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          constructor(cb: IntersectionObserverCallback) {
            observers.push({ cb });
          }
          observe() {}
          disconnect() {}
          unobserve() {}
        },
      );
    };
    stub(false);
    const sources = FIXTURE_FILES[FIXTURE_JOB].clip!;
    const { container } = render(
      <div>
        <LoopClip sources={sources} poster="/p.webp" together />
        <LoopClip sources={sources} poster="/p.webp" together />
      </div>,
    );
    expect(container.querySelector("source[type='video/webm']")?.getAttribute("src")).toBe(sources.smWebm);
    act(() => observers.forEach((o) => o.cb([{ isIntersecting: true, intersectionRatio: 0.6 } as IntersectionObserverEntry], {} as IntersectionObserver)));
    expect(play).toHaveBeenCalledTimes(2);
    cleanup();
    play.mockClear();
    stub(true);
    expect(render(<LoopClip sources={sources} poster="/p.webp" together />).container.querySelector("video")).toBeNull();
  });

  // The owner wants no visible pause button (2026-11-13): a pointer pauses by tapping what moves, a keyboard by the focus-revealed
  // switch (ClipPause, MotionToggle). What would break (WCAG 2.2.2): a pointer with no way to stop motion, which the review of #734
  // found under Save-Data, where no clip plays but the posters drift; a tap on a link or button that also flips the switch.
  // What would break (the final review of #734): double-clicking a word of the headline to select it flipped the page's pause.
  it("a double-click that selects a word in a tap area leaves the switch as it was; a triple-click changes nothing more", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
    const { container } = render(
      <div>
        <LoopClip sources={FIXTURE_FILES[FIXTURE_JOB].clip!} poster="/p.webp" />
        <section className="nx-sh">
          <h1>Words over the clip</h1>
        </section>
      </div>,
    );
    const h1 = container.querySelector("h1")!;
    const paused = () => document.documentElement.getAttribute("data-motion") === "paused";
    expect(paused()).toBe(false);
    // A browser sends a double-click as click (detail 1), click (detail 2), then dblclick.
    act(() => fireEvent.click(h1, { detail: 1 }));
    expect(paused()).toBe(true);
    act(() => fireEvent.click(h1, { detail: 2 }));
    expect(paused()).toBe(false);
    act(() => fireEvent.click(h1, { detail: 3 }));
    expect(paused()).toBe(false);
    // The same from a paused page: the double-click leaves it paused.
    act(() => fireEvent.click(h1, { detail: 1 }));
    expect(paused()).toBe(true);
    act(() => fireEvent.click(h1, { detail: 1 }));
    act(() => fireEvent.click(h1, { detail: 2 }));
    expect(paused()).toBe(true);
    // A lone detail-2 click with no flip just before it (a slow second click) does nothing.
    act(() => fireEvent.click(h1, { detail: 2 }));
    expect(paused()).toBe(true);
    act(() => fireEvent.click(h1, { detail: 1 }));
    expect(paused()).toBe(false);
  });

  it("a tap on a clip's box, a drifting poster or the first screen pauses the page's motion and a second resumes it, clip playing or not; a tap on a control does nothing", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: !q.includes("reduce") && q.includes("min-width"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
    vi.stubGlobal("IntersectionObserver", undefined);
    const sources = FIXTURE_FILES[FIXTURE_JOB].clip!;
    const { container } = render(
      <div>
        <div data-clip="sample" data-testid="box">
          <LoopClip sources={sources} poster="/p.webp" />
          <a href="/signup">Start</a>
          <button type="button">Other</button>
        </div>
        <img className="nx-drift-pic" alt="" data-testid="drift" />
        <section className="nx-sh" data-testid="hero">
          <h1>Words over the clip</h1>
          <form>
            <textarea aria-label="box" />
          </form>
        </section>
        <p data-testid="plain">Not moving</p>
      </div>,
    );
    const paused = () => document.documentElement.getAttribute("data-motion") === "paused";
    const box = container.querySelector("[data-testid='box']") as HTMLElement;
    act(() => fireEvent.click(box.querySelector("a")!));
    act(() => fireEvent.click(box.querySelector("button")!));
    act(() => fireEvent.click(container.querySelector("[data-testid='plain']")!));
    act(() => fireEvent.click(container.querySelector("textarea")!));
    expect(paused()).toBe(false);
    // jsdom never plays a video, so this is also the "no clip is playing" case: the tap still stops the page's motion.
    act(() => fireEvent.click(box.querySelector("video")!));
    expect(paused()).toBe(true);
    act(() => fireEvent.click(box));
    expect(paused()).toBe(false);
    act(() => fireEvent.click(container.querySelector("[data-testid='drift']")!));
    expect(paused()).toBe(true);
    act(() => fireEvent.click(container.querySelector("h1")!));
    expect(paused()).toBe(false);
    cleanup();
    // Under Save-Data no clip is rendered at all, and a drifting poster still stops on a tap (the listener is the page's, not the clip's).
    Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
    const saving = render(
      <div>
        <LoopClip sources={sources} poster="/p.webp" />
        <img className="nx-drift-pic" alt="" data-testid="drift" />
      </div>,
    ).container;
    expect(saving.querySelector("video")).toBeNull();
    act(() => fireEvent.click(saving.querySelector("[data-testid='drift']")!));
    expect(paused()).toBe(true);
    act(() => fireEvent.click(saving.querySelector("[data-testid='drift']")!));
    expect(paused()).toBe(false);
    Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
    cleanup();
    // Under reduced motion nothing moves: a tap changes nothing.
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
    const still = render(<LoopClip sources={sources} poster="/p.webp" />).container;
    expect(still.querySelector("video")).toBeNull();
    // (Called directly too: the decision itself refuses under reduced motion, whoever calls it.)
    const tap = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(tap, "target", { value: Object.assign(document.createElement("img"), { className: "nx-drift-pic" }) });
    motionTap(tap);
    const drift = document.createElement("img");
    drift.className = "nx-drift-pic";
    document.body.append(drift);
    act(() => fireEvent.click(drift));
    drift.remove();
    expect(paused()).toBe(false);
  });
});

describe("copy and config", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the new words exist, name no model or maker, and say the bar starts nothing", (code) => {
    const s = dictionaries[code].site;
    for (const block of [s.prompt, s.facts, s.formats, s.models, s.approvalCard]) expect(JSON.stringify(block)).not.toMatch(PROVIDER_BRANDS);
    expect(s.formats.items.map((i) => i.id)).toEqual(FORMATS.map((f) => f.id));
    for (const v of [s.approvalCard.figure, s.gallery.useNote, s.credits.leadNoStock, s.stage.bareNote, s.prompt.noteIn, s.prompt.noteOut, s.prompt.noteInClosed, s.prompt.noteOutClosed, s.hero.leadShort, s.hero.leadShortClosed]) expect(v.trim().length).toBeGreaterThan(20);
    // The closed words claim nothing a visitor can make today: no "press Generate", and they say the models are not on sale.
    for (const v of [s.prompt.noteInClosed, s.prompt.noteOutClosed]) expect(v).not.toContain(dictionaries[code].gen.generate);
    // The formats are only their cards' words: the cards are drawn inside the gallery, under its own heading.
    expect(Object.keys(s.formats)).toEqual(["items"]);
    // The bar's note names the Studio's own button (ru «Создать», not «Сгенерировать»).
    expect(s.prompt.noteIn).toContain(dictionaries[code].gen.generate);
    expect(s.prompt.noteOut).toContain(dictionaries[code].gen.generate);
    expect(s.models.count).toContain("{n}");
    // Facts are statements, not promises or claims about other people.
    expect(JSON.stringify(s.facts)).not.toMatch(/users|customers|creators|пользовател|клиент|foydalanuvchi|mijoz/i);
  });

  it("keeps the bot's showcase branches (and the agents' branches) from deploying a preview", () => {
    const v = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as { git: { deploymentEnabled: Record<string, boolean> } };
    expect(v.git.deploymentEnabled["showcase/**"]).toBe(false);
    expect(v.git.deploymentEnabled["claude/**"]).toBe(false);
  });
});
