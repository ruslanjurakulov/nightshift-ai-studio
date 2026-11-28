// @vitest-environment jsdom
/**
 * The Studio start's media-first look (W2-HOME). What would break without these: the template gallery going back to small rows
 * with no picture; a gallery that downloads and plays every preview at once (a phone with a dozen decoders, megabytes before
 * anything is touched); a clip that plays under prefers-reduced-motion; a tile whose link stops opening the template's own Create
 * address; more than one clip per row or more than four on the page; the hero drawing anything but our own template posters; a
 * "Not available yet" row left on the page in front of a customer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}`, useChannelSlug: () => "chronos" }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { ShellProvider } from "@/components/shell/ShellContext";
import { StartBox } from "@/components/prompt/StartBox";
import { StudioHome } from "@/components/studio/StudioHome";
import { HERO_SLUGS, heroPosters } from "@/components/studio/StudioHero";
import { MAX_PLAYING, aspectCss, pickPlaying, resetPlay } from "@/lib/templates/tile-play";
import { templateCreateHref, type TemplateDto } from "@/lib/templates/trends";
import type { ToolAvailability } from "@/lib/tool-availability";

const t = dictionaries.en;
const UNKNOWN_START = { video: null, image: null, audio: null, edit: null } as never;

const tpl = (slug: string, over: Partial<TemplateDto> = {}): TemplateDto =>
  ({
    slug,
    title: `T ${slug}`,
    category: "story",
    kind: "video",
    aspect: "9:16",
    duration_s: 10,
    prompt: "A {thing}",
    model_status: "available",
    poster_url: `/templates/${slug}/poster.webp`,
    preview_url: `/templates/${slug}/preview.mp4`,
    ...over,
  }) as unknown as TemplateDto;

// ── the browser this page is drawn in ────────────────────────────────────────
let reduced = false;
let touch = false;
type IoCb = (entries: Array<{ intersectionRatio: number; target: Element }>) => void;
let observers: Array<{ cb: IoCb; els: Element[] }> = [];
let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reduced = false;
  touch = false;
  observers = [];
  resetPlay();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((q: string) => ({
      matches: q.includes("reduce") ? reduced : q.includes("hover: none") ? touch : false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      rec: { cb: IoCb; els: Element[] };
      constructor(cb: IoCb) {
        this.rec = { cb, els: [] };
        observers.push(this.rec);
      }
      observe(el: Element) {
        this.rec.els.push(el);
      }
      disconnect() {}
      unobserve() {}
    },
  );
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: play });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: pause });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ templates: [tpl("story-one"), tpl("wide-two", { aspect: "16:9" }), tpl("logo-three", { kind: "image", aspect: "1:1", preview_url: undefined })] }), { status: 200 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Scrolls a tile to `ratio` on screen (what IntersectionObserver would report). */
function show(slug: string, ratio: number) {
  const el = document.querySelector(`[data-template="${slug}"] .sb-card-frame`)!;
  const o = observers.find((x) => x.els.includes(el));
  expect(o).toBeTruthy();
  act(() => o!.cb([{ intersectionRatio: ratio, target: el }]));
}

function drawBox() {
  return render(
    <I18nProvider locale="en">
      <StartBox agentOpen={false} available={UNKNOWN_START} channel={null} />
    </I18nProvider>,
  );
}

/** The box with its gallery loaded and every tile's effects run (the hover and visibility listeners attach in an effect). */
async function drawLoaded() {
  drawBox();
  await screen.findByText("T story-one");
  await act(async () => {});
}

const tile = (slug: string) => document.querySelector(`[data-template="${slug}"]`) as HTMLElement;

describe("the template gallery", () => {
  it("draws one big media tile per template, poster first, at the template's own shape, with the title and its meta over it", async () => {
    await drawLoaded();
    for (const slug of ["story-one", "wide-two", "logo-three"]) {
      const img = tile(slug).querySelector(".sb-card-frame img") as HTMLImageElement;
      expect(img.getAttribute("src")).toBe(`/templates/${slug}/poster.webp`);
      expect(img.getAttribute("loading")).toBe("lazy");
    }
    expect((tile("story-one").querySelector(".sb-card-frame") as HTMLElement).style.aspectRatio).toBe("9 / 16");
    expect((tile("wide-two").querySelector(".sb-card-frame") as HTMLElement).style.aspectRatio).toBe("16 / 9");
    // Title and "Video · 9:16 · 10 s" live inside the picture's frame, not in a row beside a thumbnail.
    const body = tile("story-one").querySelector(".sb-card-frame .sb-card-body")!;
    expect(body.textContent).toContain("T story-one");
    expect(body.textContent).toContain(`${t.startBox.library.kind.video} · 9:16 · `);
  });

  it("keeps every tile the same link it was: the template's own Create address", async () => {
    await drawLoaded();
    expect(tile("story-one").tagName).toBe("A");
    expect(tile("story-one").getAttribute("href")).toBe(`/chronos${templateCreateHref("story-one")}`);
    expect(tile("wide-two").getAttribute("href")).toBe(`/chronos${templateCreateHref("wide-two")}`);
  });

  it("fetches no clip until a tile is pointed at: posters only, no <video> in the page", async () => {
    await drawLoaded();
    expect(document.querySelectorAll("video")).toHaveLength(0);
    expect(play).not.toHaveBeenCalled();
  });

  it("on a pointer screen plays the hovered tile's preview, muted and looped, and stops when the pointer leaves", async () => {
    await drawLoaded();
    fireEvent.pointerEnter(tile("story-one"), { pointerType: "mouse" });
    const v = tile("story-one").querySelector("video") as HTMLVideoElement;
    expect(v).toBeTruthy();
    expect(v.getAttribute("src")).toBe("/templates/story-one/preview.mp4");
    expect(v.muted).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.hasAttribute("playsinline")).toBe(true);
    expect(v.getAttribute("preload")).toBe("auto");
    expect(play).toHaveBeenCalled();
    expect(tile("story-one").querySelector("[data-active]")).toBeTruthy();
    // The other tile was not pointed at: nothing of it is fetched.
    expect(tile("wide-two").querySelector("video")).toBeNull();
    fireEvent.pointerLeave(tile("story-one"));
    expect(pause).toHaveBeenCalled();
    expect(tile("story-one").querySelector("[data-active]")).toBeNull();
    expect(v.getAttribute("preload")).toBe("none");
  });

  it("keyboard focus plays it like a hover", async () => {
    await drawLoaded();
    fireEvent.focusIn(tile("wide-two"));
    expect(tile("wide-two").querySelector("video")).toBeTruthy();
    expect(play).toHaveBeenCalled();
  });

  it("on a touch screen plays a tile only once at least 60% of it is on screen", async () => {
    touch = true;
    await drawLoaded();
    show("story-one", 0.4);
    expect(tile("story-one").querySelector("video")).toBeNull();
    show("story-one", 0.7);
    expect(tile("story-one").querySelector("video")).toBeTruthy();
    expect(play).toHaveBeenCalled();
    show("story-one", 0.1);
    expect(pause).toHaveBeenCalled();
    expect(tile("story-one").querySelector("[data-active]")).toBeNull();
  });

  it("never plays under prefers-reduced-motion: hovered, focused or fully on screen, the poster is all there is", async () => {
    reduced = true;
    touch = true;
    await drawLoaded();
    fireEvent.pointerEnter(tile("story-one"), { pointerType: "mouse" });
    fireEvent.focusIn(tile("wide-two"));
    // Not even observed: being seen cannot ask to play.
    expect(observers).toHaveLength(0);
    expect(document.querySelectorAll("video")).toHaveLength(0);
    expect(play).not.toHaveBeenCalled();
  });

  it("an image template has no clip to play", async () => {
    await drawLoaded();
    fireEvent.pointerEnter(tile("logo-three"), { pointerType: "mouse" });
    expect(tile("logo-three").querySelector("video")).toBeNull();
  });
});

describe("which tiles may play", () => {
  it("one per visual row, the most visible first, and never more than four on the page", () => {
    const row = (top: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${top}-${i}`, top: top + i * 3, left: i * 200, ratio: 0.6 + i * 0.1 }));
    const got = pickPlaying([...row(0, 2), ...row(300, 2), ...row(600, 2), ...row(900, 2), ...row(1200, 2)]);
    expect(got.size).toBe(MAX_PLAYING);
    // In each row the more visible (the second) one wins, and no row has two.
    for (const top of [0, 300, 600, 900]) expect(got.has(`r${top}-1`) && !got.has(`r${top}-0`)).toBe(true);
  });

  it("a hovered tile wins its row over a more visible one", () => {
    const got = pickPlaying([
      { id: "seen", top: 0, left: 0, ratio: 1 },
      { id: "hovered", top: 10, left: 300, ratio: 2 },
    ]);
    expect([...got]).toEqual(["hovered"]);
  });

  it("reserves the template's shape before the poster loads, 16:9 for anything it cannot read", () => {
    expect(aspectCss("9:16")).toBe("9 / 16");
    expect(aspectCss("1:1")).toBe("1 / 1");
    expect(aspectCss("wide")).toBe("16 / 9");
    expect(aspectCss(null)).toBe("16 / 9");
  });
});

describe("the Studio start's hero", () => {
  const NONE: ToolAvailability = { state: "known", sold: [] };
  const homeWith = (tools: ToolAvailability) =>
    render(
      <I18nProvider locale="en">
        <ShellProvider operator={false} tools={tools}>
          <StudioHome orgId={null} models={[]} credits={{ state: "unknown" }} projects={{ state: "not_available" }} />
        </ShellProvider>
      </I18nProvider>,
    );

  it("fans our own template posters over the headline, never stock art", () => {
    homeWith(NONE);
    const fan = screen.getByTestId("studio-hero-fan");
    expect(fan.getAttribute("aria-hidden")).toBe("true");
    const srcs = [...fan.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs.length).toBeGreaterThanOrEqual(3);
    expect(srcs.length).toBeLessThanOrEqual(5);
    expect(srcs).toEqual(heroPosters());
    for (const s of srcs) expect(s).toMatch(/^\/templates\/[a-z0-9-]+\/poster\.webp$/);
    expect(heroPosters()).toHaveLength(HERO_SLUGS.length);
    // The headline is the page's one h1, from the dictionary.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(t.studioHome.title);
  });

  it("draws no 'Not available yet' row anywhere on the page when nothing is on sale", () => {
    homeWith(NONE);
    expect(screen.getByTestId("studio-home").textContent).not.toContain(t.availability.notYet);
    expect(document.querySelector('[data-unavailable="true"]')).toBeNull();
  });
});
