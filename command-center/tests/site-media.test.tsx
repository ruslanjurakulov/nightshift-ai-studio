// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { LoopClip } from "@/components/site/LoopClip";
import { dictionaries, LOCALES } from "@/lib/i18n";
import { devDictionaries } from "@/lib/i18n/dev";
import { creditLine, LICENCE, MEDIA, MEDIA_IDS, TILE_FOR_TOOL, TILE_IDS } from "@/lib/site/media";
import { SAMPLES, SLOTS } from "@/components/site/samples";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { SignOffPicture } from "@/components/site/SolutionPictures";

/**
 * The public site's pictures are real stock photographs and footage by Pexels contributors (round 7b). These tests keep
 * the three promises made about them: every picture has a credit in the one data file, nothing is labelled as AI-made or
 * as output of Nightshift, and the repository holds derivatives only.
 */
const ROOT = join(__dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("every picture has a credit", () => {
  it("lists each credited picture once, with a creator, a profile, a source page on Pexels and a Pexels id that is in the source URL", () => {
    expect(MEDIA_IDS.length).toBe(23);
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
      // A wall tile is one 448 px file; every other picture also has a 640 px one for phones.
      if (!(TILE_IDS as readonly string[]).includes(id)) expect(statSync(join(ROOT, "components/site/media", `${id}-sm.webp`)).size, id).toBeGreaterThan(500);
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

  it.each(LOCALES.map((l) => l.code))("%s: the footer lists every credit, with its link, from the one data file", (code) => {
    const t = dictionaries[code];
    const { container } = render(<PublicFooter t={t} />);
    const links = [...container.querySelectorAll(".st-credits li a")] as HTMLAnchorElement[];
    expect(links.map((a) => a.textContent)).toEqual(MEDIA_IDS.map((id) => creditLine(id, t.site.samples.credit)));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(MEDIA_IDS.map((id) => MEDIA[id].sourceUrl));
    for (const a of links) expect(a.getAttribute("rel")).toContain("noopener");
    expect(container.querySelector(".st-credits summary")?.textContent).toBe(t.site.credits.title);
    expect(container.querySelector(".st-credits a[href='https://www.pexels.com/license/']")?.textContent).toBe(t.site.credits.licence);
  });
});

describe("the capability wall", () => {
  it("gives each of eight tools its own credited photograph, and names only tools the studio lists, in every language", () => {
    expect(Object.keys(TILE_FOR_TOOL)).toHaveLength(8);
    expect(new Set(Object.values(TILE_FOR_TOOL)).size).toBe(8);
    for (const { code } of LOCALES) {
      const ids = dictionaries[code].site.studio.tools.map((x) => x.id);
      for (const tool of Object.keys(TILE_FOR_TOOL)) expect(ids, `${code} ${tool}`).toContain(tool);
      expect(dictionaries[code].site.wall.label.length).toBeGreaterThan(15);
    }
    for (const id of TILE_IDS) expect(MEDIA[id].kind).toBe("photo");
  });
});

describe("the publish desk's frame is real footage, labelled and credited", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the frame says it is an example and credits the footage, on the frame and, for a phone, in a caption under it", (code) => {
    const t = dictionaries[code];
    const { container } = render(<SignOffPicture t={t} />);
    const frame = container.querySelector(".st-signoff-frame")!;
    expect(frame.getAttribute("data-clip")).toBe("caravan");
    expect(frame.querySelector(".nx-result-badge[data-kind='still']")?.textContent).toBe(t.site.samples.frameTag);
    expect(frame.querySelector(".nx-result-badge[data-kind='clip']")?.textContent).toBe(t.site.samples.clipTag);
    const credit = creditLine("caravan", t.site.samples.credit);
    expect(frame.querySelector(".nx-result-credit")?.textContent).toBe(credit);
    expect(container.querySelector(".st-signoff-caption")?.textContent).toContain(credit);
    // The flat drawn placeholder is gone.
    expect(container.querySelector(".st-clip-pic")).toBeNull();
  });
});

describe("no label says the pictures are AI-made, and none says they are Nightshift's", () => {
  const AI = /AI[- ]generated|AI[- ]made|made by AI|generated by AI|animated still|нейросет|ИИ-?(?:сгенер|карт|изобр)|оживл[её]нн|sun.iy intellekt|jonlantirilgan|made for this page|Nightshift made|made with Nightshift/i;

  it.each(LOCALES.map((l) => l.code))("%s: the picture labels, notes, alts and credits are plain", (code) => {
    const s = dictionaries[code].site;
    const text = JSON.stringify([s.samples, s.credits, s.caps.demo]);
    expect(text).not.toMatch(AI);
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

describe("only one clip plays at a time", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("plays the clip that shows most of itself and holds the other on its still (two playing at once halved a throttled phone's frames)", () => {
    const entries: { cb: IntersectionObserverCallback; el?: Element }[] = [];
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        i: number;
        constructor(cb: IntersectionObserverCallback) {
          this.i = entries.push({ cb }) - 1;
        }
        observe(el: Element) {
          entries[this.i].el = el;
        }
        disconnect() {}
      },
    );
    const played = new Map<Element, number>();
    const paused = new Map<Element, number>();
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      played.set(this, (played.get(this) ?? 0) + 1);
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
      paused.set(this, (paused.get(this) ?? 0) + 1);
    };
    const { container } = render(
      <div>
        <LoopClip clip="pottery" poster="/a.webp" />
        <LoopClip clip="coast" poster="/b.webp" />
      </div>,
    );
    const [a, b] = [...container.querySelectorAll("video")];
    const see = (el: Element, ratio: number) => act(() => entries.filter((e) => e.el === el).forEach((e) => e.cb([{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry], {} as IntersectionObserver)));
    see(a, 0.3);
    expect(played.get(a)).toBe(1);
    // A second clip that shows more of itself takes over: the first is paused, the second plays.
    see(b, 0.8);
    expect(played.get(b)).toBe(1);
    expect(paused.get(a) ?? 0).toBeGreaterThan(0);
    // One that shows less does not: the leader keeps playing and the other is not started.
    see(a, 0.5);
    expect(played.get(a)).toBe(1);
    expect(played.get(b)).toBe(1);
    // The first takes the lead back when it shows more.
    see(a, 0.95);
    expect(played.get(a)).toBe(2);
    expect(paused.get(b) ?? 0).toBeGreaterThan(0);
  });
});
