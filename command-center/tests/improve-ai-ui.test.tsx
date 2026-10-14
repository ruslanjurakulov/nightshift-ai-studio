// @vitest-environment jsdom
/**
 * "Improve with AI" in a browser-like DOM: the menu per file type, the links
 * that open the existing Studio tool with the file chosen, the honest "not
 * available on this deployment yet" state, Captions through the editor, the
 * library tile and viewer, the editor's clip and overlay, and "Add to
 * project" for a finished result. The only requests ever made are the
 * editor's own project list and send (Captions from the library); nothing is
 * quoted, started, priced or spent here, and no network is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const router = { push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/chronos/library",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { fmt } from "@/lib/i18n";
import { ImproveWithAi } from "@/components/ai/ImproveWithAi";
import { MediaViewer } from "@/components/media/MediaViewer";
import { MediaLibrary } from "@/components/media/MediaLibrary";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { JobFeed } from "@/components/studio/JobFeed";
import { newDocForAsset, type EditorAsset } from "@/lib/editor";
import type { LibraryAsset, MediaLibraryData } from "@/lib/media";

const tx = en.improveAi;
const ORG = "00000000-0000-4000-8000-000000000001";
const FILE = "11111111-1111-4111-8111-111111111111";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEWFILE = "33333333-3333-4333-8333-333333333333";

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let fetchMock: ReturnType<typeof vi.fn>;
let extra: (url: string, init?: RequestInit) => Promise<Response> | undefined;
beforeEach(() => {
  router.push.mockReset();
  extra = () => undefined;
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const own = extra(String(url), init);
    if (own) return own;
    if (String(url).startsWith("/api/editor/projects?")) return json({ projects: [{ id: P1, title: "Trip" }] });
    if (String(url) === "/api/editor/send") return json({ id: P1, created: false });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.style.overflow = "";
});
/** No quote, no job, no spend: only the editor's own list/send may be called. */
const spendingCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/creative"));

const mount = (ui: ReactNode, locale: "en" | "ru" | "uz" = "en") => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);
const openMenu = () => {
  fireEvent.click(screen.getByTestId("improve-with-ai"));
  return screen.getByTestId("improve-with-ai-dialog");
};
const rows = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>("[data-tool]")];
const tools = (dialog: HTMLElement) => rows(dialog).map((r) => r.dataset.tool);

describe("the menu per file type", () => {
  it("a picture: upscale, cut out, edit by prompt, animate — each a link into the Studio tool with the file chosen", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" name="Cover" available={null} />);
    const dialog = openMenu();
    expect(tools(dialog)).toEqual(["upscale", "remove_bg", "edit", "i2v"]);
    for (const r of rows(dialog)) {
      expect(r.tagName).toBe("A");
      expect(r.getAttribute("href")).toBe(`/chronos/create?tool=${r.dataset.tool}&source=${FILE}`);
    }
    expect(within(dialog).getByText(tx.tools.upscale.label)).toBeTruthy();
    expect(within(dialog).getByText(tx.tools.remove_bg.label)).toBeTruthy();
    expect(spendingCalls()).toHaveLength(0);
  });

  it("a video from the library: upscale video, captions (through the editor), dub, change voice", () => {
    mount(<ImproveWithAi assetId={FILE} kind="video" name="Trip" available={null} orgId={ORG} />);
    const dialog = openMenu();
    expect(tools(dialog)).toEqual(["video_upscale", "captions", "dub", "voice_change"]);
    expect(rows(dialog)[0]!.getAttribute("href")).toBe(`/chronos/create?tool=video_upscale&source=${FILE}`);
    expect(rows(dialog)[1]!.tagName).toBe("BUTTON");
    expect(within(dialog).getByText(tx.inEditor)).toBeTruthy();
  });

  it("a sound: change voice and dub only", () => {
    mount(<ImproveWithAi assetId={FILE} kind="audio" name="Voice" available={null} orgId={ORG} />);
    expect(tools(openMenu())).toEqual(["voice_change", "dub"]);
  });

  it("captions are left out where there is no way to make them (no organization, not in the editor)", () => {
    mount(<ImproveWithAi assetId={FILE} kind="video" name="Trip" available={null} />);
    expect(tools(openMenu())).toEqual(["video_upscale", "dub", "voice_change"]);
  });

  it("carries the editor project into every Studio link", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} project={P1} />);
    for (const r of rows(openMenu())) expect(r.getAttribute("href")).toBe(`/chronos/create?tool=${r.dataset.tool}&source=${FILE}&project=${P1}`);
  });
});

describe("a tool that is not sold here", () => {
  it("says so plainly and cannot be followed; the ones that are sold still work", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" name="Cover" available={["upscale"]} />);
    const dialog = openMenu();
    const [up, cut, edit, anim] = rows(dialog);
    expect(up!.tagName).toBe("A");
    for (const r of [cut!, edit!, anim!]) {
      expect(r.tagName).not.toBe("A");
      expect(r.getAttribute("aria-disabled")).toBe("true");
      expect(r.dataset.state).toBe("unavailable");
      expect(within(r).getByText(tx.unavailable)).toBeTruthy();
    }
    expect(within(up!).queryByText(tx.unavailable)).toBeNull();
  });

  it("nothing sold at all: every row is the honest state, none is a dead link", () => {
    mount(<ImproveWithAi assetId={FILE} kind="video" name="Trip" available={[]} orgId={ORG} />);
    const dialog = openMenu();
    expect(rows(dialog)).toHaveLength(4);
    expect(dialog.querySelectorAll("a, button[data-tool]")).toHaveLength(0);
    expect(within(dialog).getAllByText(tx.unavailable)).toHaveLength(4);
  });

  it("an unreadable answer is not shown as 'not sold': the tools are still offered", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={null} />);
    expect(within(openMenu()).queryByText(tx.unavailable)).toBeNull();
  });

  it("a file id that is not an id gives no button rather than a broken link", () => {
    mount(<ImproveWithAi assetId="not-an-id" kind="image" available={null} />);
    expect(screen.queryByTestId("improve-with-ai")).toBeNull();
  });
});

describe("keyboard and focus", () => {
  it("focus goes to the first tool, Escape closes the menu and gives focus back to the button", async () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" available={["remove_bg", "edit"]} />);
    const button = screen.getByTestId("improve-with-ai");
    button.focus();
    const dialog = openMenu();
    await waitFor(() => expect(document.activeElement).toBe(rows(dialog)[1]));
    expect(rows(dialog)[1]!.dataset.tool).toBe("remove_bg");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("improve-with-ai-dialog")).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it("the icon button is named for its file; every row is at least 44px tall by class", () => {
    mount(<ImproveWithAi assetId={FILE} kind="image" name="Cover" available={null} variant="icon" />);
    expect(screen.getByRole("button", { name: fmt(tx.actionFor, { name: "Cover" }) })).toBeTruthy();
    for (const r of rows(openMenu())) expect(r.className).toContain("min-h-11");
  });
});

describe("Captions", () => {
  it("from the library: opens the usual 'open in editor' dialog and lands on the Captions panel", async () => {
    mount(<ImproveWithAi assetId={FILE} kind="video" name="Trip" available={null} orgId={ORG} />);
    const dialog = openMenu();
    fireEvent.click(rows(dialog)[1]!);
    const send = await screen.findByTestId("open-in-editor-dialog");
    expect(screen.queryByTestId("improve-with-ai-dialog")).toBeNull();
    fireEvent.click(await within(send).findByLabelText(en.editor.send.existingOption));
    fireEvent.click(within(send).getByRole("button", { name: en.editor.send.submit }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/chronos/editor/${P1}?focus=captions`));
    expect(spendingCalls()).toHaveLength(0);
  });

  it("in the editor: goes to the Captions panel without leaving", () => {
    const onCaptions = vi.fn();
    mount(<ImproveWithAi assetId={FILE} kind="video" name="Trip" available={null} onCaptions={onCaptions} />);
    fireEvent.click(rows(openMenu())[1]!);
    expect(onCaptions).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("improve-with-ai-dialog")).toBeNull();
  });

  it("when captions are not sold, they are the honest state and do nothing", () => {
    const onCaptions = vi.fn();
    mount(<ImproveWithAi assetId={FILE} kind="video" name="Trip" available={["dub"]} onCaptions={onCaptions} />);
    const dialog = openMenu();
    const captions = rows(dialog)[1]!;
    expect(captions.dataset.state).toBe("unavailable");
    fireEvent.click(captions);
    expect(onCaptions).not.toHaveBeenCalled();
  });
});

function libraryAsset(kind: LibraryAsset["kind"], id = FILE, name = "Result"): LibraryAsset {
  return {
    id,
    kind,
    mime: kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : kind === "image" ? "image/png" : "text/vtt",
    bytes: 2048,
    width: 1920,
    height: 1080,
    durationS: 12,
    source: "generated",
    name,
    variants: [],
    version: 1,
    createdAt: "2026-09-01T10:00:00Z",
    thumbUrl: null,
    viewUrl: null,
  };
}

describe("the library viewer", () => {
  const viewer = (kind: LibraryAsset["kind"], aiTools: readonly string[] | null = null, onClose = vi.fn()) =>
    mount(<MediaViewer items={[libraryAsset(kind)]} index={0} onNavigate={() => {}} onClose={onClose} deleting={false} orgId={ORG} aiTools={aiTools} />);

  it.each([["image", 4], ["video", 4], ["audio", 2]] as const)("a %s offers its tools", (kind, n) => {
    viewer(kind);
    expect(rows(openMenu())).toHaveLength(n);
  });

  it("a caption file offers nothing", () => {
    viewer("caption");
    expect(screen.queryByTestId("improve-with-ai")).toBeNull();
  });

  it("Escape closes only the menu, not the viewer under it", async () => {
    const onClose = vi.fn();
    viewer("image", null, onClose);
    openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("improve-with-ai-dialog")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the unavailable state from what the page read", () => {
    viewer("audio", []);
    expect(within(openMenu()).getAllByText(tx.unavailable)).toHaveLength(2);
  });
});

describe("the library tiles", () => {
  const data = (assets: LibraryAsset[]): MediaLibraryData => ({
    available: true,
    host: { media: true, staging: true, signing: true },
    assets,
    uploads: [],
    quota: { usedBytes: 0, limitBytes: 1_000_000, maxUploadBytes: 100_000 },
    folders: { available: false, folders: [], total: assets.length, unfiled: null },
    folder: null,
    query: "",
    truncated: false,
  });

  it("each picture, video and sound tile has its own button beside (not inside) the open button; a file of another kind has none", () => {
    const A = libraryAsset("image", "21111111-1111-4111-8111-111111111111", "pic.png");
    const B = libraryAsset("video", "22222222-1111-4111-8111-111111111111", "clip.mp4");
    const C = libraryAsset("audio", "23333333-1111-4111-8111-111111111111", "voice.mp3");
    const D = libraryAsset("caption", "24444444-1111-4111-8111-111111111111", "subs.vtt");
    mount(<MediaLibrary orgId={ORG} initial={data([A, B, C, D])} aiTools={["upscale"]} />);
    const buttons = screen.getAllByTestId("improve-with-ai");
    expect(buttons.map((b) => b.dataset.kind)).toEqual(["image", "video", "audio"]);
    for (const b of buttons) expect(b.closest("button:not([data-testid])")).toBeNull();
    fireEvent.click(buttons[0]!);
    const dialog = screen.getByTestId("improve-with-ai-dialog");
    expect(rows(dialog)[0]!.getAttribute("href")).toBe(`/chronos/create?tool=upscale&source=${A.id}`);
    expect(rows(dialog)[1]!.dataset.state).toBe("unavailable");
  });

  it("is hidden while files are being selected", () => {
    const A = libraryAsset("image", "21111111-1111-4111-8111-111111111111", "pic.png");
    mount(<MediaLibrary orgId={ORG} initial={data([A])} aiTools={null} />);
    fireEvent.click(screen.getByRole("button", { name: en.media.select }));
    expect(screen.queryByTestId("improve-with-ai")).toBeNull();
  });
});

const CLIP: EditorAsset = {
  id: "44444444-4444-4444-8444-444444444444",
  kind: "video",
  name: "beach.mp4",
  durationS: 10,
  width: 1920,
  height: 1080,
  viewUrl: "/api/media/file/a/proxy?sig=1",
  thumbUrl: null,
};
const LOGO: EditorAsset = {
  id: "55555555-5555-4555-8555-555555555555",
  kind: "image",
  name: "logo.png",
  durationS: null,
  width: 400,
  height: 200,
  viewUrl: "/api/media/file/p/view?sig=1",
  thumbUrl: null,
};
const CLIP2: EditorAsset = {
  id: "77777777-7777-4777-8777-777777777777",
  kind: "video",
  name: "second.mp4",
  durationS: 6,
  width: 1920,
  height: 1080,
  viewUrl: "/api/media/file/c2/proxy?sig=1",
  thumbUrl: null,
};
const NOLEN: EditorAsset = {
  id: "88888888-8888-4888-8888-888888888888",
  kind: "video",
  name: "unmeasured.mp4",
  durationS: null,
  width: 1920,
  height: 1080,
  viewUrl: "/api/media/file/c3/proxy?sig=1",
  thumbUrl: null,
};
const RESULT: EditorAsset = {
  id: NEWFILE,
  kind: "image",
  name: "sharper.png",
  durationS: null,
  width: 2048,
  height: 2048,
  viewUrl: "/api/media/file/r/view?sig=1",
  thumbUrl: null,
};

describe("the editor", () => {
  const editor = (over: Partial<Parameters<typeof TimelineEditor>[0]> = {}, locale: "en" | "ru" | "uz" = "en") =>
    mount(
      <TimelineEditor
        projectId={P1}
        title="Trip"
        rev={1}
        doc={newDocForAsset(CLIP)!}
        exports={[]}
        assets={{ [CLIP.id]: CLIP, [LOGO.id]: LOGO }}
        videos={[CLIP]}
        imageFiles={[LOGO, RESULT]}
        orgId={ORG}
        {...over}
      />,
      locale,
    );

  it("a selected clip offers its tools, linked with the project so the result can come back", () => {
    editor({ aiTools: null });
    const dialog = openMenu();
    expect(tools(dialog)).toEqual(["video_upscale", "captions", "dub", "voice_change"]);
    expect(rows(dialog)[0]!.getAttribute("href")).toBe(`/chronos/create?tool=video_upscale&source=${CLIP.id}&project=${P1}`);
  });

  it("the clip's Captions entry scrolls to the Captions panel", () => {
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    editor({ aiTools: null });
    fireEvent.click(rows(openMenu())[1]!);
    expect(scroll).toHaveBeenCalled();
  });

  it("a picture overlay offers the picture tools (no captions)", () => {
    editor({ aiTools: ["upscale", "remove_bg"] });
    fireEvent.click(screen.getByRole("button", { name: en.editor.overlay.add }));
    fireEvent.click(screen.getByRole("button", { name: /logo\.png/ }));
    const dialog = openMenu();
    expect(tools(dialog)).toEqual(["upscale", "remove_bg", "edit", "i2v"]);
    expect(rows(dialog)[2]!.dataset.state).toBe("unavailable");
    expect(rows(dialog)[0]!.getAttribute("href")).toBe(`/chronos/create?tool=upscale&source=${LOGO.id}&project=${P1}`);
  });

  it("without an organization there is no priced flow to open: no button", () => {
    editor({ orgId: "" });
    expect(screen.queryByTestId("improve-with-ai")).toBeNull();
  });

  it("offers a finished result as 'Add to project' and adds it only when pressed", () => {
    editor({ offerAssetId: NEWFILE });
    const offer = screen.getByTestId("offer-add");
    expect(within(offer).getByText(fmt(tx.offerTitle, { name: "sharper.png" }))).toBeTruthy();
    fireEvent.click(within(offer).getByRole("button", { name: tx.offerAdd }));
    expect(within(screen.getByTestId("offer-add")).getByRole("status").textContent).toBe(tx.offerAdded);
    // Added to the document, unsaved: Save is still the person's press.
    expect(screen.getByText(en.editor.unsaved)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toHaveLength(0);
    // The picture is a second clip, selected.
    expect(screen.getByRole("heading", { name: fmt(en.editor.clipHeading, { n: 2 }) })).toBeTruthy();
  });

  it("'Not now' dismisses the offer and changes nothing", () => {
    editor({ offerAssetId: NEWFILE });
    fireEvent.click(within(screen.getByTestId("offer-add")).getByRole("button", { name: tx.offerNotNow }));
    expect(screen.queryByTestId("offer-add")).toBeNull();
    expect(screen.queryByText(en.editor.unsaved)).toBeNull();
  });

  it("a result the editor cannot find in the library says so", () => {
    editor({ offerAssetId: "66666666-6666-4666-8666-666666666666" });
    expect(within(screen.getByTestId("offer-add")).getByRole("status").textContent).toBe(tx.offerMissing);
  });

  it("moves focus to the status line after Add", async () => {
    editor({ offerAssetId: NEWFILE });
    fireEvent.click(within(screen.getByTestId("offer-add")).getByRole("button", { name: tx.offerAdd }));
    const status = within(screen.getByTestId("offer-add")).getByRole("status");
    await waitFor(() => expect(document.activeElement).toBe(status));
  });

  it("a reload with ?add= for a file the project already has offers nothing, so it cannot be added twice", () => {
    editor({ offerAssetId: CLIP.id });
    expect(screen.queryByTestId("offer-add")).toBeNull();
    cleanup();
    editor({ offerAssetId: CLIP.id.toUpperCase() });
    expect(screen.queryByTestId("offer-add")).toBeNull();
  });

  it("a video with no known length says that, not 'the project is full', and adds nothing", () => {
    editor({ offerAssetId: NOLEN.id, videos: [CLIP, NOLEN] });
    fireEvent.click(within(screen.getByTestId("offer-add")).getByRole("button", { name: tx.offerAdd }));
    expect(within(screen.getByTestId("offer-add")).getByRole("alert").textContent).toBe(tx.offerNoDuration);
    expect(screen.queryByText(tx.offerFailed)).toBeNull();
    expect(screen.queryByText(en.editor.unsaved)).toBeNull();
  });

  it("Captions on a second clip preselects that clip's recording in the Captions panel", () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    editor({
      offerAssetId: CLIP2.id,
      videos: [CLIP, CLIP2],
      aiTools: null,
      captionModels: [{ id: "m1", displayName: "Speech", languages: ["en"] }],
    });
    const source = () => screen.getByLabelText(en.captions.sourceLabel) as HTMLSelectElement;
    expect(source().value).toBe(CLIP.id);
    fireEvent.click(within(screen.getByTestId("offer-add")).getByRole("button", { name: tx.offerAdd }));
    // The added clip is the selected one: Captions from its menu pick its recording.
    fireEvent.click(rows(openMenu())[1]!);
    expect(source().value).toBe(CLIP2.id);
  });

  it("opens on the Captions panel when asked", async () => {
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    editor({ focusPanel: "captions" });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
  });
});

describe("the Studio result", () => {
  const SRC = "22222222-2222-4222-8222-222222222222";
  const job = {
    id: "j1",
    capability: "upscale",
    status: "completed",
    requested_model: "pic-tools",
    params: { source_asset_id: SRC, factor: 2 },
    quoted_credits: 6,
    charged_credits: 6,
    error_code: null,
    result: null,
    result_asset_ids: [NEWFILE],
    created_at: "2026-10-01T00:00:00Z",
  };
  beforeEach(() => {
    extra = (url) => {
      if (url.startsWith("/api/creative/jobs")) return json({ jobs: [job] });
      if (url.startsWith("/api/media")) return json({ available: true, assets: [], uploads: [] });
      return undefined;
    };
  });

  it("a finished result links back to the project with 'Add to project'", async () => {
    mount(<JobFeed orgId={ORG} project={P1} />);
    const link = await screen.findByTestId("add-to-project");
    expect(link.getAttribute("href")).toBe(`/chronos/editor/${P1}?add=${NEWFILE}`);
    expect(link.getAttribute("aria-label")).toBe(tx.addToProject);
  });

  it("without a project there is no such link", async () => {
    mount(<JobFeed orgId={ORG} />);
    await screen.findByTestId("open-in-editor");
    expect(screen.queryByTestId("add-to-project")).toBeNull();
  });
});

describe("Russian and Uzbek", () => {
  it.each([["ru", ru], ["uz", uz]] as const)("the menu reads in %s", (locale, d) => {
    mount(<ImproveWithAi assetId={FILE} kind="video" name="Trip" available={[]} orgId={ORG} />, locale);
    const dialog = openMenu();
    expect(within(dialog).getAllByText(d.improveAi.unavailable)).toHaveLength(4);
    expect(within(dialog).getByText(d.improveAi.tools.video_upscale.label)).toBeTruthy();
    expect(within(dialog).getByText(d.improveAi.tools.captions.label)).toBeTruthy();
    expect(d.improveAi.offerNoDuration.trim().length).toBeGreaterThan(0);
  });
});
