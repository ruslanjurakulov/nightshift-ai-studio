// @vitest-environment jsdom
/**
 * Effects on screen: the Studio desk names the model each effect will use here or says it is not open (with a disabled button,
 * never a link), the banner over the composer only reopens the page with the subject, and the public section names no model,
 * links only to sign-up and the Studio form, and moves only while in view and never under reduced motion.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("says on every card, in words, that the moving picture is a drawing until a real sample exists", () => {
    render(withI18n(<EffectsDesk models={OPERATOR} />));
    for (const e of EFFECTS) {
      const c = card(e.id);
      expect(within(c).getByText(en.effects.noSample)).toBeTruthy();
      expect(c.querySelector(".fx-art")?.getAttribute("aria-hidden")).toBe("true");
      expect(c.querySelector("video")).toBeNull();
    }
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
    const status = screen.getByRole("status");
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
      expect(within(section as HTMLElement).getAllByText(t.effects.noSample)).toHaveLength(EFFECTS.length);
      unmount();
    }
  });

  it("draws each card in its effect's own shape, so the grid mixes portrait, square and wide", () => {
    const { container } = render(<EffectsGallery t={en} />);
    const ratios = [...container.querySelectorAll<HTMLElement>(".fx-frame")].map((f) => f.style.aspectRatio);
    expect(new Set(ratios)).toEqual(new Set(["9 / 16", "1 / 1", "16 / 9"]));
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
