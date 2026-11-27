// @vitest-environment jsdom
/**
 * The landing's first screen and the clip sound toggle (components/landing/home/HomeHero.tsx). Its picture box is aria-hidden and
 * sits under the words, so the clip there draws no toggle of its own; the hero renders one outside the box, above the pause switch.
 *
 * What would break: a toggle inside the aria-hidden box (no screen reader reaches it, the words cover it from a pointer); or a
 * toggle on the hero while its clip is silent (CLAUDE.md #5). The hero clip has no sound today, so it draws none.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { I18nContext, type I18nContextValue } from "@/lib/i18n/public-context";
import { HomeHero } from "@/components/landing/home/HomeHero";
import { HERO_JOB } from "@/components/landing/home/home-reel";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { resetSoundForTests } from "@/lib/site/sound";
import { en } from "@/lib/i18n/en";

class IO {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const ctx = { locale: "en", t: en, fmt: () => "", setLocale: () => undefined, full: true } as unknown as I18nContextValue;
const withDict = (node: ReactNode) => <I18nContext.Provider value={ctx}>{node}</I18nContext.Provider>;
const clip = SHOWCASE_FILES[HERO_JOB]?.clip as { audio?: true } | null | undefined;

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("IntersectionObserver", IO);
  HTMLMediaElement.prototype.load = () => undefined;
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.play = () => Promise.resolve();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetSoundForTests();
  if (clip) delete clip.audio;
});

function hero() {
  const r = render(withDict(<HomeHero t={en} />));
  act(() => r.container.querySelectorAll("video").forEach((v) => void v.dispatchEvent(new Event("playing"))));
  return r.container;
}

describe("the hero's sound toggle", () => {
  it("the hero has a clip to test against", () => {
    expect(clip).toBeTruthy();
  });

  it("is absent while the hero clip is silent (every sample today)", () => {
    const c = hero();
    expect(c.querySelector("video")).not.toBeNull();
    expect(c.querySelector("button.nx-clip-sound")).toBeNull();
  });

  it("appears outside the aria-hidden picture, with its own place, when the hero clip has sound", () => {
    clip!.audio = true;
    const c = hero();
    const buttons = c.querySelectorAll("button.nx-clip-sound");
    expect(buttons).toHaveLength(1);
    const b = buttons[0] as HTMLButtonElement;
    expect(b.closest("[aria-hidden='true']")).toBeNull();
    expect(b.classList.contains("hm-hero-sound")).toBe(true);
    expect(b.getAttribute("aria-label")).toBe(en.site.samples.sound);
    // Not inside the picture's box: the box draws none of its own.
    expect(c.querySelector(".hm-hero-media button")).toBeNull();
  });

  it("sits stacked above the bottom-right pause switch, clear of it", () => {
    const css = readFileSync(join(__dirname, "..", "components/landing/home/home.css"), "utf8");
    const pause = Number(css.match(/\.hm-hero \.nx-motion \{[^}]*bottom: (\d+)px/)![1]);
    const sound = Number(css.match(/\.hm-hero \.hm-hero-sound \{[^}]*bottom: (\d+)px/)![1]);
    expect(sound).toBeGreaterThanOrEqual(pause + 44);
  });
});
