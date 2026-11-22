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
import { CLIPS, SAMPLES, SLOTS, slotMedia } from "@/components/site/samples";
import { placeLabelProblems } from "./helpers/showcase-scope";
import { SCENE_SAMPLE } from "@/components/docs/SampleFrame";
import { MEDIA, MEDIA_IDS } from "@/lib/site/media";
import { setMotionPaused } from "@/lib/site/motion";
import { HERO_JOB } from "@/components/site/slots";

const ROOT = join(__dirname, "..");
const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");
const siteCss = readFileSync(join(ROOT, "components/site/site.css"), "utf8");
const homeCss = readFileSync(join(ROOT, "components/landing/home/home.css"), "utf8");

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
  // The first screen the owner kept (components/landing/home/HomeHero.tsx, 2026-11-22): our own Studio clip edge to edge (orbit, the
  // night city, the steaming street stall), behind the headline, one line and the idea bar, centred (kling.ai's style, same day).
  it.each(LOCALES.map((l) => l.code))("%s: the first screen is our own Studio clip edge to edge, then the headline, one line and the idea bar; the picture is labelled AI-generated", (code) => {
    env();
    const h = dictionaries[code].landingHome.hero;
    const { container } = landing(code);
    const hero = container.querySelector("section.hm-hero")!;
    // Dark whatever the page's theme: the words sit on a night picture.
    expect(hero.getAttribute("data-theme-scope")).toBe("dark");
    const media = hero.firstElementChild!;
    expect(media.matches(".hm-hero-media")).toBe(true);
    const img = media.querySelector("img")!;
    expect(img.getAttribute("loading")).not.toBe("lazy");
    expect(img.getAttribute("fetchpriority")).toBe("high");
    expect(img.getAttribute("data-sample-job")).toBe(HERO_JOB);
    expect(img.hasAttribute("data-sample")).toBe(false);
    expect(hero.querySelector(".hm-hero-credit .hm-badge")?.textContent).toBe(h.ai);
    const copy = hero.querySelector(".hm-hero-body")!;
    expect(copy.querySelector("h1")?.textContent).toBe(h.title);
    expect(copy.querySelector(".hm-hero-sub")?.textContent).toBe(h.subline);
    expect(copy.querySelector("form.hm-idea")).toBeTruthy();
    expect(copy.querySelectorAll("a")).toHaveLength(0);
    // No old backdrop, no old prompt bar and no second copy of the picture on the first screen.
    expect(container.querySelector(".nx-hero-bg, .nx-hero-bleed, .nx-hero-visual, .nx-sh, form.nx-pbar")).toBeNull();
  });

  it("veils the clip under the words: at least 0.72 black across the centred words on a wide screen, 0.78 everywhere on a phone", () => {
    // Measured over all 20 frames of the clip (4 a second) with the words made transparent, at 1440, 1024 and 390 px: the title,
    // the line, the field and the note hold their ratios over the brightest frame (the orbit's cloud, the neon street).
    const veil = homeCss.match(/\.hm-hero-veil \{[^}]*\}/)![0];
    const centre = veil.match(/radial-gradient\(ellipse [^,]+, ([^)]+\)[^)]*\)[^)]*\)[^)]*\))/)![0];
    const stops = [...centre.matchAll(/rgb\(7 10 20 \/ ([\d.]+)\) (\d+)%/g)].map((x) => [Number(x[1]), Number(x[2])]);
    // The words sit inside the first 60% of the ellipse.
    expect(stops).toEqual([[0.8, 0], [0.72, 60], [0, 100]]);
    expect(stops.filter(([, at]) => at <= 60).every(([a]) => a >= 0.72)).toBe(true);
    // Under everything, a wash: the picture outside the ellipse (the label's corner) is never bare.
    expect(veil).toMatch(/rgb\(7 10 20 \/ 0\.[3-9]\d*\);\s*\}/);
    const narrow = homeCss.match(/@media \(max-width: 640px\) \{\s*\.hm-hero-veil \{[^}]*\}/)![0];
    const phone = [...narrow.matchAll(/rgb\(7 10 20 \/ ([\d.]+)\)/g)].map((x) => Number(x[1]));
    expect(phone.length).toBeGreaterThan(0);
    expect(phone.every((a) => a >= 0.78)).toBe(true);
  });

  it("keeps the first screen dark in both themes, with a veil under the words that is never lighter than 0.62 black under the text", () => {
    expect(css).toMatch(/\.nx-hero\.nx-sh \{[^}]*background: #07070a; color: #fff;/);
    const veil = css.match(/\.nx-sh-media::after \{[^}]*\}/)![0];
    const stops = [...veil.matchAll(/rgba\(5, 5, 9, ([\d.]+)\)/g)].map((x) => Number(x[1]));
    // The first stop is the sky above the words; every stop from 30% down sits behind text.
    expect(stops.slice(1).every((a) => a >= 0.62)).toBe(true);
  });

  it("keeps the panel dark in both themes, and the stock clip a pixel smaller than its still where the footage is a panel (/mcp's header)", () => {
    expect(css).toMatch(/\.nx-hero-top \{[^}]*background: #0b0a09; color: #fff;/);
    expect(css).toMatch(/\.nx-bleed \.nx-clip \{ left: 3px; width: calc\(100% - 6px\);/);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the page's own pause switch (on the first screen's picture, visually hidden until a keyboard focuses it) stops the footage, and the picture panels' 44 px pause button keeps its rules (/mcp's header is still one)", (code) => {
    env();
    const t = dictionaries[code];
    const { container } = landing(code);
    // The first screen always carries it (components/landing/home/HomeHero.tsx): its clip moves, and so does the page under it.
    const sw = container.querySelector("section.hm-hero .nx-motion-btn") as HTMLButtonElement;
    expect(container.querySelectorAll(".nx-motion-btn")).toHaveLength(1);
    expect(sw.textContent).toBe(t.site.fx.pause);
    expect(sw.getAttribute("aria-pressed")).toBe("false");
    act(() => sw.click());
    expect(sw.getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.getAttribute("data-motion")).toBe("paused");
    act(() => setMotionPaused(false));
    expect(sw.getAttribute("aria-pressed")).toBe("false");
    // Visually hidden until focused (no visible pause word or icon, owner 2026-11-13), still in the tab order and to screen readers;
    // focused: 44 px with a visible focus ring, in the first screen's bottom right corner (where kling.ai keeps its sound key), the
    // AI label bottom left; under reduced motion it is gone with the video.
    expect(sw.querySelector("svg")).toBeNull();
    expect(homeCss).toMatch(/\.hm-hero \.nx-motion \{ position: absolute; top: auto; right: var\(--hm-gutter\); bottom: \d+px; \}/);
    expect(homeCss).toMatch(/\.hm-hero-credit \{\s*position: absolute;\s*left: var\(--hm-gutter\);\s*bottom: 16px;/);
    expect(css).toMatch(/\.nx-motion-btn:not\(:focus-visible\), \.nx-clip-pause:not\(:focus-visible\) \{ position: absolute; width: 1px; height: 1px;[^}]*clip: rect\(0 0 0 0\);/);
    expect(css).toMatch(/\.nx-motion-btn:focus-visible \{[^}]*outline: 3px solid #ffa940;/);
    expect(css).toMatch(/\.nx-bleed \.nx-clip-pause \{ top: 12px; right: 12px; bottom: auto; z-index: 3; \}/);
    expect(css).toMatch(/\.nx-clip-pause \{[^}]*min-width: 44px; min-height: 44px;/);
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

  // Round 9 dropped the first of three (a still photograph); 2026-11-22 the other two (the first screen and the autopilot say theirs).
  it("draws none of the full-width showcases on the landing any more", () => {
    env();
    const { container } = landing();
    expect(container.querySelectorAll("section.nx-show")).toHaveLength(0);
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
    const { container } = render(<ChatCard copy={chatCopy(t, "hero", undefined, { note: t.site.stage.bareNote })} bare />);
    const card = container.querySelector("figure.nx-chat")!;
    expect(card.querySelector("img, video, svg[data-art], .nx-result-art")).toBeNull();
    expect(card.querySelector(".nx-ui-status")).toBeTruthy();
    expect(card.querySelector(".nx-chat-key")?.closest("[aria-hidden]")).toBeTruthy();
    // With no picture it says what the card is, never what a picture is (round 10: the landing's "How it works" card).
    expect(card.querySelector("figcaption")?.textContent).toBe(t.site.stage.bareNote);
    expect(t.site.stage.bareNote).not.toMatch(/stock|Pexels/i);
  });

  it("makes the drawn key dashed and unfilled everywhere, so it cannot be read as a second button", () => {
    expect(css).toMatch(/\.nx-chat-key \{[^}]*border: 1px dashed var\(--ns-amber\); background: transparent;/);
    expect(css).toMatch(/@keyframes nx-key \{ from \{ border-color: var\(--ns-rule-strong\); color: var\(--ns-text-dim\); \} \}/);
  });
});

describe("clips on /signup, /mcp and the examples (round 9)", () => {
  it("gives the sign-up stage the floating lanterns, /mcp's header the cloud sea and its sixth example card the caravan, each reusing a clip from another page", () => {
    // The stock fallbacks, kept until a sample fills each place (components/site/samples.tsx `ai`).
    expect(SLOTS["auth.signup"]).toMatchObject({ id: "floating", clip: "floating" });
    expect("clip" in SLOTS["auth.login"]).toBe(false);
    expect(SLOTS["mcp.hero"]).toMatchObject({ id: "cloud", clip: "cloud" });
    expect(SCENE_SAMPLE.dunes).toMatchObject({ id: "caravan", clip: "caravan" });
    expect(Object.values(SCENE_SAMPLE).filter((s) => "clip" in s && s.clip)).toHaveLength(1);
    const shell = readFileSync(join(ROOT, "components/auth/AuthShell.tsx"), "utf8");
    expect(shell).toMatch(/<PlaceFill media=\{m\}/);
    expect(shell).toMatch(/\{moving && <ClipPause label=\{t\.site\.fx\.pause\} \/>\}/);
    expect(shell).toMatch(/\{\.\.\.placeBox\(m\)\}/);
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
    // The /pricing card and the publish desk sit beside the example topic and play its own clip (tests/site-art.test.tsx pins
    // which); both frames are never wider than about 560 px, so both take the 640 px file on any screen.
    const pricing = readFileSync(join(ROOT, "components/pricing/PricingView.tsx"), "utf8");
    expect(pricing).toMatch(/<ChatCard copy=\{chatCopy\(t\)\} compactClip \/>/);
    expect(readFileSync(join(ROOT, "components/site/SolutionPictures.tsx"), "utf8")).toMatch(/<PlaceFill media=\{m\} s=\{t\.site\} alt="" compact /);
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
