// @vitest-environment jsdom
/**
 * Round 10: our own generations in the site's picture slots, the AI-studio landing (the first screen edge to edge, the prompt
 * bar, the facts, the explore grid, the model tiles), and the stock credits that shrink as samples replace the stock pictures.
 *
 * The data file and its generated module hold two fixture samples here (one exported for the "hero" and "pricing.card" slots
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
      ],
    },
  };
});
vi.mock("@/components/site/showcase-assets", async () => {
  const { FIXTURE_FILES, FIXTURE_JOB } = await import("./fixtures/showcase-entry");
  return { SHOWCASE_FILES: { ...FIXTURE_FILES, "0d0d0d0d-1111-4222-8333-444455556666": FIXTURE_FILES[FIXTURE_JOB] } };
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
import { stockInUse } from "@/components/site/stock-in-use";
import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";
import { FORMATS } from "@/lib/site/formats";
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

const ROOT = join(__dirname, "..");
const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");
const NO_MONEY: MoneyAnchor = { pack: { kind: "none" }, api: null, site: null };
const OTHER = "0d0d0d0d-1111-4222-8333-444455556666";

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

describe("the landing with a sample in its hero slot", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the first screen plays our sample edge to edge, labelled AI-generated only: no model name, no prompt button, no footnote, no maker's credit, no stock word", (code) => {
    const t = dictionaries[code];
    const { container } = landing(code);
    const m = slotMedia("hero");
    expect(m.kind).toBe("ai");
    const media = container.querySelector(".nx-sh-media") as HTMLElement;
    expect(media.dataset.showcaseEntry).toBe(FIXTURE_JOB);
    expect(media.dataset.model).toBe(FIXTURE_ENTRY.modelId);
    const img = media.querySelector("img")!;
    // A backdrop: described as what it is, without the model (the owner, 2026-11-13: the model and the prompt belong on the
    // sample's own card, not under copy about something else).
    expect(img.getAttribute("alt")).toBe(t.site.gallery.bgClip);
    expect(img.getAttribute("loading")).toBe("eager");
    expect(img.hasAttribute("data-sample")).toBe(false);
    const credit = container.querySelector(".nx-sh-credit") as HTMLElement;
    expect(placeLabelProblems(credit, m, t.site)).toEqual([]);
    expect(credit.textContent).toBe(t.site.gallery.badge);
    expect(within(credit).queryAllByRole("link")).toHaveLength(0);
    expect(media.textContent).not.toContain(FIXTURE_ENTRY.modelName);
    // The hero's sample is not shown again in the gallery; the other sample is.
    expect(slotJobs(LANDING_SLOTS)).toEqual([FIXTURE_JOB]);
    expect(container.querySelector(`${GALLERY} [data-showcase-entry="${FIXTURE_JOB}"]`)).toBeNull();
    expect(container.querySelector(`${GALLERY} [data-showcase-entry="${OTHER}"]`)).toBeTruthy();
    // A model is named only inside a sample's own box.
    expect(without(container, SAMPLE_CARD).textContent).not.toMatch(PROVIDER_BRANDS);
    expect(without(container, SAMPLE_CARD).innerHTML).not.toMatch(PROVIDER_BRANDS);
  });

  it("counts what the page holds: the samples on it and the models that made them, and the welcome grant", () => {
    const { container } = landing();
    const facts = Object.fromEntries([...container.querySelectorAll(".nx-facts-list li")].map((li) => [li.getAttribute("data-fact"), li.querySelector(".nx-facts-n")?.textContent]));
    expect(facts).toEqual({ samples: "2", models: "2", credits: String(WELCOME_CREDITS) });
  });

  it("gives each model of a sample anywhere on the page one tile (as many as the facts count), inside its sample's box, with no maker's credit, the truth about the Studio and no price", () => {
    const t = dictionaries.en;
    const { container } = landing();
    const tiles = [...container.querySelectorAll<HTMLElement>("#models .nx-model")];
    // The gallery's sample, then the hero's: two models, the number the facts row says.
    expect(tiles.map((x) => x.dataset.model)).toEqual(["minimax-h3", "runway-gen4.5"]);
    expect(container.querySelector("[data-fact='models'] .nx-facts-n")?.textContent).toBe(String(tiles.length));
    // Each tile links to its sample on this page: the gallery card, or the box of the slot that shows it (the hero).
    for (const tile of tiles) {
      const href = tile.querySelector(".nx-model-see")!.getAttribute("href")!;
      expect(href).toBe(`#sample-${tile.dataset.showcaseEntry}`);
      expect(container.querySelectorAll(href)).toHaveLength(1);
    }
    expect(container.querySelector(`#sample-${FIXTURE_JOB}`)?.matches(".nx-sh-media")).toBe(true);
    const runway = tiles[1];
    expect(runway.querySelector(".nx-model-count")?.textContent).toBe(fmt(t.site.models.count, { n: "1" }));
    // Runway asks for "Powered by Runway"; the public site does not show it (it is shown in the Studio, where the model is used).
    expect(FIXTURE_ENTRY.attribution).not.toBeNull();
    expect(makerCreditProblems(runway)).toEqual([]);
    const tile = tiles[0];
    expect(tile.dataset.showcaseEntry).toBe(OTHER);
    expect(tile.querySelector(".nx-model-name")?.textContent).toBe("MiniMax H3");
    expect(tile.querySelector(".nx-gallery-unavailable")?.textContent).toBe(t.site.gallery.notInStudio);
    expect(tile.querySelector(`a[href="#sample-${OTHER}"]`)?.textContent).toBe(t.site.models.see);
    expect(tile.textContent).not.toMatch(/\$|€|credit|new\b/i);
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

describe("another page's slot with a sample: the /pricing chat card", () => {
  it("labels the frame as our sample with its badge only (no footnote under the card), and says nothing about stock", () => {
    const t = dictionaries.en;
    // Only the hero is exported for a slot in the fixture; pricing.card still shows its stock picture, labelled stock.
    const stock = render(<ChatCard copy={chatCopy(t, "pricing.card")} compactClip />).container;
    expect(placeLabelProblems(stock.querySelector(".nx-result-art")!, slotMedia("pricing.card"), t.site)).toEqual([]);
    expect(stock.querySelector("figcaption")?.textContent).toBe(`${t.site.samples.note} ${t.site.samples.clipNote}`);
    cleanup();
    const ai = render(<ChatCard copy={chatCopy(t, "hero")} />).container;
    const art = ai.querySelector(".nx-result-art")!;
    expect(placeLabelProblems(art, slotMedia("hero"), t.site)).toEqual([]);
    expect(ai.querySelector("figcaption")).toBeNull();
    expect(ai.textContent).not.toContain(FIXTURE_ENTRY.modelName);
    expect(ai.textContent).not.toMatch(/Pexels|stock/i);
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
    // While docked the box grows (more lines, the empty-box message): its place follows, so undocking shifts nothing.
    Object.defineProperty(form, "offsetHeight", { configurable: true, value: 112 });
    act(() => ro?.([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    expect((container.querySelector(".nx-pbar-slot") as HTMLElement).style.minHeight).toBe("112px");
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

  it("is fed only real prompts on the landing: each chip is a format whose clip sample is merged, with that sample's words (nothing attached makes a clip)", () => {
    const { container } = landing();
    const chips = [...container.querySelectorAll(".nx-pbar-idea")].map((b) => b.textContent);
    const merged = FORMATS.filter((f) => SHOWCASE_ENTRIES.some((e) => e.jobId === f.job && e.capability === TEXT_TOOL && e.prompt.trim()));
    expect(chips).toEqual(merged.slice(0, 4).map((f) => dictionaries.en.site.formats.items.find((i) => i.id === f.id)!.title));
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
