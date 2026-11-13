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
import { PromptBar } from "@/components/landing/PromptBar";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { LoopClip } from "@/components/site/LoopClip";
import { SLOTS, placeMedia, slotJobs, slotMedia, LANDING_SLOTS } from "@/components/site/samples";
import { stockInUse } from "@/components/site/stock-in-use";
import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";
import { FORMATS } from "@/lib/site/formats";
import { PROMPT_MAX, PROMPT_TOOLS, linkWords, promptHref } from "@/lib/site/prompt-link";
import { IMPROVE_PROMPT_MAX, LINK_PROMPT_TOOLS } from "@/lib/creative/improve";
import { SIGNUP_PATH } from "@/lib/public-paths";
import { DEFAULT_AFTER_AUTH, afterSignupPath, studioNext } from "@/lib/safe-redirect";
import { MEDIA_IDS } from "@/lib/site/media";
import type { MoneyAnchor } from "@/lib/landing";
import { WELCOME_CREDITS } from "@/lib/pricing";
import { PROVIDER_BRANDS } from "./helpers/brands";
import { GALLERY, SAMPLE_CARD, placeLabelProblems, without } from "./helpers/showcase-scope";
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
    const src = readFileSync(join(ROOT, "components/site/samples.tsx"), "utf8");
    const block = src.slice(src.indexOf("export const SLOTS = {"), src.indexOf("} as const", src.indexOf("export const SLOTS = {")));
    const names = [...block.matchAll(/^\s{2}(?:"([^"]+)"|([A-Za-z0-9_]+)):\s*\{/gm)].map((m) => m[1] ?? m[2]);
    expect(names).toEqual(Object.keys(SLOTS));
  });
});

describe("the landing with a sample in its hero slot", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the first screen plays our sample edge to edge, labelled AI-generated with its model, its maker's credit and Try this prompt, and no stock word", (code) => {
    const t = dictionaries[code];
    const { container } = landing(code);
    const m = slotMedia("hero");
    expect(m.kind).toBe("ai");
    const media = container.querySelector(".nx-sh-media") as HTMLElement;
    expect(media.dataset.showcaseEntry).toBe(FIXTURE_JOB);
    expect(media.dataset.model).toBe(FIXTURE_ENTRY.modelId);
    const img = media.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe(fmt(t.site.gallery.altClip, { model: FIXTURE_ENTRY.modelName }));
    expect(img.getAttribute("loading")).toBe("eager");
    expect(img.hasAttribute("data-sample")).toBe(false);
    const credit = container.querySelector(".nx-sh-credit") as HTMLElement;
    expect(placeLabelProblems(credit, m, t.site)).toEqual([]);
    const tryIt = within(credit).getByRole("link", { name: t.site.gallery.try });
    expect(tryIt.getAttribute("href")!.startsWith("/signup?next=")).toBe(true);
    expect(document.getElementById(tryIt.getAttribute("aria-describedby")!)?.textContent).toBe(FIXTURE_ENTRY.prompt);
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

  it("gives each model of the gallery one tile, inside its sample's box, with the maker's credit where there is one, the truth about the Studio and no price", () => {
    const t = dictionaries.en;
    const { container } = landing();
    const tiles = [...container.querySelectorAll<HTMLElement>("#models .nx-model")];
    // The gallery shows one sample (the other is the hero's): one model.
    expect(tiles.map((x) => x.dataset.model)).toEqual(["minimax-h3"]);
    const tile = tiles[0];
    expect(tile.dataset.showcaseEntry).toBe(OTHER);
    expect(tile.querySelector(".nx-model-name")?.textContent).toBe("MiniMax H3");
    expect(tile.querySelector(".nx-ai-attr")).toBeNull();
    expect(tile.querySelector(".nx-gallery-unavailable")?.textContent).toBe(t.site.gallery.notInStudio);
    expect(tile.querySelector(`a[href="#sample-${OTHER}"]`)?.textContent).toBe(t.site.models.see);
    expect(tile.textContent).not.toMatch(/\$|€|credit|new\b/i);
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
  it("labels the frame as our sample, says so under the card, and says nothing about stock", () => {
    const t = dictionaries.en;
    // Only the hero is exported for a slot in the fixture; pricing.card still shows its stock picture, labelled stock.
    const stock = render(<ChatCard copy={chatCopy(t, "pricing.card")} compactClip />).container;
    expect(placeLabelProblems(stock.querySelector(".nx-result-art")!, slotMedia("pricing.card"), t.site)).toEqual([]);
    expect(stock.querySelector("figcaption")?.textContent).toBe(`${t.site.samples.note} ${t.site.samples.clipNote}`);
    cleanup();
    const ai = render(<ChatCard copy={chatCopy(t, "hero")} />).container;
    const art = ai.querySelector(".nx-result-art")!;
    expect(placeLabelProblems(art, slotMedia("hero"), t.site)).toEqual([]);
    expect(ai.querySelector("figcaption")?.textContent).toBe(t.site.gallery.slotNote);
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

  it("goes on Enter or Create, asks for words when there are none, and a chip fills in a real sample's prompt", () => {
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
    fireEvent.click(within(container).getByRole("button", { name: t.prompt.image }));
    expect(within(container).getByRole("button", { name: t.prompt.image }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(assign).toHaveBeenCalledWith(promptHref("t2i", "A lemon whispers to an avocado", false));
    // The note says nothing starts here.
    expect(container.textContent).toContain(t.prompt.noteOut);
  });

  it("is fed only real prompts on the landing: each chip is a format whose sample is merged, with that sample's words", () => {
    const { container } = landing();
    const chips = [...container.querySelectorAll(".nx-pbar-idea")].map((b) => b.textContent);
    const merged = FORMATS.filter((f) => SHOWCASE_ENTRIES.some((e) => e.jobId === f.job));
    expect(chips).toEqual(merged.map((f) => dictionaries.en.site.formats.items.find((i) => i.id === f.id)!.title));
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
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") ? reduce : q.includes("min-width: 860px"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
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
});

describe("copy and config", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the new words exist, name no model or maker, and say the bar starts nothing", (code) => {
    const s = dictionaries[code].site;
    for (const block of [s.prompt, s.facts, s.formats, s.models]) expect(JSON.stringify(block)).not.toMatch(PROVIDER_BRANDS);
    expect(s.formats.items.map((i) => i.id)).toEqual(FORMATS.map((f) => f.id));
    for (const v of [s.gallery.slotNote, s.credits.leadNoStock, s.stage.bareNote, s.prompt.noteIn, s.prompt.noteOut]) expect(v.trim().length).toBeGreaterThan(20);
    expect(s.models.count).toContain("{n}");
    expect(s.formats.tryAria).toContain("{format}");
    // Facts are statements, not promises or claims about other people.
    expect(JSON.stringify(s.facts)).not.toMatch(/users|customers|creators|пользовател|клиент|foydalanuvchi|mijoz/i);
  });

  it("keeps the bot's showcase branches (and the agents' branches) from deploying a preview", () => {
    const v = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as { git: { deploymentEnabled: Record<string, boolean> } };
    expect(v.git.deploymentEnabled["showcase/**"]).toBe(false);
    expect(v.git.deploymentEnabled["claude/**"]).toBe(false);
  });
});
