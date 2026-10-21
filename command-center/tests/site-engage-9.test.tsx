// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { ChatCard, chatCopy } from "@/components/landing/HeroCard";
import { LoopClip } from "@/components/site/LoopClip";
import { CLIPS, SAMPLES, SLOTS, slotClip } from "@/components/site/samples";
import { SCENE_SAMPLE } from "@/components/docs/SampleFrame";
import { MEDIA, MEDIA_IDS } from "@/lib/site/media";
import { setMotionPaused } from "@/lib/site/motion";

const ROOT = join(__dirname, "..");
const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");
const siteCss = readFileSync(join(ROOT, "components/site/site.css"), "utf8");

function env({ wide = false }: { wide?: boolean } = {}) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("min-width: 860px") ? wide : false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: false, effectiveType: "4g" } });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}
beforeEach(() => {
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve()) as never;
  HTMLMediaElement.prototype.pause = vi.fn() as never;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
});

const landing = (code: "en" | "ru" | "uz" = "en") => render(<Landing t={dictionaries[code]} locale={code} pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: null }} showcase={[]} />);

describe("a phone's first screen is the picture (round 9; the footage moved into the chat card when the studio backdrop took the panel)", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the dark panel holds the backdrop first, then the pill, the headline and the one button; the stock footage plays in the chat card under it, labelled and credited like every picture", (code) => {
    env();
    const t = dictionaries[code];
    const { container } = landing(code);
    const top = container.querySelector(".nx-hero-top")!;
    expect(top.firstElementChild?.matches("picture.nx-hero-bg-phone")).toBe(true);
    expect(container.querySelector(".nx-hero-bleed")).toBeNull();
    // The footage (one clip on the page, never two) is the card's picture at every width, with its badges and credit.
    const art = container.querySelector(".nx-hero-visual .nx-result-art")!;
    expect(art.getAttribute("data-clip")).toBe("cloud");
    expect(art.querySelector("img")?.getAttribute("data-sample")).toBe("cloud");
    expect(art.querySelector(".nx-result-badge[data-kind='still']")?.textContent).toBe(t.site.samples.frameTag);
    expect(art.querySelector(".nx-result-badge[data-kind='clip']")?.textContent).toBe(t.site.samples.clipTag);
    expect(art.querySelector(".nx-result-credit")?.textContent).toBe(t.site.samples.credit.video.replace("{name}", "K"));
    // The headline and the hero's one primary button are inside the panel; the only other "Start free" links are the closing panel's.
    expect(top.querySelector("h1")).toBeTruthy();
    expect(top.querySelectorAll(".nx-actions a.nx-btn")).toHaveLength(1);
    expect(container.querySelectorAll(".nx-hero .nx-actions")).toHaveLength(1);
  });

  it("shows the phone backdrop below 1024 px and the wide one above it, and the card's footage at every width (the clip is never on screen twice: the old panel's copy is gone)", () => {
    expect(css).toMatch(/\.nx-hero-bg \{ display: none; \}/);
    expect(css).toMatch(/@media \(max-width: 1023px\) \{\n  \.nx-hero-bg-phone \{ display: block;/);
    expect(css).toMatch(/@media \(min-width: 1024px\) \{\n  \.nx-hero \{ background: #0b0a09;[\s\S]*?\.nx-hero-bg-wide \{ display: block;/);
    expect(css).not.toMatch(/\.nx-hero \.nx-chat \.nx-result-art \{ display: none; \}/);
  });

  it("keeps the panel dark in both themes, and the stock clip a pixel smaller than its still where the footage is a panel (/mcp's header)", () => {
    expect(css).toMatch(/\.nx-hero-top \{[^}]*background: #0b0a09; color: #fff;/);
    expect(css).toMatch(/\.nx-bleed \.nx-clip \{ left: 3px; width: calc\(100% - 6px\);/);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the page's own pause switch (under the card) stops the footage, and the picture panels' 44 px pause button keeps its rules (/mcp's header is still one)", (code) => {
    env();
    const t = dictionaries[code];
    const { container } = landing(code);
    const sw = container.querySelector(".nx-hero-visual .nx-motion-btn") as HTMLButtonElement;
    expect(sw.textContent).toBe(t.site.fx.pause);
    expect(sw.getAttribute("aria-pressed")).toBe("false");
    act(() => sw.click());
    expect(sw.getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.getAttribute("data-motion")).toBe("paused");
    act(() => setMotionPaused(false));
    expect(sw.getAttribute("aria-pressed")).toBe("false");
    // Top right, 44 px, a visible focus ring; the badge is top left and the credit bottom right; under reduced motion it is gone with the video.
    expect(css).toMatch(/\.nx-bleed \.nx-clip-pause \{ top: 12px; right: 12px; bottom: auto; z-index: 3; \}/);
    expect(css).toMatch(/\.nx-clip-pause \{[^}]*width: 44px; height: 44px;/);
    expect(css).toMatch(/\.nx-clip-pause:focus-visible \{ outline: 3px solid var\(--nx-stage-amber, #ffa940\);/);
    expect(css).toMatch(/\.nx-bleed \.nx-result-badge \{ z-index: 2; top: 16px; left: 16px; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.nx-clip-pause \{ display: none; \} \}/);
    // /mcp's header is outside .nx, where the stage tokens are undefined: every var() the button uses has a literal fallback.
    expect(css).toContain('.nx-clip-pause[aria-pressed="true"] { border-color: var(--nx-stage-amber, #ffa940); color: var(--nx-stage-amber, #ffa940); }');
  });

  it("asks for the wide still on a phone (200vw) where the footage is a panel (HeroBleed, now /mcp's header), so the still, not the clip's first frame, is the largest paint", () => {
    const src = readFileSync(join(ROOT, "components/landing/HeroBleed.tsx"), "utf8");
    expect(src).toContain('"(min-width: 1024px) 1px, 200vw"');
    expect(src).toContain('"(min-width: 1024px) 720px, 200vw"');
    expect(css).toMatch(/\.nx-bleed \.nx-clip \{ left: 3px; width: calc\(100% - 6px\);/);
  });

  it("drops the first of three showcases (a still photograph) from the landing: two remain, each with a clip", () => {
    env();
    const { container } = landing();
    expect([...container.querySelectorAll("section.nx-show")].map((s) => s.id)).toEqual(["studio", "approvals"]);
    expect(Object.keys(SLOTS)).not.toContain("show.video");
  });
});

describe("the capability wall on a phone (round 9)", () => {
  it.each(LOCALES.map((l) => l.code))("%s: all eight tools are in the page, the last four are hidden until a button shows them, and the label stays", (code) => {
    env();
    const t = dictionaries[code];
    const { container } = landing(code);
    const wall = container.querySelector("#tools") as HTMLElement;
    const tiles = [...wall.querySelectorAll("li.nx-wall-tile")];
    expect(tiles).toHaveLength(8);
    expect(wall.querySelector(".nx-wall-label")?.textContent).toBe(t.site.wall.label);
    const more = wall.querySelector("button.nx-wall-more") as HTMLButtonElement;
    expect(more.textContent).toBe(t.site.wall.more);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("aria-controls")).toBe(wall.querySelector("ul")!.id);
    expect(wall.getAttribute("data-open")).toBe("false");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(wall.getAttribute("data-open")).toBe("true");
    expect(more.textContent).toBe(t.site.wall.less);
  });

  it("hides tiles five to eight on a phone only, and a hidden lazy picture is not fetched; the button is a desktop non-event", () => {
    expect(css).toMatch(/@media \(max-width: 639px\) \{\s*\.nx-wall\[data-open="false"\] \.nx-wall-tile:nth-child\(n \+ 5\) \{ display: none; \}/);
    expect(css).toMatch(/@media \(min-width: 640px\) \{ \.nx-wall-more \{ display: none; \} \}/);
    const wallSrc = readFileSync(join(ROOT, "components/landing/CapabilityWall.tsx"), "utf8");
    expect(wallSrc).not.toMatch(/eager/);
  });

  it("lets only the tile that shows most of itself drift, and never under reduced motion or the pause switch", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.nx-wall-icon \{ transition: transform 7s/);
    expect(css).toMatch(/\.nx-wall-tile\[data-alive\] \.nx-wall-icon, \.nx-wall-tile:hover \.nx-wall-icon \{ transform: scale\(1\.12\); \}/);
    expect(css).toMatch(/html\[data-motion="paused"\] \.nx-wall-icon \{ transition: none; transform: none !important; \}/);
    const src = readFileSync(join(ROOT, "components/landing/WallControls.tsx"), "utf8");
    expect(src).toMatch(/prefers-reduced-motion: reduce/);
  });
});

describe("the chat card without a picture (/mcp, round 9)", () => {
  it("prints the ask, the reply, the lamps and the drawn key, and nothing that looks like a result", () => {
    env();
    const t = dictionaries.en;
    const { container } = render(<ChatCard copy={chatCopy(t, "hero")} bare />);
    const card = container.querySelector("figure.nx-chat")!;
    expect(card.querySelector("img, video, svg[data-art], .nx-result-art")).toBeNull();
    expect(card.querySelector(".nx-ui-status")).toBeTruthy();
    expect(card.querySelector(".nx-chat-key")?.closest("[aria-hidden]")).toBeTruthy();
    expect(card.querySelector("figcaption")?.textContent).toBe(t.site.samples.note);
  });

  it("makes the drawn key dashed and unfilled everywhere, so it cannot be read as a second button", () => {
    expect(css).toMatch(/\.nx-chat-key \{[^}]*border: 1px dashed var\(--ns-amber\); background: transparent;/);
    expect(css).toMatch(/@keyframes nx-key \{ from \{ border-color: var\(--ns-rule-strong\); color: var\(--ns-text-dim\); \} \}/);
  });
});

describe("clips on /signup, /mcp and the examples (round 9)", () => {
  it("gives the sign-up stage the floating lanterns, /mcp's header the cloud sea and its sixth example card the caravan, each reusing a clip from another page", () => {
    expect(slotClip("auth.signup")).toBe("floating");
    expect(slotClip("auth.login")).toBeNull();
    expect(slotClip("mcp.hero")).toBe("cloud");
    expect(SCENE_SAMPLE.dunes).toMatchObject({ id: "caravan", clip: "caravan" });
    expect(Object.values(SCENE_SAMPLE).filter((s) => "clip" in s && s.clip)).toHaveLength(1);
    const shell = readFileSync(join(ROOT, "components/auth/AuthShell.tsx"), "utf8");
    expect(shell).toMatch(/<LoopClip clip=\{clip\}/);
    expect(shell).toMatch(/<ClipPause label=\{t\.site\.fx\.pause\} \/>/);
    expect(shell).toMatch(/data-clip=\{clip \?\? undefined\}/);
  });

  it("serves a card that is never wider than 560 px the 640 px file even on a wide screen (compact), and a wide frame the 1280 one", () => {
    env({ wide: true });
    const { container, rerender } = render(<LoopClip clip="caravan" poster="p.webp" compact />);
    expect(container.querySelector("source[type='video/webm']")?.getAttribute("src")).toBe(CLIPS.caravan.smWebm);
    rerender(<LoopClip clip="caravan" poster="p.webp" />);
    cleanup();
    const wide = render(<LoopClip clip="caravan" poster="p.webp" />);
    act(() => undefined);
    expect(wide.container.querySelector("source[type='video/webm']")?.getAttribute("src")).toBe(CLIPS.caravan.webm);
    const pricing = readFileSync(join(ROOT, "components/pricing/PricingView.tsx"), "utf8");
    expect(pricing).toMatch(/slot="pricing\.card" compactClip/);
    expect(readFileSync(join(ROOT, "components/site/SolutionPictures.tsx"), "utf8")).toMatch(/clip="caravan" poster=\{SAMPLES\.caravan\.sm\} compact/);
  });

  it("has a still, a credit and a caption for the sign-in photograph, and nothing left of the pictures it replaced", () => {
    expect(MEDIA.desert).toMatchObject({ pexelsId: "28638937", kind: "photo", creator: "Stephen Leonardi" });
    for (const gone of ["alley", "lanterngrid", "dunes"]) {
      expect(MEDIA_IDS as readonly string[]).not.toContain(gone);
      expect(Object.keys(SAMPLES)).not.toContain(gone);
    }
    for (const l of LOCALES) {
      const s = dictionaries[l.code].site.samples;
      expect(Object.keys(s.captions).sort()).toEqual(["desert", "floating"]);
      expect(s.captions.desert).not.toMatch(/sunrise|sunset|Namib|Sahara/i);
    }
  });
});

describe("boxes that cannot move when the web font replaces the fallback (round 9)", () => {
  it("reserves the /mcp panel's text lines for every width bucket, in en and in ru/uz", () => {
    const buckets = css.match(/@media [^{]*\{ \.nx-mcp-copy\.nx-bleed-panel \{ --l-h1: \d; --l-lead: \d+; --l-paid: \d; \} html:is\(\[lang="ru"\], \[lang="uz"\]\) \.nx-mcp-copy\.nx-bleed-panel \{[^}]*\} \}/g) ?? [];
    expect(buckets).toHaveLength(9);
    expect(css).toMatch(/\.nx-mcp-copy\.nx-bleed-panel \.st-mcphero-lead \{ min-height: calc\(var\(--l-lead\) \* 1lh\); \}/);
  });

  it("keeps the phone band's height for the longer ru and uz topics, with and without a clip", () => {
    expect(css).toMatch(/html:is\(\[lang="ru"\], \[lang="uz"\]\) \.nx-auth-band \{ min-height: 268px; \}/);
    expect(css).toMatch(/html:is\(\[lang="ru"\], \[lang="uz"\]\) \.nx-auth-band\[data-clip\] \{ min-height: 308px; \}/);
  });

  it("gives the example card's clip its own label rules", () => {
    expect(siteCss).toMatch(/\.ml-ex\[data-live="true"\] > \.ml-ex-badge\[data-kind="clip"\] \{ display: block; \}/);
  });
});
