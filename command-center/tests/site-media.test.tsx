// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { LoopClip } from "@/components/site/LoopClip";
import { holdClips } from "@/lib/site/clip-hold";
import { setMotionPaused } from "@/lib/site/motion";
import { dictionaries, LOCALES } from "@/lib/i18n";
import { devDictionaries } from "@/lib/i18n/dev";
import { creditLine, LICENCE, MEDIA, MEDIA_IDS } from "@/lib/site/media";
import { SAMPLES, SLOTS, slotMedia } from "@/components/site/samples";
import { stockInUse } from "@/components/site/stock-in-use";
import { EXAMPLE_THUMB_JOB } from "@/components/site/samples";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { SignOffPicture } from "@/components/site/SolutionPictures";

/**
 * The public site's photographs and footage are real stock by Pexels contributors (round 7b). These tests keep the three
 * promises made about them: every one has a credit in the one data file, none is labelled as AI-made or as output of
 * Nightshift, and the repository holds derivatives only. The AI-generated illustrations (lib/site/art.ts) are a separate
 * set with the opposite label, pinned in tests/site-art.test.tsx; the capability wall used to be stock photographs and is
 * now those illustrations.
 */
const ROOT = join(__dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("every picture has a credit", () => {
  it("lists each credited picture once, with a creator, a profile, a source page on Pexels and a Pexels id that is in the source URL", () => {
    expect(MEDIA_IDS.length).toBe(13);
    const ids = new Set<string>();
    for (const id of MEDIA_IDS) {
      const m = MEDIA[id];
      expect(m.creator.length, id).toBeGreaterThan(0);
      expect(m.creatorUrl, id).toMatch(/^https:\/\/www\.pexels\.com\/@[\w-]+\/$/);
      expect(m.sourceUrl, id).toMatch(/^https:\/\/www\.pexels\.com\/(?:photo|video)\//);
      expect(m.sourceUrl, id).toContain(m.pexelsId);
      expect(m.sourceUrl.includes("/video/"), id).toBe(m.kind === "video");
      expect(ids.has(m.pexelsId), `${id} id is unique`).toBe(false);
      ids.add(m.pexelsId);
    }
    expect(LICENCE.url).toBe("https://www.pexels.com/license/");
  });

  it("has a still, a phone-width still and an alt in every language for every credited picture (nothing is shown without its credit)", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...MEDIA_IDS].sort());
    for (const { code } of LOCALES) {
      expect(Object.keys(dictionaries[code].site.samples.alts).sort(), code).toEqual([...MEDIA_IDS].sort());
    }
    for (const id of MEDIA_IDS) {
      expect(statSync(join(ROOT, "components/site/media", `${id}.webp`)).size, id).toBeGreaterThan(1000);
      expect(statSync(join(ROOT, "components/site/media", `${id}-sm.webp`)).size, id).toBeGreaterThan(500);
    }
    for (const slot of Object.values(SLOTS)) expect(MEDIA_IDS).toContain(slot.id);
  });

  it("is documented: docs/design/MEDIA_CREDITS.md names every picture's Pexels id, creator and source page", () => {
    const doc = readFileSync(join(ROOT, "..", "docs/design/MEDIA_CREDITS.md"), "utf8");
    for (const id of MEDIA_IDS) {
      expect(doc, id).toContain(MEDIA[id].pexelsId);
      expect(doc, id).toContain(MEDIA[id].creator);
      expect(doc, id).toContain(MEDIA[id].sourceUrl);
    }
  });

  it.each(LOCALES.map((l) => l.code))("%s: the footer lists the credit of every stock picture a page still shows, with its link, from the one data file (and none once none is shown)", (code) => {
    const t = dictionaries[code];
    const { container } = render(<PublicFooter t={t} />);
    // Round 10: a picture every place of which shows one of our samples is no longer on the site, so it is no longer credited.
    const used = stockInUse();
    const links = [...container.querySelectorAll(".st-credits li a")] as HTMLAnchorElement[];
    expect(links.map((a) => a.textContent)).toEqual(used.map((id) => creditLine(id, t.site.samples.credit)));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(used.map((id) => MEDIA[id].sourceUrl));
    for (const a of links) expect(a.getAttribute("rel")).toContain("noopener");
    expect(container.querySelector(".st-credits summary")?.textContent).toBe(t.site.credits.title);
    const licence = container.querySelector(".st-credits a[href='https://www.pexels.com/license/']");
    if (used.length > 0) {
      expect(licence?.textContent).toBe(t.site.credits.licence);
      expect(container.querySelector(".st-credits")?.textContent).toContain(t.site.credits.lead);
    } else {
      expect(licence).toBeNull();
      expect(container.querySelector(".st-credits")?.innerHTML).not.toMatch(/pexels/i);
      expect(container.querySelector(".st-credits")?.textContent).toContain(t.site.credits.leadNoStock);
    }
  });
});

describe("no stock picture is left on the public site (round 10)", () => {
  it("every slot and every /mcp example card shows one of our samples, so the footer credits no Pexels picture", () => {
    // The owner's goal: our own generations everywhere. A slot or scene whose sample is missing would fall back to stock (and be
    // credited again); this says so the day it happens.
    expect(stockInUse()).toEqual([]);
    for (const slot of Object.keys(SLOTS) as (keyof typeof SLOTS)[]) expect(slotMedia(slot).kind, slot).toBe("ai");
  });
});

describe("the publish desk's frame says what it is, on the frame and, for a phone, under it", () => {
  // The desk's video is titled with the example topic; its frame was a sample of a giant dog in a street, then a still (owner, 2026-11-14).
  it.each(LOCALES.map((l) => l.code))("%s: the frame plays the example topic's own clip, labelled AI-generated on it and again under the drawing, with no stock credit", (code) => {
    const t = dictionaries[code];
    const { container } = render(<SignOffPicture t={t} />);
    const frame = container.querySelector(".st-signoff-frame")!;
    expect(container.querySelector(".st-signoff-title")?.textContent).toBe(t.site.solutions.pictures.signoff.video);
    expect(frame.querySelector("img")?.getAttribute("data-sample-job")).toBe(EXAMPLE_THUMB_JOB);
    expect(frame.getAttribute("data-showcase-entry")).toBe(EXAMPLE_THUMB_JOB);
    expect(frame.getAttribute("data-clip")).toBe("sample");
    expect(frame.querySelector("[data-sample]")).toBeNull();
    expect(frame.querySelector(".nx-result-badge[data-kind='ai']")?.textContent).toBe(t.site.gallery.badge);
    expect(frame.querySelector(".nx-result-credit")).toBeNull();
    expect(container.querySelector(".st-signoff-caption")).toBeNull();
    expect(container.querySelector(".nx-place-credit")?.textContent).toBe(t.site.gallery.badge);
    expect(container.innerHTML).not.toMatch(/pexels/i);
    // The flat drawn placeholder is gone.
    expect(container.querySelector(".st-clip-pic")).toBeNull();
  });
});

describe("no label says the pictures are AI-made, and none says they are Nightshift's", () => {
  const AI = /AI[- ]generated|AI[- ]made|made by AI|generated by AI|animated still|нейросет|ИИ-?(?:сгенер|карт|изобр)|оживл[её]нн|sun.iy intellekt|jonlantirilgan|made for this page|Nightshift made|made with Nightshift/i;

  it.each(LOCALES.map((l) => l.code))("%s: the picture labels, notes, alts and credits are plain", (code) => {
    const s = dictionaries[code].site;
    // The stock pictures' own labels never say AI. The footer's credits do, once, about the illustrations that are NOT stock (lib/site/art.ts): the one sentence allowed to.
    const text = JSON.stringify([s.samples, s.caps.demo]);
    expect(text).not.toMatch(AI);
    expect(s.credits.title + s.credits.licence).not.toMatch(AI);
    expect(s.credits.lead).toMatch(AI);
    const dev = devDictionaries[code].mcp.land.examples;
    expect(JSON.stringify([dev.lead, dev.sample, dev.alts, dev.credit])).not.toMatch(AI);
    // Said plainly: stock photos and footage from Pexels contributors, not output from a real account.
    expect(s.samples.note).toMatch(/Pexels/);
    expect(s.samples.tag).toMatch(code === "en" ? /^Example frame \(stock photo\)$/ : code === "ru" ? /^Пример кадра \(стоковое фото\)$/ : /^Namuna kadr \(stok surat\)$/);
    expect(s.samples.clipTag).toMatch(code === "en" ? /^Example clip \(stock footage\)$/ : code === "ru" ? /^Пример клипа \(стоковое видео\)$/ : /^Namuna klip \(stok video\)$/);
  });

  it("is true of the source too: no component or stylesheet still calls a picture AI-generated or an animated still", () => {
    const files = ["components/site/samples.tsx", "components/site/LoopClip.tsx", "components/site/site-next.css", "components/docs/McpLanding.tsx", "components/docs/SampleFrame.tsx", "components/landing/HeroCard.tsx", "components/landing/Showcases.tsx"];
    for (const f of files) expect(read(f), f).not.toMatch(/AI-generated|animated still/);
  });

  it("names no place except Marrakech, and only on the market photograph", () => {
    for (const { code } of LOCALES) {
      const alts = dictionaries[code].site.samples.alts as Record<string, string>;
      for (const [id, alt] of Object.entries(alts)) {
        const named = /Marrakech|Марракеш|Marrakesh/i.test(alt);
        expect(named, `${code} ${id}`).toBe(id === "market");
        expect(alt, `${code} ${id}`).not.toMatch(/Morocco|Jordan|Wadi|Sahara|Vietnam|England|Brazil|India|Иордан|Сахар|Марокко/i);
      }
    }
  });
});

describe("one shared grade", () => {
  it("is applied to every still and to every frame of every clip by the one script, with a lifted black and warmed highlights", () => {
    const py = read("scripts/make-site-media.py");
    expect(py).toMatch(/^LIFT = 0\.03/m);
    expect(py).toMatch(/^WARM = 0\.035/m);
    const stills = py.slice(py.indexOf("def make_stills"), py.indexOf("# --- clips"));
    const clip = py.slice(py.indexOf("def make_clip"), py.indexOf("def main"));
    expect(stills).toMatch(/im = grade\(/);
    expect(clip).toMatch(/im = grade\(im, sat=p\["sat"\], warm=p\.get\("warm", WARM\)\)/);
    // No encoder or resize step writes a picture that skipped it: the only writers are those two functions.
    expect([...py.matchAll(/\.save\(/g)].length).toBeLessThanOrEqual(6);
  });
});

describe("the repository holds derivatives only", () => {
  it("keeps every still under 130 KB, every clip rendition within its budget, and no original (no file over 500 KB, no jpg or png)", () => {
    const dirs = ["components/site/media", "components/site/clips"];
    for (const dir of dirs) {
      for (const f of readdirSync(join(ROOT, dir))) {
        const size = statSync(join(ROOT, dir, f)).size;
        expect(f, f).toMatch(/\.(webp|mp4|webm)$/);
        expect(size, f).toBeLessThan(500 * 1024);
        if (f.endsWith(".webp")) expect(size, f).toBeLessThan(130 * 1024);
        if (/-sm\.(mp4|webm)$/.test(f)) expect(size, f).toBeLessThanOrEqual(150 * 1024);
        else if (/\.(mp4|webm)$/.test(f)) expect(size, f).toBeLessThanOrEqual(420 * 1024);
      }
    }
  });

  it("does not carry the manifest's local paths or any /home/user path", () => {
    for (const f of ["lib/site/media.ts", "scripts/make-site-media.py"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/\/home\/user\//);
    }
  });
});

describe("every clip on screen plays", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setMotionPaused(false);
  });

  /** Two clips in their boxes, with the two observers each one has: the turn's (no margin) and the preload's (`rootMargin`). */
  function twoClips() {
    const entries: { cb: IntersectionObserverCallback; el?: Element; near: boolean }[] = [];
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width: 767px"), media: q, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        i: number;
        constructor(cb: IntersectionObserverCallback, o?: IntersectionObserverInit) {
          this.i = entries.push({ cb, near: !!o?.rootMargin }) - 1;
        }
        observe(el: Element) {
          entries[this.i].el = el;
        }
        disconnect() {}
        unobserve() {}
      },
    );
    const played = new Map<Element, number>();
    const paused = new Map<Element, number>();
    const loads = vi.fn();
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      played.set(this, (played.get(this) ?? 0) + 1);
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
      paused.set(this, (paused.get(this) ?? 0) + 1);
    };
    HTMLMediaElement.prototype.load = loads;
    const { container } = render(
      <div>
        <div data-clip="pottery">
          <LoopClip clip="pottery" poster="/a.webp" />
        </div>
        <div data-clip="coast">
          <LoopClip clip="coast" poster="/b.webp" />
        </div>
      </div>,
    );
    const [a, b] = [...container.querySelectorAll("video")];
    const fire = (el: Element, near: boolean, ratio: number) =>
      act(() => entries.filter((e) => e.el === el && e.near === near).forEach((e) => e.cb([{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry], {} as IntersectionObserver)));
    const see = (el: Element, ratio: number) => {
      fire(el, true, ratio > 0 ? 1 : 0);
      fire(el, false, ratio);
    };
    const live = (el: Element) => el.parentElement!.getAttribute("data-live") === "true";
    const playing = (el: Element) => act(() => void el.dispatchEvent(new Event("playing")));
    return { a, b, see, fire, live, playing, played, paused, loads };
  }

  // What would break (the owner's report of 2026-11-14): one clip played and every other clip on a phone's screen held a still or a
  // stopped frame, so the page read as frozen. The model grid alone shows three at once on a 390 px phone.
  it("plays every clip that shows at least 35% of itself, together, on a phone too; a sliver below that does not start", () => {
    const { a, b, see, played } = twoClips();
    see(a, 0.6);
    see(b, 0.9);
    expect(played.get(a)).toBe(1);
    expect(played.get(b)).toBe(1);
    cleanup();
    const two = twoClips();
    two.see(two.a, 0.2);
    expect(two.played.get(two.a) ?? 0).toBe(0);
    two.see(two.a, 0.35);
    expect(two.played.get(two.a)).toBe(1);
  });

  // What would break: a clip that scrolled away and back showed the frame it stopped on (readyState 4, paused) while it waited, the
  // "frozen" half of the report; or it started over from frame 0 instead of carrying on.
  it("a clip that leaves pauses and shows its poster again, and resumes from where it was (no reload) the moment it is back", () => {
    const { a, b, see, live, playing, played, paused, loads } = twoClips();
    see(a, 1);
    see(b, 1);
    playing(a);
    playing(b);
    expect(live(a) && live(b)).toBe(true);
    const [pa, pb] = [paused.get(a) ?? 0, paused.get(b) ?? 0];
    see(a, 0);
    expect(paused.get(a) ?? 0).toBeGreaterThan(pa);
    expect(live(a)).toBe(false);
    // The other is untouched: it was never asked to stop.
    expect(live(b)).toBe(true);
    expect(paused.get(b) ?? 0).toBe(pb);
    see(a, 0.8);
    expect(played.get(a)).toBe(2);
    expect(loads).not.toHaveBeenCalled();
  });

  // What would break: a clip that had not been fetched yet (preload="none", readyState 0) came into view as a still and took a
  // second or more to move; or every clip on the page was fetched at load.
  it("starts loading a clip when it comes near the screen, before it may play, and not before", () => {
    const { a, b, fire } = twoClips();
    expect(a.getAttribute("preload")).toBe("none");
    fire(a, true, 1);
    expect(a.getAttribute("preload")).toBe("auto");
    expect(b.getAttribute("preload")).toBe("none");
  });

  // What would break: the page's holds stopped working once more than one clip may play: the visitor's pause switch (WCAG 2.2.2)
  // or the Shorts feed, under which only the feed's clip may decode.
  it("stops every clip under the visitor's pause switch and under the Shorts feed, keeps the frame they stopped on, and carries on after", () => {
    const { a, b, see, live, playing, played, paused } = twoClips();
    see(a, 1);
    see(b, 1);
    playing(a);
    playing(b);
    const before = () => [paused.get(a) ?? 0, paused.get(b) ?? 0];
    const [pa, pb] = before();
    act(() => setMotionPaused(true));
    expect(paused.get(a) ?? 0).toBeGreaterThan(pa);
    expect(paused.get(b) ?? 0).toBeGreaterThan(pb);
    // The visitor stopped them: the frame they stopped on stays, it does not jump back to the poster.
    expect(live(a) && live(b)).toBe(true);
    act(() => setMotionPaused(false));
    expect(played.get(a)).toBe(2);
    expect(played.get(b)).toBe(2);
    const [qa, qb] = before();
    let release = () => {};
    act(() => {
      release = holdClips();
    });
    expect(paused.get(a) ?? 0).toBeGreaterThan(qa);
    expect(paused.get(b) ?? 0).toBeGreaterThan(qb);
    act(() => release());
    expect(played.get(a)).toBe(3);
    expect(played.get(b)).toBe(3);
  });
});
