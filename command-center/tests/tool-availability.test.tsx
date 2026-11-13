// @vitest-environment jsdom
/**
 * "Not available yet" (lib/tool-availability.ts). What would break without these: a tool with no model on sale drawn exactly like a
 * working one in the sidebar, the desk bar, Home, the create overview and the Presets page (the customer finds out only inside the
 * form: "Nothing to pick yet"); an unknown read drawn as "not available" (CLAUDE.md rule 5); a page that says nothing is on sale and
 * leaves the person nowhere to go; the overview opening on a picture box nobody can send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

let pathname = "/chronos/create";
let search = "";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
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
vi.mock("@/components/navigation/NavigationProvider", () => ({
  useNavigation: () => ({ canGoBack: () => false, goBack: vi.fn(), channelName: () => null, showChannel: false }),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}`, useChannelSlug: () => "chronos" }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { ShellProvider } from "@/components/shell/ShellContext";
import { SideNav } from "@/components/SideNav";
import { DeskBar } from "@/components/studio/Desks";
import { DeskAvailabilityNote, NothingOnSaleNote } from "@/components/studio/Availability";
import { HomeHub } from "@/components/home/HomeHub";
import { RecentStrip } from "@/components/home/RecentStrip";
import { StudioHome, startMode } from "@/components/studio/StudioHome";
import { PresetsGallery } from "@/components/presets/PresetsGallery";
import { SkipLink, isCreatePath } from "@/components/shell/SkipLink";
import { QUICK_ACTIONS, type HomeChannel } from "@/lib/home";
import { DESK_TOOLS } from "@/lib/creative/desks";
import { STUDIO_VOICES } from "@/lib/creative/studio";
import { STUDIO_TEMPLATES } from "@/lib/creative/templates";
import { CREATIVE_EXAMPLES } from "@/lib/creative/examples";
import {
  UNKNOWN_TOOLS,
  availabilityFromModels,
  closedTools,
  deskOpen,
  nothingOnSale,
  toolOpen,
  type ToolAvailability,
} from "@/lib/tool-availability";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const NONE: ToolAvailability = { state: "known", sold: [] };
const PICTURES: ToolAvailability = { state: "known", sold: ["t2i", "edit"] };

function wrap(ui: ReactNode, tools: ToolAvailability = UNKNOWN_TOOLS, locale: Locale = "en") {
  return (
    <I18nProvider locale={locale}>
      <ShellProvider operator={false} tools={tools}>
        {ui}
      </ShellProvider>
    </I18nProvider>
  );
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  pathname = "/chronos/create";
  search = "";
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
      if (url.startsWith("/api/media")) return json({ available: true, assets: [], uploads: [] });
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the availability itself (pure)", () => {
  it("is the capabilities of the models the form would offer; a failed read is unknown, never 'none'", () => {
    expect(availabilityFromModels(null)).toEqual(UNKNOWN_TOOLS);
    expect(availabilityFromModels([])).toEqual({ state: "known", sold: [] });
    expect(availabilityFromModels([{ capabilities: ["t2v", "t2i"] }, { capabilities: ["t2i"] }])).toEqual({ state: "known", sold: ["t2i", "t2v"] });
  });

  it("unknown opens every tool and every desk: nothing is marked unavailable on a guess", () => {
    for (const tools of Object.values(DESK_TOOLS)) for (const c of tools) expect(toolOpen(UNKNOWN_TOOLS, c)).toBe(true);
    for (const d of ["video", "image", "enhance", "voice"] as const) expect(deskOpen(UNKNOWN_TOOLS, d)).toBe(true);
    expect(nothingOnSale(UNKNOWN_TOOLS)).toBe(false);
  });

  it("a desk is open while any one of its tools is; the overview and the YouTube video never depend on a model on sale", () => {
    expect(deskOpen(PICTURES, "image")).toBe(true);
    expect(deskOpen(PICTURES, "video")).toBe(false);
    expect(deskOpen(NONE, "overview")).toBe(true);
    expect(deskOpen(NONE, "youtube")).toBe(true);
    expect(closedTools(PICTURES, DESK_TOOLS.image)).toEqual(["describe"]);
  });

  it("only the Studio's own tools count: a model sold for captions alone is still 'nothing on sale here'", () => {
    expect(nothingOnSale(NONE)).toBe(true);
    expect(nothingOnSale({ state: "known", sold: ["captions", "music"] })).toBe(true);
    expect(nothingOnSale(PICTURES)).toBe(false);
  });
});

describe("the sidebar", () => {
  it("marks a desk with nothing on sale 'Not available yet' and does not link it; a desk on sale stays a link", () => {
    pathname = "/chronos/home";
    render(wrap(<SideNav email="me@example.com" plan={null} />, PICTURES));
    const image = screen.getByTestId("sidebar-desk-image");
    expect(image.tagName).toBe("A");
    expect(image.getAttribute("href")).toBe("/chronos/create?desk=image");
    for (const d of ["video", "enhance", "voice"]) {
      const row = screen.getByTestId(`sidebar-desk-${d}`);
      expect(row.tagName, d).not.toBe("A");
      expect(row.getAttribute("href")).toBeNull();
      expect(within(row).getByText(t.availability.notYet)).toBeTruthy();
    }
    // What does work is still a link: the overview and the YouTube video.
    expect(screen.getByTestId("sidebar-desk-overview").tagName).toBe("A");
    expect(screen.getByTestId("sidebar-desk-youtube").tagName).toBe("A");
  });

  it("draws every desk as a link while availability is unknown", () => {
    pathname = "/chronos/home";
    render(wrap(<SideNav email="me@example.com" plan={null} />));
    for (const d of ["overview", "video", "image", "enhance", "voice", "youtube"]) expect(screen.getByTestId(`sidebar-desk-${d}`).tagName, d).toBe("A");
    expect(screen.queryByText(t.availability.notYet)).toBeNull();
  });

  it("the desk you are on stays a link even when nothing on it is on sale, and says so", () => {
    pathname = "/chronos/create";
    search = "desk=voice";
    render(wrap(<SideNav email="me@example.com" plan={null} />, PICTURES));
    const voice = screen.getByTestId("sidebar-desk-voice");
    expect(voice.tagName).toBe("A");
    expect(voice.getAttribute("aria-current")).toBe("page");
    expect(within(voice).getByText(t.availability.notYet)).toBeTruthy();
  });
});

describe("the desk bar on /create", () => {
  it("names the closed desks in place of their line and links only the open ones", () => {
    render(wrap(<DeskBar current="image" />, PICTURES));
    const bar = screen.getByRole("navigation", { name: t.desk.nav });
    expect(within(bar).getByRole("link", { name: new RegExp(t.desk.names.image) })).toBeTruthy();
    expect(within(bar).queryByRole("link", { name: new RegExp(t.desk.names.video) })).toBeNull();
    expect(bar.querySelector('[data-desk="video"][data-unavailable="true"]')?.textContent).toContain(t.availability.notYet);
    expect(within(bar).getByRole("link", { name: new RegExp(t.desk.names.youtube) })).toBeTruthy();
  });
});

describe("the note over a desk's composer", () => {
  it("names the tools of this desk that have nothing on sale", () => {
    render(wrap(<DeskAvailabilityNote desk="image" />, PICTURES));
    expect(screen.getByTestId("desk-some-closed").textContent).toBe(`Not available yet on this desk: ${t.desk.tools.describe}.`);
  });

  it("a desk with nothing on sale says so and points to the YouTube video: never a dead end", () => {
    render(wrap(<DeskAvailabilityNote desk="enhance" />, PICTURES));
    const note = screen.getByTestId("desk-closed");
    expect(within(note).getByText(t.availability.deskTitle)).toBeTruthy();
    expect(within(note).getByRole("link", { name: t.availability.noneCta }).getAttribute("href")).toBe("/chronos/create?desk=youtube");
  });

  it("says nothing while every tool is on sale, or while that is unknown", () => {
    const { container } = render(wrap(<DeskAvailabilityNote desk="image" />, { state: "known", sold: ["t2i", "edit", "describe"] }));
    expect(container.textContent).toBe("");
    cleanup();
    const second = render(wrap(<DeskAvailabilityNote desk="image" />));
    expect(second.container.textContent).toBe("");
  });
});

const card = (over: Partial<HomeChannel> = {}): HomeChannel => ({
  id: "c1",
  slug: "chronos",
  name: "Chronos",
  avatar: null,
  language: "",
  standing: "live",
  autoPublish: false,
  lastVideo: null,
  nextRun: null,
  waiting: 0,
  ...over,
});

describe("Home", () => {
  beforeEach(() => {
    pathname = "/chronos/home";
  });

  it("leaves out a quick tool with nothing on sale (\"Remove background\", \"Voice-over\") and keeps the ones on sale", () => {
    render(wrap(<HomeHub channels={[card()]} currentSlug="chronos" orgId={null} allPrivate />, PICTURES));
    for (const a of QUICK_ACTIONS) {
      const link = screen.queryByRole("link", { name: new RegExp(t.home.quick[a.id].title) });
      if (a.tool === "t2i" || a.tool === "edit") expect(link, a.id).toBeTruthy();
      else expect(link, a.id).toBeNull();
    }
    expect(screen.queryByTestId("home-nothing-on-sale")).toBeNull();
  });

  it("with nothing on sale says so plainly and points to what works: the YouTube video", () => {
    render(wrap(<HomeHub channels={[card()]} currentSlug="chronos" orgId={null} allPrivate />, NONE));
    for (const a of QUICK_ACTIONS) expect(screen.queryByRole("link", { name: new RegExp(t.home.quick[a.id].title) })).toBeNull();
    const note = screen.getByTestId("home-nothing-on-sale");
    expect(within(note).getByText(t.availability.noneTitle)).toBeTruthy();
    expect(within(note).getByRole("link", { name: t.availability.noneCta }).getAttribute("href")).toBe("/chronos/create?desk=youtube");
  });

  it("does not promise a picture without a channel when no picture, clip or voice-over can be bought", () => {
    render(wrap(<HomeHub channels={[]} currentSlug={null} orgId={null} allPrivate={false} />, NONE));
    expect(screen.queryByTestId("home-try-media")).toBeNull();
    cleanup();
    render(wrap(<HomeHub channels={[]} currentSlug={null} orgId={null} allPrivate={false} />, PICTURES));
    expect(screen.getByTestId("home-try-media").getAttribute("href")).toBe("/chronos/create?desk=image");
  });

  it("the empty recent strip offers 'make an image' only while a picture can be made", async () => {
    render(wrap(<RecentStrip orgId={ORG} />, NONE));
    await screen.findByText(t.home.recentEmptyTitle);
    expect(screen.queryByRole("link", { name: t.home.recentEmptyCta })).toBeNull();
    cleanup();
    render(wrap(<RecentStrip orgId={ORG} />, PICTURES));
    expect((await screen.findByRole("link", { name: t.home.recentEmptyCta })).getAttribute("href")).toBe("/chronos/create?tool=t2i");
  });

  it("is unchanged while availability is unknown", () => {
    render(wrap(<HomeHub channels={[card()]} currentSlug="chronos" orgId={null} allPrivate />));
    for (const a of QUICK_ACTIONS) expect(screen.getByRole("link", { name: new RegExp(t.home.quick[a.id].title) })).toBeTruthy();
  });
});

describe("the create overview", () => {
  it("opens on the first kind with something on sale, the YouTube video when nothing is, and a link's own kind first", () => {
    expect(startMode(UNKNOWN_TOOLS, null)).toBe("image");
    expect(startMode(NONE, null)).toBe("youtube");
    expect(startMode({ state: "known", sold: ["t2v"] }, null)).toBe("video");
    expect(startMode(NONE, { capability: "tts", model: "", prompt: "", aspect: "16:9", duration: 5 })).toBe("voice");
  });

  it("marks the kinds with nothing on sale, makes them inert, hides their examples, and says what works", () => {
    render(
      wrap(
        <StudioHome orgId={ORG} models={[]} credits={{ state: "unknown" }} projects={{ state: "not_available" }} />,
        NONE,
      ),
    );
    const modes = screen.getByTestId("studio-modes");
    const youtube = within(modes).getByRole("radio", { name: new RegExp(t.studioHome.modes.youtube) });
    expect(youtube.getAttribute("aria-checked")).toBe("true");
    const image = within(modes).getByRole("radio", { name: new RegExp(t.studioHome.modes.image) });
    expect(image.getAttribute("aria-disabled")).toBe("true");
    expect(image.textContent).toContain(t.availability.notYet);
    fireEvent.click(image);
    expect(image.getAttribute("aria-checked")).toBe("false");
    // Only the YouTube examples are left: one for a picture would fill a box that cannot be sent.
    const left = CREATIVE_EXAMPLES.filter((e) => !e.capability).length;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(CREATIVE_EXAMPLES.length);
    expect(document.querySelectorAll(".sh-examples > li")).toHaveLength(left);
    expect(screen.getByTestId("nothing-on-sale")).toBeTruthy();
    // The Advanced pages: the closed ones are not links.
    expect(screen.queryByRole("link", { name: new RegExp(t.studioHome.advanced.pages.image) })).toBeNull();
    expect(screen.getByRole("link", { name: new RegExp(t.studioHome.advanced.pages.youtube) })).toBeTruthy();
  });
});

describe("the Presets page", () => {
  it("keeps a voice or a starter whose tool has nothing on sale, says so, and does not link it", () => {
    pathname = "/chronos/presets";
    render(wrap(<PresetsGallery />, PICTURES));
    const voice = document.querySelector(`[data-preset="voice:${STUDIO_VOICES[0].id}"]`) as HTMLElement;
    expect(voice.tagName).not.toBe("A");
    expect(voice.textContent).toContain(t.availability.notYet);
    const cut = STUDIO_TEMPLATES.find((tpl) => tpl.capability === "remove_bg");
    if (cut) expect((document.querySelector(`[data-preset="starter:${cut.id}"]`) as HTMLElement).tagName).not.toBe("A");
    const pic = STUDIO_TEMPLATES.find((tpl) => tpl.capability === "t2i")!;
    expect((document.querySelector(`[data-preset="starter:${pic.id}"]`) as HTMLElement).tagName).toBe("A");
    // Formats do not depend on a model on sale.
    expect((document.querySelector('[data-preset^="format:"]') as HTMLElement).tagName).toBe("A");
  });
});

describe("skip to the prompt", () => {
  it("is offered on /create only, after 'Skip to content', and focuses the composer's field", () => {
    expect(isCreatePath("/chronos/create")).toBe(true);
    expect(isCreatePath("/chronos/home")).toBe(false);
    expect(isCreatePath("/chronos/create-something")).toBe(false);
    render(
      wrap(
        <>
          <SkipLink />
          <main id="main" tabIndex={-1}>
            <div id="prompt">
              <textarea aria-label="prompt" />
            </div>
          </main>
        </>,
      ),
    );
    const skip = screen.getByTestId("skip-to-prompt");
    expect(skip.textContent).toBe(t.availability.skipToPrompt);
    fireEvent.click(skip);
    expect(document.activeElement).toBe(screen.getByLabelText("prompt"));
    cleanup();
    pathname = "/chronos/library";
    render(wrap(<SkipLink />));
    expect(screen.queryByTestId("skip-to-prompt")).toBeNull();
  });
});

describe("the words", () => {
  it("are in all three languages, with the same {fillers}", () => {
    const fill = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [k, v] of Object.entries(dictionaries.en.availability)) {
      for (const loc of ["ru", "uz"] as const) {
        const other = (dictionaries[loc].availability as Record<string, string>)[k];
        expect(other?.trim(), `${loc}.${k}`).toBeTruthy();
        expect(fill(other), `${loc}.${k}`).toEqual(fill(v));
      }
    }
  });

  it("never promise a date or 'coming soon'", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const text = Object.values(dictionaries[loc].availability).join(" ").toLowerCase();
      expect(text).not.toMatch(/coming soon|скоро|tez orada/);
    }
  });

  it("call the Studio Canvas 'Brand look', so 'Studio' no longer means three things", () => {
    expect(dictionaries.en.nav.studio).toBe("Brand look");
    expect(dictionaries.en.studio.title).toBe("Brand look");
    expect(dictionaries.ru.nav.studio).toBe("Облик бренда");
    expect(dictionaries.uz.nav.studio).toBe("Brend koʻrinishi");
    for (const loc of ["en", "ru", "uz"] as const) expect(dictionaries[loc].nav.studio).toBe(dictionaries[loc].studio.title);
  });

  it("count generations, not clips: the strip counts pictures and voice-overs too", () => {
    expect(dictionaries.en.home.makingMany).toBe("{n} generations are being made");
    for (const loc of ["en", "ru", "uz"] as const) {
      const h = dictionaries[loc].home;
      for (const s of [h.makingOne, h.makingMany]) expect(s.toLowerCase(), loc).not.toMatch(/clip|клип|klip/);
      expect(h.makingBodyMany.trim()).not.toBe("");
    }
  });
});

describe("NothingOnSaleNote", () => {
  it("renders nothing while anything is on sale or unknown", () => {
    expect(render(wrap(<NothingOnSaleNote />, PICTURES)).container.textContent).toBe("");
    cleanup();
    expect(render(wrap(<NothingOnSaleNote />)).container.textContent).toBe("");
  });
});
