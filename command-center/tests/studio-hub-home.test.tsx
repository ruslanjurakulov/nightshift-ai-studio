// @vitest-environment jsdom
/**
 * Nightshift Studio's home (/{channel}/studio) and the one-line "moved" notice.
 *
 * What would break without these: Brand look more than one click from where its old bookmark lands;
 * the Videos shelf not opening from `?shelf=videos` (where /videos now redirects); a customer shown
 * an operator-only tile (Pipeline) or a switched-off one (Ads); a notice that cannot be dismissed, or
 * one that shows on a video's own page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

let pathname = "/chronos/studio";
let search = "";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, scroll: _s, ...rest }: { href: string; children: ReactNode; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/i18n/server", async () => {
  const { dictionaries } = await import("@/lib/i18n");
  return { getDictionary: async () => ({ t: dictionaries.en, locale: "en" }) };
});
// The shelves read the database; here they only need to say which one was drawn.
vi.mock("@/components/studio-hub/VideosShelf", () => ({ VideosShelf: () => <div data-shelf="videos" /> }));
vi.mock("@/components/studio-hub/ProjectsShelf", () => ({ ProjectsShelf: () => <div data-shelf="projects" /> }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { ShellProvider } from "@/components/shell/ShellContext";
import { StudioTiles } from "@/components/studio-hub/StudioTiles";
import { StudioMovedNotice, movedSectionFor } from "@/components/studio-hub/StudioMovedNotice";

const en = dictionaries.en;

function wrap(ui: ReactNode, operator = false, features = { adsFactory: false, characterStudio: false }) {
  return (
    <I18nProvider locale="en">
      <ShellProvider operator={operator} features={features}>
        {ui}
      </ShellProvider>
    </I18nProvider>
  );
}

beforeEach(() => {
  pathname = "/chronos/studio";
  search = "";
  window.localStorage.clear();
});
afterEach(cleanup);

async function page(sp: Record<string, string> = {}) {
  const { default: StudioHome } = await import("../app/(app)/[channel]/studio/page");
  return renderToStaticMarkup(wrap(await StudioHome({ searchParams: Promise.resolve(sp) })));
}

describe("Studio home", () => {
  it("is titled with the brand, and Brand look is one click away: the Channel look chip", async () => {
    const html = await page();
    expect(html).toContain(">Nightshift Studio<");
    expect(html).toMatch(/href="\/chronos\/studio\/look"[^>]*data-testid="channel-look-chip"/);
    expect(html).toContain(en.studioHub.channelLook);
  });

  it("opens on the Projects shelf, and on Videos from ?shelf=videos (where /videos redirects)", async () => {
    const projects = await page();
    expect(projects).toContain('data-shelf="projects"');
    expect(projects).not.toContain('data-shelf="videos"');
    expect(projects).toMatch(/aria-current="page"[^>]*data-testid="studio-shelf-projects"/);
    const videos = await page({ shelf: "videos", moved: "videos" });
    expect(videos).toContain('data-shelf="videos"');
    expect(videos).toMatch(/aria-current="page"[^>]*data-testid="studio-shelf-videos"/);
  });

  it("names the shelf 'Projects' in every language, never a film or a long video", () => {
    expect(dictionaries.en.studioHub.shelfProjects).toBe("Projects");
    expect(dictionaries.ru.studioHub.shelfProjects).toBe("Проекты");
    expect(dictionaries.uz.studioHub.shelfProjects).toBe("Loyihalar");
    for (const loc of ["en", "ru", "uz"] as const) {
      const text = JSON.stringify(dictionaries[loc].studioHub).toLowerCase();
      expect(text, loc).not.toMatch(/\bfilm|фильм|long video|длинн|uzun video/);
      expect(dictionaries[loc].studioHub.title).toBe("Nightshift Studio");
    }
  });
});

describe("Studio home tiles", () => {
  const keys = () => Array.from(document.querySelectorAll("[data-studio-tile]")).map((a) => a.getAttribute("data-studio-tile"));

  it("give a customer every creative tool plus the old hub tabs, and never an operator-only screen", () => {
    render(wrap(<StudioTiles />));
    expect(keys()).toEqual(["create", "library", "editor", "workflows", "styles", "presets", "brandLook", "inbox", "series", "models"]);
    expect(document.querySelector('[data-studio-tile="pipeline"]')).toBeNull();
  });

  it("give the operator Pipeline too, and not the channel screens their rail already lists", () => {
    render(wrap(<StudioTiles />, true));
    expect(keys()).toEqual(["create", "library", "editor", "workflows", "styles", "presets", "brandLook", "pipeline"]);
    expect(screen.getByRole("link", { name: new RegExp(en.nav.pipeline) }).getAttribute("href")).toBe("/chronos/pipeline");
  });

  it("list a switched section only while its switch is on", () => {
    render(wrap(<StudioTiles />, false, { adsFactory: true, characterStudio: true }));
    expect(keys()).toContain("ads");
    expect(keys()).toContain("characterStudio");
  });

  it("are links only: no tile names a price or a credit", () => {
    render(wrap(<StudioTiles />, true));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bcr\b|credit|\d+\s*(кр|kr)/i);
    for (const a of within(document.body).getAllByRole("link")) expect(a.getAttribute("href")).toMatch(/^\/chronos\//);
  });
});

describe("the 'moved' notice", () => {
  it("knows which screens moved, and stays off a video's or a project's own page", () => {
    expect(movedSectionFor("/chronos/styles", null)).toBe("styles");
    expect(movedSectionFor("/chronos/create", null)).toBe("create");
    expect(movedSectionFor("/chronos/studio/look", null)).toBe("look");
    expect(movedSectionFor("/chronos/studio", "videos")).toBe("videos");
    expect(movedSectionFor("/chronos/studio", "<script>")).toBeNull();
    expect(movedSectionFor("/chronos/studio", null)).toBeNull();
    expect(movedSectionFor("/chronos/videos/abc", null)).toBeNull();
    expect(movedSectionFor("/chronos/editor/abc", null)).toBeNull();
    expect(movedSectionFor("/chronos/billing", null)).toBeNull();
  });

  it("says where the screen went in one line, links to Studio, and stays dismissed in this browser", () => {
    pathname = "/chronos/styles";
    const first = render(wrap(<StudioMovedNotice />));
    const note = screen.getByRole("status");
    expect(note.textContent).toContain("Styles now lives in Nightshift Studio.");
    expect(within(note).getByRole("link", { name: en.studioHub.movedOpen }).getAttribute("href")).toBe("/chronos/studio");
    fireEvent.click(within(note).getByRole("button", { name: en.studioHub.movedDismiss }));
    expect(screen.queryByRole("status")).toBeNull();
    first.unmount();
    render(wrap(<StudioMovedNotice />));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("on Studio home after a redirect, names the screen and does not link to the page you are on", () => {
    search = "shelf=videos&moved=videos";
    render(wrap(<StudioMovedNotice />));
    const note = screen.getByRole("status");
    expect(note.textContent).toContain("Videos now lives in Nightshift Studio.");
    expect(within(note).queryByRole("link")).toBeNull();
  });

  it("is in all three languages, with the brand untranslated", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      expect(dictionaries[loc].studioHub.moved, loc).toContain("{name}");
      expect(dictionaries[loc].studioHub.moved, loc).toContain("Nightshift Studio");
    }
  });
});
