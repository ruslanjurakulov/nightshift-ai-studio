// @vitest-environment jsdom
/**
 * Effects on screen: the Studio desk names the model each effect will use here or says it is not open (with a disabled button,
 * never a link), the banner over the composer only reopens the page with the subject, and the public section names no model,
 * links only to sign-up and the Studio form, and moves only while in view and never under reduced motion.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => {
    // next/link's own prop, not an attribute of the anchor.
    delete rest.prefetch;
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));
vi.mock("@/lib/channels-client", () => ({
  useChannelSlug: () => "chronos",
  useChannelPath: () => (p: string) => `/chronos${p}`,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, fmt, type Locale } from "@/lib/i18n";
import { EFFECTS, effectById, publicEffectHref, resolveEffect } from "@/lib/effects/catalog";
import type { StudioModel } from "@/lib/creative/studio";
import { EffectsDesk } from "@/components/effects/EffectsDesk";
import { EffectBanner } from "@/components/effects/EffectBanner";
import { EffectArt } from "@/components/effects/EffectArt";
import { effectSample } from "@/components/effects/EffectFrame";
import { EffectsGallery } from "@/components/site/EffectsGallery";
import { PROVIDER_BRANDS } from "./helpers/brands";

const en = dictionaries.en;
const withI18n = (ui: ReactNode, locale: Locale = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const model = (id: string, name: string, caps: string[], extra: Partial<StudioModel> = {}): StudioModel => ({ id, displayName: name, capabilities: caps, beta: false, ...extra });

const OPERATOR: StudioModel[] = [
  model("minimax-h3", "MiniMax H3", ["t2v", "i2v"], { preview: true }),
  model("runway-gen4.5", "Runway Gen-4.5", ["t2v", "i2v"], { preview: true }),
  model("runway-gen4-turbo", "Runway Gen-4 Turbo", ["i2v"], { preview: true }),
];
const CUSTOMER: StudioModel[] = [model("minimax-hailuo-2.3", "MiniMax Hailuo 2.3", ["t2v", "i2v"], { fixedShape: true }), model("veo-3.1", "Veo 3.1", ["t2v", "i2v"])];

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card = (id: string) => document.querySelector(`[data-effect="${id}"]`) as HTMLElement;
// Which effects have a real sample is data (lib/effects/effects.json previewJobId, checked in effects-catalog.test.ts), so the
// cards are checked against it: a card that showed a sample it does not have, or hid one it has, fails either way.
const SAMPLED = EFFECTS.filter((e) => effectSample(e));
const DRAWN = EFFECTS.filter((e) => !effectSample(e));

/** A card with a sample says so in words and shows that sample's own first frame; a card without one is the drawing and says so. */
function expectFrame(c: HTMLElement, e: (typeof EFFECTS)[number], words: { noSample: string; sample: string }) {
  const s = effectSample(e);
  if (s) {
    expect(within(c).getByText(words.sample), e.id).toBeTruthy();
    expect(within(c).queryByText(words.noSample), e.id).toBeNull();
    expect(c.querySelector(".fx-art"), e.id).toBeNull();
    const poster = c.querySelector(`[data-sample="${s.entry.jobId}"] img`);
    expect(poster, e.id).toBeTruthy();
    // Under vitest an image import is a bare string, so `.src` is undefined (as in site-showcase.test.tsx); next build gives a path.
    expect(poster!.getAttribute("src") ?? null, e.id).toBe(s.files.posterSm ?? null);
  } else {
    expect(within(c).getByText(words.noSample), e.id).toBeTruthy();
    expect(within(c).queryByText(words.sample), e.id).toBeNull();
    expect(c.querySelector(".fx-art")?.getAttribute("aria-hidden"), e.id).toBe("true");
    expect(c.querySelector("[data-sample]"), e.id).toBeNull();
    expect(c.querySelector("video"), e.id).toBeNull();
  }
}

describe("the Studio's Effects desk", () => {
  it("with no model of an effect offered, says so and offers a disabled button, not a link", () => {
    render(withI18n(<EffectsDesk models={[]} />));
    const list = screen.getByRole("list", { name: en.effects.desk.listLabel });
    expect(within(list).getAllByRole("article")).toHaveLength(EFFECTS.length);
    for (const e of EFFECTS) {
      const c = card(e.id);
      expect(c.dataset.state).toBe("unavailable");
      expect(within(c).getByText(en.effects.desk.unavailable)).toBeTruthy();
      expect(within(c).queryByRole("link")).toBeNull();
      const button = within(c).getByRole("button", { name: en.effects.desk.use }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(en.effects.desk.unavailableNote);
    }
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("for the operator, names the preview model each effect will use and links into the Studio form with the effect", () => {
    render(withI18n(<EffectsDesk models={OPERATOR} />));
    for (const e of EFFECTS) {
      const c = card(e.id);
      const a = resolveEffect(e, OPERATOR);
      expect(a.state).toBe("ready");
      if (a.state !== "ready") continue;
      expect(within(c).getByText(new RegExp(a.modelName.replace(/[.]/g, "\\.")))).toBeTruthy();
      expect(c.textContent).toContain(en.effects.desk.preview);
      const link = within(c).getByRole("link", { name: fmt(en.effects.desk.useAria, { name: en.effects.items[e.id].name }) });
      expect(link.getAttribute("href")).toBe(`/chronos/create?tool=${e.capability}&effect=${e.id}`);
    }
    // A card is a link and nothing more: rendering the desk asks nothing of any server.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("for a customer, uses only a model on the effect's own list and says the first choice is not open", () => {
    render(withI18n(<EffectsDesk models={CUSTOMER} />));
    for (const e of EFFECTS) {
      const c = card(e.id);
      expect(c.querySelector("[data-model]")?.getAttribute("data-model")).toBe("minimax-hailuo-2.3");
      expect(c.textContent).not.toContain("Veo");
      expect(c.textContent).toContain(en.effects.desk.nextChoice);
      // That model makes its own shape: a words effect does not claim the shape it would have asked for.
      if (e.input === "none") expect(c.textContent).toContain(en.effects.desk.ownShape);
    }
  });

  it("says on every card, in words, that the moving picture is a drawing until a real sample exists, and which is a real one", () => {
    render(withI18n(<EffectsDesk models={OPERATOR} />));
    for (const e of EFFECTS) expectFrame(card(e.id), e, en.effects);
  });

  it("speaks Russian and Uzbek too", () => {
    for (const locale of ["ru", "uz"] as const) {
      const { unmount } = render(withI18n(<EffectsDesk models={[]} />, locale));
      const d = dictionaries[locale].effects;
      expect(screen.getByRole("list", { name: d.desk.listLabel })).toBeTruthy();
      expect(screen.getAllByText(d.desk.unavailable)).toHaveLength(EFFECTS.length);
      for (const e of EFFECTS) expect(screen.getByRole("heading", { name: d.items[e.id].name })).toBeTruthy();
      unmount();
    }
  });
});

describe("the banner over the composer", () => {
  it("for a words effect, is a GET form back to this page with the effect and the subject, and names the model", () => {
    const giant = effectById("giant-in-the-city")!;
    render(withI18n(<EffectBanner effect={giant} availability={resolveEffect(giant, OPERATOR)} subject="a red fox" />));
    const field = screen.getByLabelText(en.effects.items["giant-in-the-city"].subject!) as HTMLInputElement;
    expect(field.value).toBe("a red fox");
    expect(field.maxLength).toBe(120);
    const form = field.closest("form")!;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/chronos/create");
    const hidden = Object.fromEntries([...form.querySelectorAll<HTMLInputElement>("input[type=hidden]")].map((i) => [i.name, i.value]));
    expect(hidden).toEqual({ tool: "t2v", effect: "giant-in-the-city" });
    expect(screen.getByText(fmt(en.effects.banner.model, { model: "MiniMax H3" }), { exact: false })).toBeTruthy();
    expect(screen.getByText(en.effects.banner.priceNote)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("for a picture effect, asks for the picture in the form below and has no subject field", () => {
    const burst = effectById("product-burst")!;
    render(withI18n(<EffectBanner effect={burst} availability={resolveEffect(burst, OPERATOR)} subject="" />));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(new RegExp(en.effects.banner.pictureHint))).toBeTruthy();
  });

  it("with none of its models open, says nothing was filled and offers only the way back or the plain form", () => {
    const giant = effectById("giant-in-the-city")!;
    render(withI18n(<EffectBanner effect={giant} availability={{ state: "unavailable" }} subject="" />));
    const status = document.querySelector<HTMLElement>('[data-state="unavailable"]')!;
    // Not a live region: it is drawn with the page, so role="status" would announce nothing and only hide the section's name.
    expect(status.getAttribute("role")).toBeNull();
    expect(status.textContent).toContain(en.effects.banner.unavailableBody);
    expect(within(status).queryByRole("textbox")).toBeNull();
    const hrefs = within(status).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/chronos/create?desk=effects", "/chronos/create?tool=t2v"]);
  });
});

describe("the public Effects section", () => {
  it("names no model or maker, in any language, and links only to sign-up and then the Studio form", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      const t = dictionaries[locale];
      const { container, unmount } = render(<EffectsGallery t={t} />);
      expect(container.textContent).not.toMatch(PROVIDER_BRANDS);
      expect(container.innerHTML).not.toMatch(PROVIDER_BRANDS);
      const section = container.querySelector("section#effects")!;
      expect(section.getAttribute("aria-labelledby")).toBe("effects-title");
      const links = within(section as HTMLElement).getAllByRole("link");
      expect(links).toHaveLength(EFFECTS.length);
      EFFECTS.forEach((e, i) => {
        expect(links[i].getAttribute("href")).toBe(publicEffectHref(e));
        expect(links[i].getAttribute("aria-label")).toBe(fmt(t.effects.site.useAria, { name: t.effects.items[e.id].name }));
      });
      // A sample shown here is labelled as one and still names no model or maker (the brand checks above ran with it on the page).
      expect(within(section as HTMLElement).queryAllByText(t.effects.noSample)).toHaveLength(DRAWN.length);
      expect(within(section as HTMLElement).queryAllByText(t.effects.sample)).toHaveLength(SAMPLED.length);
      for (const e of EFFECTS) expectFrame(card(e.id), e, t.effects);
      unmount();
    }
  });

  // The landing's page-wide media counts (tests/public-pages.test.tsx, tests/site-engage*.test.tsx) skip this section
  // (helpers/showcase-scope.ts EFFECTS_SECTION), because how many samples it holds is data. So everything it may show is pinned
  // here instead, with the clips really rendered (a browser that allows motion), not only their posters.
  it("shows only its effects' own samples: one same-origin, lazy, decorative poster and one silent clip each, and no button", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
    // jsdom has no media playback (as in tests/site-engage-5.test.tsx).
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    onTestFinished(() => {
      play.mockRestore();
      pause.mockRestore();
    });
    for (const locale of ["en", "ru", "uz"] as const) {
      const t = dictionaries[locale];
      const { container, unmount } = render(<EffectsGallery t={t} />);
      const section = container.querySelector<HTMLElement>("section#effects")!;
      const imgs = [...section.querySelectorAll("img")];
      expect(imgs).toHaveLength(SAMPLED.length);
      expect(section.querySelectorAll("video")).toHaveLength(SAMPLED.length);
      // No stock picture, no site decoration, no other media, and nothing to press but each card's one link (no pause button:
      // the page's own "Pause motion" switch stops these clips, the owner's rule of 2026-11-13).
      expect(section.querySelectorAll("audio, picture, iframe, [data-art-id], [data-clip], [data-showcase-entry]")).toHaveLength(0);
      expect(section.querySelectorAll("button")).toHaveLength(0);
      for (const img of imgs) expect(img.closest("[data-effect]"), "a picture outside any card").toBeTruthy();
      for (const e of SAMPLED) {
        const s = effectSample(e)!;
        const frame = card(e.id).querySelector<HTMLElement>(".fx-frame")!;
        // The frame names its sample by job id, never a stock id (public-pages reads data-sample as one outside this section).
        expect(frame.getAttribute("data-sample"), e.id).toBe(e.previewJobId);
        const img = frame.querySelector("img")!;
        // Decorative (alt=""): the frame's badge says in words that this is a real result, and the card's heading names the effect.
        expect(img.getAttribute("alt"), e.id).toBe("");
        expect(within(frame).getByText(t.effects.sample)).toBeTruthy();
        expect(img.getAttribute("loading"), e.id).toBe("lazy");
        expect(img.getAttribute("src") ?? "", e.id).not.toMatch(/^(https?:)?\/\//);
        const videos = frame.querySelectorAll("video");
        expect(videos, e.id).toHaveLength(1);
        const v = videos[0];
        expect(v.muted, e.id).toBe(true);
        expect(v.getAttribute("aria-hidden"), e.id).toBe("true");
        expect(v.getAttribute("preload"), e.id).toBe("none");
        const own = Object.values(s.files.clip!);
        const srcs = [...v.querySelectorAll("source")].map((x) => x.getAttribute("src") ?? "");
        expect(srcs.length, e.id).toBeGreaterThan(0);
        for (const src of srcs) {
          expect(own, `${e.id}: ${src} is not its own sample's file`).toContain(src);
          expect(src, e.id).not.toMatch(/^(https?:)?\/\//);
        }
      }
      for (const e of DRAWN) expect(card(e.id).querySelector("img, video"), e.id).toBeNull();
      unmount();
    }
  });

  it("draws each card in its effect's own shape, or its sample's real one, so the grid mixes portrait, square and wide", () => {
    render(<EffectsGallery t={en} />);
    const RATIO = { "16:9": "16 / 9", "9:16": "9 / 16", "1:1": "1 / 1" } as const;
    const shapes = new Set<string>();
    for (const e of EFFECTS) {
      const s = effectSample(e);
      // A sample is never squeezed into the shape the effect asked for: the card takes the clip's own size.
      const want = s ? `${s.entry.width} / ${s.entry.height}` : RATIO[e.aspect];
      expect(card(e.id).querySelector<HTMLElement>(".fx-frame")!.style.aspectRatio, e.id).toBe(want);
      const [w, h] = s ? [s.entry.width, s.entry.height] : e.aspect.split(":").map(Number);
      shapes.add(w > h ? "wide" : w < h ? "portrait" : "square");
    }
    expect(shapes).toEqual(new Set(["portrait", "square", "wide"]));
  });
});

describe("the drawing", () => {
  it("moves only while a fifth of it is on screen", () => {
    let report: (entries: Partial<IntersectionObserverEntry>[]) => void = () => {};
    class IO {
      constructor(cb: (e: Partial<IntersectionObserverEntry>[]) => void) {
        report = cb;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", IO);
    const { container } = render(<EffectArt motif="burst" hues={["#000000", "#ffffff"]} />);
    const art = container.querySelector(".fx-art") as HTMLElement;
    expect(art.dataset.live).toBeUndefined();
    act(() => report([{ isIntersecting: true, intersectionRatio: 0.5 }]));
    expect(art.dataset.live).toBe("on");
    act(() => report([{ isIntersecting: true, intersectionRatio: 0.1 }]));
    expect(art.dataset.live).toBeUndefined();
  });

  it("stays still without IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(<EffectArt motif="globe" hues={["#000000", "#ffffff"]} />);
    expect((container.querySelector(".fx-art") as HTMLElement).dataset.live).toBeUndefined();
  });

  it("is stopped by reduced motion and by the site's Pause motion, in the stylesheet", () => {
    const css = readFileSync(join(__dirname, "..", "components/effects/effects.css"), "utf8");
    expect(css).toContain('.fx-art * { transform-box: fill-box; transform-origin: center; animation-play-state: paused; }');
    expect(css).toContain('.fx-art[data-live="on"] * { animation-play-state: running; }');
    expect(css).toContain('html[data-motion="paused"] .fx-art * { animation-play-state: paused !important; }');
    expect(css).toContain("@media (prefers-reduced-motion: reduce) { .fx-art * { animation: none !important; } }");
  });
});
