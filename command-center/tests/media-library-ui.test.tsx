// @vitest-environment jsdom
/**
 * The library page in a browser-like DOM: a skeleton (never "nothing here
 * yet") until the list has arrived; chips with counts, search and sort; the
 * viewer's keyboard (Escape, ←/→, focus back to the file's tile); bulk delete
 * as the existing DELETE, once per file; and the upload cards' states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/x/library",
}));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { MediaLibrary } from "@/components/media/MediaLibrary";
import type { LibraryAsset, MediaKind, MediaLibraryData, MediaUpload } from "@/lib/media";

const ORG = "00000000-0000-4000-8000-000000000001";
const tm = en.media;

function withI18n(ui: ReactNode) {
  return <I18nProvider locale="en">{ui}</I18nProvider>;
}

let n = 0;
function asset(kind: MediaKind, name: string, day: number, extra: Partial<LibraryAsset> = {}): LibraryAsset {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind,
    mime: kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png",
    bytes: 2048,
    width: kind === "audio" ? null : 1920,
    height: kind === "audio" ? null : 1080,
    durationS: kind === "image" ? null : 65,
    source: "upload",
    name,
    variants: ["thumb"],
    version: 1,
    createdAt: `2026-09-${String(day).padStart(2, "0")}T10:00:00Z`,
    thumbUrl: `/api/media/file/x/thumb?sig=${n}`,
    viewUrl: `/api/media/file/x/original?sig=${n}`,
    ...extra,
  };
}

function lib(assets: LibraryAsset[], uploads: MediaUpload[] = [], over: Partial<MediaLibraryData> = {}): MediaLibraryData {
  return {
    available: true,
    host: { media: true, staging: true, signing: true },
    assets,
    uploads,
    quota: { usedBytes: 0, limitBytes: 1_000_000, maxUploadBytes: 100_000 },
    ...over,
  };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(() => json(lib([])));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

const tile = (name: string) => screen.getByRole("button", { name: `Open ${name}` });

describe("loading: a skeleton until the list arrives, never an empty state", () => {
  it("without a server list it shows the skeleton, then the files", async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (resolve = r)));
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} />));

    expect(container.querySelector("[data-library-skeleton]")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain(tm.loading);
    expect(screen.queryByText(tm.empty)).toBeNull();
    expect(container.querySelector("[data-library-empty]")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(`/api/media?org=${ORG}`, { cache: "no-store" });

    await act(async () => {
      resolve(new Response(JSON.stringify(lib([asset("image", "first.png", 1)])), { status: 200 }));
    });
    await waitFor(() => expect(tile("first.png")).toBeTruthy());
    expect(container.querySelector("[data-library-skeleton]")).toBeNull();
  });

  it("an empty list that has arrived offers the first action: upload", async () => {
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([])} />));
    const empty = container.querySelector("[data-library-empty]") as HTMLElement;
    expect(empty).not.toBeNull();
    expect(within(empty).getByText(tm.empty)).toBeTruthy();
    expect(within(empty).getByText(tm.upload)).toBeTruthy();
    expect(container.querySelector("[data-library-skeleton]")).toBeNull();
  });

  it("a failed first read is an error, not an empty library", async () => {
    fetchMock.mockImplementationOnce(() => json({ error: "read_failed" }, 502));
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} />));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(tm.readFailed));
    expect(container.querySelector("[data-library-empty]")).toBeNull();
  });

  it("the route's loading.tsx is the library skeleton", async () => {
    const { default: LibraryLoading } = await import("../app/(app)/[channel]/library/loading");
    const html = renderToStaticMarkup(await LibraryLoading());
    expect(html).toContain("data-library-skeleton");
    expect(html).toContain(tm.loading);
    expect(html).not.toContain(tm.empty);
  });
});

describe("chips, search, sort", () => {
  const a = asset("image", "beach.png", 1);
  const b = asset("video", "intro.mp4", 3);
  const c = asset("audio", "voice.mp3", 2);

  it("chips carry counts and narrow the grid; video shows its duration", () => {
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b, c])} />));
    const chips = within(screen.getByRole("group", { name: tm.filterLabel })).getAllByRole("button");
    expect(chips.map((x) => x.textContent)).toEqual(["All3", "Images1", "Videos1", "Audio1"]);
    expect(chips[0].getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(chips[2]);
    expect(chips[2].getAttribute("aria-pressed")).toBe("true");
    const items = container.querySelectorAll("[data-asset-kind]");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("1:05");
  });

  it("search by name and sort oldest first", () => {
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b, c])} />));
    const names = () => Array.from(container.querySelectorAll("[data-asset-kind] button")).map((x) => x.getAttribute("aria-label"));
    expect(names()).toEqual(["Open intro.mp4", "Open voice.mp3", "Open beach.png"]);

    fireEvent.change(screen.getByRole("combobox", { name: tm.sort }), { target: { value: "oldest" } });
    expect(names()).toEqual(["Open beach.png", "Open voice.mp3", "Open intro.mp4"]);

    fireEvent.change(screen.getByRole("searchbox", { name: tm.search }), { target: { value: "VOI" } });
    expect(names()).toEqual(["Open voice.mp3"]);

    fireEvent.change(screen.getByRole("searchbox", { name: tm.search }), { target: { value: "nothing-like-this" } });
    expect(screen.getByText(tm.noMatches)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tm.showAll }));
    expect(names()).toHaveLength(3);
  });
});

describe("viewer keyboard", () => {
  const a = asset("image", "one.png", 3);
  const b = asset("video", "two.mp4", 2);
  const c = asset("audio", "three.mp3", 1);

  it("opens on tap, arrows move (stopping at the ends), Escape closes and focus returns to the file's tile", () => {
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b, c])} />));
    const first = tile("one.png");
    first.focus();
    fireEvent.click(first);

    const dialog = screen.getByRole("dialog", { name: "one.png" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByText("1 of 3")).toBeTruthy();

    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("dialog", { name: "one.png" })).toBeTruthy();

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    const second = screen.getByRole("dialog", { name: "two.mp4" });
    expect(second.querySelector("video")?.getAttribute("src")).toBe(b.viewUrl);

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "three.mp3" }).querySelector("audio")).not.toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "three.mp3" })).toBeTruthy();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(tile("three.mp3"));
  });

  it("arrows inside a player keep their own meaning", () => {
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([b, c])} />));
    fireEvent.click(tile("two.mp4"));
    const video = screen.getByRole("dialog").querySelector("video")!;
    fireEvent.keyDown(video, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "two.mp4" })).toBeTruthy();
  });

  it("the close button closes and returns focus to the opener", () => {
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b])} />));
    const opener = tile("two.mp4");
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: tm.viewer.close }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("shows the file's facts and the existing actions only", () => {
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a])} />));
    fireEvent.click(tile("one.png"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("1920 × 1080")).toBeTruthy();
    expect(within(dialog).getByText("PNG")).toBeTruthy();
    const open = within(dialog).getByRole("link", { name: tm.viewer.openTab });
    expect(open.getAttribute("href")).toBe(a.viewUrl);
    expect(open.getAttribute("rel")).toContain("noopener");
    expect(within(dialog).getByRole("button", { name: tm.delete })).toBeTruthy();
    // One file: no arrows to offer.
    expect(within(dialog).queryByRole("button", { name: tm.viewer.next })).toBeNull();
  });

  it("no link is offered when the server cannot serve the file", () => {
    const heic = asset("image", "IMG_1.HEIC", 1, { mime: "image/heic", thumbUrl: null, viewUrl: null });
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([heic])} />));
    fireEvent.click(tile("IMG_1.HEIC"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("link")).toBeNull();
    expect(within(dialog).getByText(tm.viewer.noPreview)).toBeTruthy();
  });
});

describe("bulk delete", () => {
  it("is the existing DELETE once per selected file, after a confirmation", async () => {
    const a = asset("image", "a.png", 1);
    const b = asset("image", "b.png", 2);
    const c = asset("image", "c.png", 3);
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? json({ ok: true, deleted: true }) : json(lib([c])),
    );
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b, c])} />));

    fireEvent.click(screen.getByRole("button", { name: tm.select }));
    fireEvent.click(screen.getByRole("button", { name: "Select a.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Select b.png" }));
    expect(screen.getByRole("button", { name: "Select a.png" }).getAttribute("aria-pressed")).toBe("true");
    // Selecting never opens the viewer.
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete (2)" }));
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
    expect(screen.getByText(/Delete 2 files\?/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete (2)" }));
    });
    const deletes = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE").map(([u]) => u);
    expect(deletes.sort()).toEqual([`/api/media/${a.id}`, `/api/media/${b.id}`].sort());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open a.png" })).toBeNull());
  });

  it("says how many could not be deleted", async () => {
    const a = asset("image", "a.png", 1);
    const b = asset("image", "b.png", 2);
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? url.endsWith(a.id)
          ? json({ error: "forbidden" }, 403)
          : json({ ok: true })
        : json(lib([a])),
    );
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b])} />));
    fireEvent.click(screen.getByRole("button", { name: tm.select }));
    fireEvent.click(screen.getByRole("button", { name: "Select a.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Select b.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete (2)" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete (2)" }));
    });
    await waitFor(() => expect(screen.getByText("1 of 2 files could not be deleted.")).toBeTruthy());
  });
});

describe("upload cards", () => {
  const up = (status: MediaUpload["status"], name: string, reason: string | null = null): MediaUpload => ({
    id: `20000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    name,
    status,
    reason,
    bytes: 4096,
    assetId: null,
    createdAt: "2026-09-10T00:00:00Z",
    folderId: null,
  });

  it("each state is a card with a plain label; a refusal says why", () => {
    const { container } = render(
      withI18n(
        <MediaLibrary
          orgId={ORG}
          initial={lib([asset("image", "x.png", 1)], [up("receiving", "a.mov"), up("uploaded", "b.jpg"), up("rejected", "c.png", "type_mismatch")])}
        />,
      ),
    );
    expect(container.querySelectorAll("[data-upload-status]")).toHaveLength(3);
    expect(screen.getByText(tm.status.receiving)).toBeTruthy();
    expect(screen.getByText(tm.status.uploaded)).toBeTruthy();
    expect(screen.getByText(tm.reasons.type_mismatch)).toBeTruthy();
  });

  it("while checking is down, a waiting upload says so and the honest line stays", () => {
    const { container } = render(
      withI18n(<MediaLibrary orgId={ORG} initial={lib([], [up("uploaded", "b.jpg")], { pipeline: { state: "stale", ageSeconds: 900 } })} />),
    );
    expect(container.querySelector("[data-pipeline-down]")?.textContent).toBe(tm.pipelineDown);
    expect(screen.getByText(tm.status.paused)).toBeTruthy();
    expect(screen.queryByText(tm.status.uploaded)).toBeNull();
    // Something is on its way: not the empty state.
    expect(container.querySelector("[data-library-empty]")).toBeNull();
  });
});
