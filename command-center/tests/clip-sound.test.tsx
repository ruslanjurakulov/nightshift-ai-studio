// @vitest-environment jsdom
/**
 * Sound on the site's clips (owner decision 2026-11-22: every video on the site is cinematic and has sound), and the playback cap.
 *
 * What would break without these: a speaker toggle on a clip whose files are silent (CLAUDE.md #5: a control that promises sound
 * that is not there); two clips talking over each other; a press on the toggle that also opened the card it sits in or flipped
 * the page's tap-to-pause; a toggle drawn under reduced motion where only the still shows; a grid clip (always the silent 640 file)
 * whose toggle said "on" over silence; more than six clips decoding at once; a card clip starting before the page has loaded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nContext, type I18nContextValue } from "@/lib/i18n/public-context";
import { LoopClip, type ClipSources } from "@/components/site/LoopClip";
import { SoundToggle } from "@/components/site/SoundToggle";
import { StudioClip } from "@/components/site/StudioClip";
import { resetSoundForTests } from "@/lib/site/sound";
import { setMotionPaused } from "@/lib/site/motion";
import { PHONE_TURNS, WIDE_TURNS, pickTurns, type Bid } from "@/components/site/clip-turns";
import { SHOWCASE_ITEMS, showcaseVideo } from "@/lib/showcase/items";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

class IO {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const media = (reduce: boolean) => (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} });

const LABEL = "Clip sound";
const ctx = { locale: "en", t: { site: { samples: { sound: LABEL } } }, fmt: () => "", setLocale: () => undefined, full: false } as unknown as I18nContextValue;
const withDict = (node: ReactNode) => <I18nContext.Provider value={ctx}>{node}</I18nContext.Provider>;

const FILES: ClipSources = { mp4: "/full.mp4", webm: "/full.webm", smMp4: "/sm.mp4", smWebm: "/sm.webm" };
const OTHER: ClipSources = { mp4: "/b.mp4", webm: "/b.webm", smMp4: "/b-sm.mp4", smWebm: "/b-sm.webm" };

let loads: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("matchMedia", media(false));
  vi.stubGlobal("IntersectionObserver", IO);
  loads = vi.fn();
  HTMLMediaElement.prototype.load = loads as unknown as () => void;
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.play = () => Promise.resolve();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetSoundForTests();
  setMotionPaused(false);
});

const toggle = (root: ParentNode) => root.querySelector<HTMLButtonElement>("button.nx-clip-sound");
/** Renders, then lets every clip play: the toggle is drawn only over a clip that is moving (its "playing" event). */
const renderLive = (ui: ReactNode) => {
  const r = render(ui as React.ReactElement);
  act(() => r.container.querySelectorAll("video").forEach((v) => void v.dispatchEvent(new Event("playing"))));
  return r;
};

describe("the speaker toggle", () => {
  it("is absent on a clip without a track: silence is never offered as sound", () => {
    const { container } = renderLive(withDict(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" /></div>));
    expect(container.querySelector("video")).not.toBeNull();
    expect(toggle(container)).toBeNull();
  });

  it("is present on a clip with a track, named in the visitor's language, off, and the clip still starts muted", () => {
    const { container } = renderLive(withDict(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio /></div>));
    const b = toggle(container)!;
    expect(b).not.toBeNull();
    expect(b.getAttribute("type")).toBe("button");
    expect(b.getAttribute("aria-label")).toBe(LABEL);
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("video")!.muted).toBe(true);
  });

  it("aria-pressed follows the sound, and a second press turns it off again", () => {
    const { container } = renderLive(withDict(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio /></div>));
    const v = container.querySelector("video")!;
    fireEvent.click(toggle(container)!);
    expect(toggle(container)!.getAttribute("aria-pressed")).toBe("true");
    expect(v.muted).toBe(false);
    fireEvent.click(toggle(container)!);
    expect(toggle(container)!.getAttribute("aria-pressed")).toBe("false");
    expect(v.muted).toBe(true);
  });

  it("turning one clip's sound on mutes the other: one voice at a time", () => {
    const { container } = renderLive(
      withDict(
        <div>
          <div data-clip="a" id="a"><LoopClip sources={FILES} poster="/a.webp" audio soundKey="a" /></div>
          <div data-clip="b" id="b"><LoopClip sources={OTHER} poster="/b.webp" audio soundKey="b" /></div>
        </div>,
      ),
    );
    const box = (id: string) => container.querySelector(`#${id}`)!;
    const [va, vb] = [box("a").querySelector("video")!, box("b").querySelector("video")!];
    fireEvent.click(toggle(box("a"))!);
    expect(va.muted).toBe(false);
    expect(vb.muted).toBe(true);
    fireEvent.click(toggle(box("b"))!);
    expect(vb.muted).toBe(false);
    expect(va.muted).toBe(true);
    expect(toggle(box("a"))!.getAttribute("aria-pressed")).toBe("false");
    expect(toggle(box("b"))!.getAttribute("aria-pressed")).toBe("true");
  });

  it("a press is the toggle's only: it does not follow the card's link nor reach the page's tap-to-pause", () => {
    const onLink = vi.fn();
    const onDoc = vi.fn();
    document.addEventListener("click", onDoc);
    try {
      const { container } = renderLive(
        withDict(
          <a href="/somewhere" onClick={onLink}>
            <div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio /></div>
          </a>,
        ),
      );
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      act(() => void toggle(container)!.querySelector("svg")!.dispatchEvent(ev));
      expect(ev.defaultPrevented).toBe(true);
      expect(onLink).not.toHaveBeenCalled();
      expect(onDoc).not.toHaveBeenCalled();
      expect(document.documentElement.getAttribute("data-motion")).toBeNull();
      expect(toggle(container)!.getAttribute("aria-pressed")).toBe("true");
    } finally {
      document.removeEventListener("click", onDoc);
    }
  });

  it("its pointerdown does not bubble to the card either, and it is marked for the page's tap handlers to skip", () => {
    const onDown = vi.fn();
    const { container } = renderLive(
      withDict(
        <a href="/somewhere" onPointerDown={onDown}>
          <div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio /></div>
        </a>,
      ),
    );
    const b = toggle(container)!;
    fireEvent.pointerDown(b);
    expect(onDown).not.toHaveBeenCalled();
    expect(b.hasAttribute("data-tap-ignore")).toBe(true);
  });

  it("is a positioned sibling over the clip, above a stretched link overlay", () => {
    const { container } = renderLive(withDict(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio /></div>));
    const b = toggle(container)!;
    expect(b.parentElement).toBe(container.querySelector("video")!.parentElement);
    const css = readFileSync(join(__dirname, "..", "components/site/site-next.css"), "utf8");
    const rule = css.slice(css.indexOf(".nx-clip-sound {"), css.indexOf("}", css.indexOf(".nx-clip-sound {")));
    expect(rule).toMatch(/position: absolute/);
    expect(Number(rule.match(/z-index: (\d+)/)![1])).toBeGreaterThanOrEqual(5);
    expect(rule).toMatch(/width: 44px; height: 44px/);
  });

  it("is not drawn under reduced motion, where the still is all there is", () => {
    vi.stubGlobal("matchMedia", media(true));
    const { container } = renderLive(withDict(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio /></div>));
    expect(container.querySelector("video")).toBeNull();
    expect(toggle(container)).toBeNull();
  });

  it("is not drawn on Save-Data either (no video, no sound)", () => {
    vi.stubGlobal("navigator", { ...navigator, connection: { saveData: true } });
    const { container } = renderLive(withDict(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio /></div>));
    expect(container.querySelector("video")).toBeNull();
    expect(toggle(container)).toBeNull();
  });

  it("draws no unnamed button without a dictionary", () => {
    const { container } = renderLive(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio /></div>);
    expect(container.querySelector("video")).not.toBeNull();
    expect(toggle(container)).toBeNull();
  });

  it("a grid clip (the silent 640 file) switches to its full file, inside the press, when its sound is turned on", () => {
    const { container } = renderLive(withDict(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio together /></div>));
    const v = container.querySelector("video")!;
    const mp4 = () => v.querySelector('source[type="video/mp4"]')!.getAttribute("src");
    expect(mp4()).toBe("/sm.mp4");
    fireEvent.click(toggle(container)!);
    expect(mp4()).toBe("/full.mp4");
    expect(v.querySelector('source[type="video/webm"]')!.getAttribute("src")).toBe("/full.webm");
    expect(loads).toHaveBeenCalledTimes(1);
    expect(v.muted).toBe(false);
  });

  it("a place whose clip sits under other content renders the toggle elsewhere, by the clip's key", () => {
    const { container } = renderLive(
      withDict(
        <div>
          <div data-clip="x" id="box"><LoopClip sources={FILES} poster="/p.webp" audio soundKey="job-1" soundToggle={false} /></div>
          <div id="words"><SoundToggle clip="job-1" /><SoundToggle clip="job-2" /></div>
        </div>,
      ),
    );
    expect(toggle(container.querySelector("#box")!)).toBeNull();
    const words = container.querySelector("#words")!;
    expect(words.querySelectorAll("button.nx-clip-sound")).toHaveLength(1);
    fireEvent.click(toggle(words)!);
    expect(container.querySelector("video")!.muted).toBe(false);
  });

  it("goes away with its clip, so nothing can turn a removed clip's sound on", () => {
    const { container, rerender } = renderLive(withDict(<div><LoopClip sources={FILES} poster="/p.webp" audio soundKey="k" soundToggle={false} /><SoundToggle clip="k" /></div>));
    expect(toggle(container)).not.toBeNull();
    rerender(withDict(<div><SoundToggle clip="k" /></div>));
    expect(toggle(container)).toBeNull();
  });
});

describe("where sound comes from", () => {
  it("a Studio piece offers sound only when its item says so, and the item agrees with the file itself", () => {
    for (const item of SHOWCASE_ITEMS.filter((x) => x.kind === "video")) {
      const bytes = readFileSync(join(__dirname, "..", "public", showcaseVideo(item.slug)));
      // An MP4's audio track is a `trak` whose handler (`hdlr`) is `soun`: the type sits 8 bytes after "hdlr".
      let sound = false;
      for (let at = bytes.indexOf("hdlr"); at >= 0; at = bytes.indexOf("hdlr", at + 4)) if (bytes.toString("latin1", at + 12, at + 16) === "soun") sound = true;
      expect(item.audio === true, item.slug).toBe(sound);
    }
    const duo = renderLive(withDict(<div data-clip="x"><StudioClip slug="language-duo" captionsLabel="English" /></div>));
    expect(toggle(duo.container)).not.toBeNull();
    cleanup();
    const coffee = renderLive(withDict(<div data-clip="x"><StudioClip slug="coffee-pour" captionsLabel="English" /></div>));
    expect(toggle(coffee.container)).toBeNull();
  });

  it("names the toggle in all three languages", () => {
    for (const t of [en, ru, uz]) expect(t.site.samples.sound.trim().length).toBeGreaterThan(0);
    expect(new Set([en.site.samples.sound, ru.site.samples.sound, uz.site.samples.sound]).size).toBe(3);
  });
});

describe("how many clips play", () => {
  const bids = (ratios: number[]) => new Map<string, Bid>(ratios.map((r, i) => [`c${i}`, { ratio: r, want: true }]));

  it("never more than six at once, on a phone or a wide screen", () => {
    expect(WIDE_TURNS).toBe(6);
    expect(PHONE_TURNS).toBeLessThanOrEqual(6);
    expect(pickTurns(bids([1, 1, 1, 1, 1, 1, 1, 1]), WIDE_TURNS).size).toBe(6);
  });

  it("a seventh in view plays only in place of the one least in view", () => {
    const b = bids([0.9, 0.8, 0.95, 0.7, 1, 0.85]);
    const six = pickTurns(b, WIDE_TURNS);
    expect(six.size).toBe(6);
    b.set("new", { ratio: 0.75, want: true });
    const next = pickTurns(b, WIDE_TURNS, six);
    expect(next.has("new")).toBe(true);
    expect(next.has("c3")).toBe(false);
    expect(next.size).toBe(6);
  });

  it("a seventh no more in view than the six waits: none of them stops mid-loop", () => {
    const b = bids([1, 1, 1, 1, 1, 1]);
    const six = pickTurns(b, WIDE_TURNS);
    const m = new Map<string, Bid>([["new", { ratio: 1, want: true }], ...b]);
    const next = pickTurns(m, WIDE_TURNS, six);
    expect(next.has("new")).toBe(false);
    expect([...next].sort()).toEqual([...six].sort());
  });
});

describe("only the first screen's clip may start before the page has loaded", () => {
  // No observer: every box counts as on screen (clip-turns.ts), so the only thing between a clip and play() is whether it is wanted.
  function loudly(ready: "loading" | "complete") {
    vi.stubGlobal("IntersectionObserver", undefined);
    Object.defineProperty(document, "readyState", { configurable: true, get: () => ready });
    const played = vi.fn(() => Promise.resolve());
    HTMLMediaElement.prototype.play = played;
    render(withDict(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" /></div>));
    return played;
  }
  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).readyState;
    vi.useRealTimers();
  });

  it("a card's clip on a loaded page plays at once", () => {
    expect(loudly("complete")).toHaveBeenCalled();
  });

  it("a card's clip on a page still loading waits for the load and an idle moment after it", () => {
    vi.useFakeTimers();
    const played = loudly("loading");
    act(() => void vi.advanceTimersByTime(5000));
    expect(played).not.toHaveBeenCalled();
    act(() => void window.dispatchEvent(new Event("load")));
    expect(played).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1600));
    expect(played).toHaveBeenCalled();
  });
});

describe("a refused audible play", () => {
  // What would break: a browser that refuses to play a clip with its sound on (no press behind that play()) left it standing still
  // under a toggle that said "on".
  it("turns the sound back off and plays on muted", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const tries: boolean[] = [];
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      tries.push(this.muted);
      return this.muted ? Promise.resolve() : Promise.reject(new DOMException("no gesture", "NotAllowedError"));
    };
    const { container } = renderLive(withDict(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio /></div>));
    const v = container.querySelector("video")!;
    fireEvent.click(toggle(container)!);
    expect(v.muted).toBe(false);
    // The page's pause switch, then its release: the play() that follows is not a press's.
    act(() => setMotionPaused(true));
    act(() => setMotionPaused(false));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // It moves again (muted): the toggle is back over it, off.
    act(() => void v.dispatchEvent(new Event("playing")));
    expect(tries).toContain(false);
    expect(v.muted).toBe(true);
    expect(toggle(container)!.getAttribute("aria-pressed")).toBe("false");
    expect(tries[tries.length - 1]).toBe(true);
  });
});

describe("only a real refusal turns the sound off, and the toggle only sits over a moving clip", () => {
  // What would break (Lens 1): an AbortError (a load() or pause() interrupting play(), which says nothing about sound) switched
  // the visitor's sound off.
  it("a play() interrupted with AbortError keeps the sound on", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      return this.muted ? Promise.resolve() : Promise.reject(new DOMException("interrupted", "AbortError"));
    };
    const { container } = renderLive(withDict(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio /></div>));
    const v = container.querySelector("video")!;
    fireEvent.click(toggle(container)!);
    act(() => setMotionPaused(true));
    act(() => setMotionPaused(false));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => void v.dispatchEvent(new Event("playing")));
    expect(v.muted).toBe(false);
    expect(toggle(container)!.getAttribute("aria-pressed")).toBe("true");
  });

  // Lens 2: "sound on" never sits over a still.
  it("is drawn only once the clip plays, and goes when it stops for a turn", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(withDict(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio /></div>));
    const v = container.querySelector("video")!;
    expect(toggle(container)).toBeNull();
    act(() => void v.dispatchEvent(new Event("playing")));
    expect(toggle(container)).not.toBeNull();
  });

  // Lens 3: no load() while the page holds the clip (it would drop the frame the visitor stopped on and fetch the file unseen).
  it("pressed while the page is paused, a grid clip fetches its full file only when it plays again", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = renderLive(withDict(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio together /></div>));
    const v = container.querySelector("video")!;
    const mp4 = () => v.querySelector('source[type="video/mp4"]')!.getAttribute("src");
    act(() => setMotionPaused(true));
    fireEvent.click(toggle(container)!);
    expect(v.muted).toBe(false);
    expect(loads).not.toHaveBeenCalled();
    expect(mp4()).toBe("/sm.mp4");
    act(() => setMotionPaused(false));
    expect(mp4()).toBe("/full.mp4");
    expect(loads).toHaveBeenCalledTimes(1);
  });

  it("a full file that fails to load falls back to the small one with the sound off", () => {
    const { container } = renderLive(withDict(<div data-clip="x"><LoopClip sources={FILES} poster="/p.webp" audio together /></div>));
    const v = container.querySelector("video")!;
    const mp4 = () => v.querySelector('source[type="video/mp4"]')!.getAttribute("src");
    fireEvent.click(toggle(container)!);
    expect(mp4()).toBe("/full.mp4");
    act(() => void v.querySelector("source")!.dispatchEvent(new Event("error")));
    expect(mp4()).toBe("/sm.mp4");
    expect(v.muted).toBe(true);
    expect(toggle(container)!.getAttribute("aria-pressed")).toBe("false");
  });

  // Lens 4: a larger file says whether it carries the track; without that, no sound is offered while it plays.
  it("offers no sound while a larger file without a track plays", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("min-width: 860px"), media: q, addEventListener() {}, removeEventListener() {} }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 2400 } as DOMRect);
    const lg = { ...FILES, lg: { mp4: "/lg.mp4", webm: "/lg.webm" } };
    const silent = renderLive(withDict(<div data-clip="x"><LoopClip sources={lg} poster="/p.webp" audio /></div>));
    expect(silent.container.querySelector('source[type="video/mp4"]')!.getAttribute("src")).toBe("/lg.mp4");
    expect(toggle(silent.container)).toBeNull();
    cleanup();
    const loud = renderLive(withDict(<div data-clip="x"><LoopClip sources={{ ...lg, lg: { ...lg.lg, audio: true } }} poster="/p.webp" audio /></div>));
    expect(toggle(loud.container)).not.toBeNull();
    vi.restoreAllMocks();
  });

  // Lens 6: a decorative backdrop behind the sign-in form never offers sound.
  it("the sign-in and sign-up stages pass sound={false} on every backdrop", () => {
    const src = readFileSync(join(__dirname, "..", "components/auth/AuthShell.tsx"), "utf8");
    const fills = [...src.matchAll(/<PlaceFill [^>]*\/>/g)].map((m) => m[0]);
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect(f).toContain("sound={false}");
  });
});
