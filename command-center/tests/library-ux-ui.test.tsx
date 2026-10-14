// @vitest-environment jsdom
/**
 * The library's browsing and uploading niceties in a browser-like DOM: the view
 * in the address (Back undoes a filter), sort by name, selection with
 * Shift-click ranges and Escape, and dropping several files at once with a
 * per-file error. Fake backends only; nothing here reaches a provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";
import type { ReactNode } from "react";

let mockSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/x/library",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { MediaLibrary } from "@/components/media/MediaLibrary";
import { parseView, visibleAssets } from "@/components/media/libraryView";
import type { LibraryAsset, MediaKind, MediaLibraryData } from "@/lib/media";

const ORG = "00000000-0000-4000-8000-000000000001";
const tm = en.media;
const tu = en.libraryUx;
const wrap = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;

let n = 0;
function asset(kind: MediaKind, name: string, day: number): LibraryAsset {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind,
    mime: kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png",
    bytes: 2048,
    width: 1920,
    height: 1080,
    durationS: kind === "image" ? null : 65,
    source: "upload",
    name,
    variants: ["thumb"],
    version: 1,
    createdAt: `2026-09-${String(day).padStart(2, "0")}T10:00:00Z`,
    thumbUrl: `/api/media/file/x/thumb?sig=${n}`,
    viewUrl: null,
  };
}
const lib = (assets: LibraryAsset[]): MediaLibraryData => ({
  available: true,
  host: { media: true, staging: true, signing: true },
  assets,
  uploads: [],
  quota: { usedBytes: 0, limitBytes: 1_000_000, maxUploadBytes: 100_000 },
});
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

class FakeXHR {
  static sent: string[] = [];
  status = 0;
  responseText = "";
  upload = { onprogress: null as null | ((e: unknown) => void) };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private url = "";
  open(_m: string, url: string) {
    this.url = url;
  }
  send() {
    FakeXHR.sent.push(this.url);
    setTimeout(() => {
      this.status = 200;
      this.responseText = "{}";
      this.onload?.();
    }, 0);
  }
}

const photos = [asset("image", "beach.png", 1), asset("video", "intro.mp4", 3), asset("audio", "voice.mp3", 2), asset("image", "Alpha.png", 4)];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockSearch = "";
  FakeXHR.sent = [];
  window.history.replaceState(null, "", "/x/library");
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/media/uploads" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { filename: string };
      return body.filename.startsWith("bad")
        ? json({ error: "type_not_allowed" }, 400)
        : json({ ok: true, upload_url: `/api/media/uploads/t-${body.filename}` });
    }
    return json(lib(photos));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

const order = (c: HTMLElement) => Array.from(c.querySelectorAll("[data-asset-kind] button")).map((x) => x.getAttribute("aria-label"));

describe("the view lives in the address", () => {
  it("starts from the address, so a shared link opens the same view", () => {
    window.history.replaceState(null, "", "/x/library?kind=image&sort=name");
    const { container } = render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} initialView={parseView(new URLSearchParams(window.location.search))} />));
    expect(order(container)).toEqual(["Open Alpha.png", "Open beach.png"]);
    const pressed = within(screen.getByRole("group", { name: tm.filterLabel })).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed.map((b) => b.textContent)).toEqual(["Images2"]);
  });

  it("a chip pushes a history step, typing only rewrites it, Back undoes the chip", async () => {
    const { container } = render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} initialView={parseView({})} />));
    const before = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: /^Videos/ }));
    await waitFor(() => expect(window.location.search).toBe("?kind=video"));
    expect(window.history.length).toBe(before + 1);

    fireEvent.change(screen.getByRole("searchbox", { name: tm.search }), { target: { value: "int" } });
    await waitFor(() => expect(window.location.search).toBe("?kind=video&q=int"));
    expect(window.history.length).toBe(before + 1);

    fireEvent.change(screen.getByRole("combobox", { name: tm.sort }), { target: { value: "name" } });
    await waitFor(() => expect(window.location.search).toBe("?kind=video&q=int&sort=name"));

    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe("?kind=video&q=int"));
    await waitFor(() => expect((screen.getByRole("combobox", { name: tm.sort }) as HTMLSelectElement).value).toBe("newest"));
    expect(order(container)).toEqual(["Open intro.mp4"]);
  });

  it("sort by name is offered and orders A to Z", () => {
    const { container } = render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    fireEvent.change(screen.getByRole("combobox", { name: tm.sort }), { target: { value: "name" } });
    expect(order(container)).toEqual(["Open Alpha.png", "Open beach.png", "Open intro.mp4", "Open voice.mp3"]);
  });
});

describe("selection", () => {
  const start = () => {
    const r = render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    fireEvent.click(screen.getByRole("button", { name: tm.select }));
    return r;
  };
  const pick = (name: string, shiftKey = false) => fireEvent.click(screen.getByRole("button", { name: `Select ${name}` }), { shiftKey });

  it("Shift-click takes the range between the last click and this one", () => {
    const { container } = start();
    // newest first: Alpha, intro, voice, beach
    pick("Alpha.png");
    pick("voice.mp3", true);
    const bar = container.querySelector("[data-library-selection]") as HTMLElement;
    expect(within(bar).getByRole("status").textContent).toBe("3 selected");
    expect(screen.getByRole("button", { name: "Select beach.png" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Select intro.mp4" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("Escape clears the selection first, then leaves select mode; focus returns to Select", () => {
    const { container } = start();
    pick("Alpha.png");
    pick("beach.png", true);
    expect(container.querySelector("[data-library-selection]")?.textContent).toContain("4 selected");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector("[data-library-selection]")?.textContent).toContain("0 selected");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector("[data-library-selection]")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: tm.select }));
  });

  it("Escape in the delete question only closes the question", () => {
    const { container } = start();
    pick("Alpha.png");
    fireEvent.click(screen.getByRole("button", { name: "Delete (1)" }));
    expect(screen.getByText(/Delete 1 files\?/)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText(/Delete 1 files\?/)).toBeNull();
    expect(container.querySelector("[data-library-selection]")?.textContent).toContain("1 selected");
  });

  it("the bar floats (fixed on phones, sticky from lg) and its count is a polite status", () => {
    const { container } = start();
    const bar = container.querySelector("[data-library-selection]") as HTMLElement;
    expect(bar.className).toContain("lg:sticky");
    expect(bar.className).toContain("fixed");
    const status = within(bar).getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });
});

describe("dropping files", () => {
  const dropOn = (el: Element, files: File[]) => {
    const dataTransfer = { types: ["Files"], files, dropEffect: "none" };
    fireEvent.dragEnter(el, { dataTransfer });
    fireEvent.drop(el, { dataTransfer });
  };
  const png = (name: string) => new File([new Uint8Array([1, 2])], name, { type: "image/png" });

  it("shows the drop frame while files are over the page", () => {
    const { container } = render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    fireEvent.dragEnter(container.firstElementChild!, { dataTransfer: { types: ["Files"] } });
    expect(container.querySelector("[data-library-drop]")?.textContent).toBe(tu.dropHere);
    fireEvent.dragLeave(container.firstElementChild!, { dataTransfer: { types: ["Files"] } });
    expect(container.querySelector("[data-library-drop]")).toBeNull();
  });

  it("ignores a drag that carries no files (text, a link)", () => {
    const { container } = render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    fireEvent.dragEnter(container.firstElementChild!, { dataTransfer: { types: ["text/plain"] } });
    expect(container.querySelector("[data-library-drop]")).toBeNull();
  });

  it("uploads each dropped file in turn and names the one that failed", async () => {
    const { container } = render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    dropOn(container.firstElementChild!, [png("one.png"), png("bad.exe"), png("three.png")]);
    await waitFor(() => expect(FakeXHR.sent).toHaveLength(2));
    expect(FakeXHR.sent).toEqual(["/api/media/uploads/t-one.png", "/api/media/uploads/t-three.png"]);
    const alert = await screen.findByText(/1 of 3 files could not be sent/);
    expect(alert.closest("[role=alert]")?.textContent).toContain("bad.exe: ");
    expect(container.querySelector("[data-library-drop]")).toBeNull();
  });

  it("takes at most twenty files from one drop and says so", async () => {
    const { container } = render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    dropOn(container.firstElementChild!, Array.from({ length: 22 }, (_, i) => png(`f${i}.png`)));
    await waitFor(() => expect(FakeXHR.sent).toHaveLength(20), { timeout: 5000 });
    expect(container.querySelector("[data-library-notice]")?.textContent).toBe(tu.dropTooMany.replace("{max}", "20"));
  });

  it("one dropped file that fails shows the plain message, as the button always did", async () => {
    const { container } = render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    dropOn(container.firstElementChild!, [png("bad.exe")]);
    await waitFor(() => expect(container.querySelector("[role=alert]")).not.toBeNull());
    expect(container.querySelector("[role=alert]")?.textContent).not.toContain("bad.exe");
  });
});

describe("copy parity", () => {
  it("every language has every library-ux string, none empty, same placeholders", () => {
    for (const k of Object.keys(en.libraryUx) as (keyof typeof en.libraryUx)[]) {
      for (const d of [ru, uz]) {
        expect(d.libraryUx[k], k).toBeTruthy();
        const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
        expect(ph(d.libraryUx[k]), k).toBe(ph(en.libraryUx[k]));
      }
    }
  });
});

// ── review fixes ────────────────────────────────────────────────────────────

/** Holds every upload ticket until released, so a queue can be inspected mid-run. */
function holdTickets() {
  const waiting: (() => void)[] = [];
  const posts: string[] = [];
  const answer: Record<string, Response | undefined> = {};
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/media/uploads" && init?.method === "POST") {
      const { filename } = JSON.parse(String(init.body)) as { filename: string };
      posts.push(filename);
      return new Promise<Response>((resolve) => {
        waiting.push(() => {
          const custom = answer[filename];
          resolve(custom ?? new Response(JSON.stringify({ ok: true, upload_url: `/api/media/uploads/t-${filename}` }), { status: 200 }));
        });
      });
    }
    return json(lib(photos));
  });
  return { posts, release: () => waiting.shift()?.(), answer };
}
const pngFile = (name: string) => new File([new Uint8Array([1, 2])], name, { type: "image/png" });
const dropFiles = (el: Element, files: File[]) => fireEvent.drop(el, { dataTransfer: { types: ["Files"], files, dropEffect: "none" } });

describe("one upload run at a time", () => {
  it("a second drop (and the file input) is refused for the whole queue, also between two files", async () => {
    const h = holdTickets();
    const { container } = render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    dropFiles(document.body, [pngFile("a.png"), pngFile("b.png")]);
    await waitFor(() => expect(h.posts).toEqual(["a.png"]));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    dropFiles(document.body, [pngFile("c.png")]);
    h.release();
    // between the first file's end and the second's ticket: still busy
    await waitFor(() => expect(h.posts).toEqual(["a.png", "b.png"]));
    dropFiles(document.body, [pngFile("d.png")]);
    h.release();
    await waitFor(() => expect(FakeXHR.sent).toHaveLength(2));
    expect(h.posts).toEqual(["a.png", "b.png"]);
    await waitFor(() => expect(input.disabled).toBe(false));
  });
});

describe("drops meant for something else", () => {
  it("are ignored on the search box, in a dialog and in the viewer, yet still cancelled so the tab is not lost", () => {
    const h = holdTickets();
    render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    const box = screen.getByRole("searchbox", { name: tm.search });
    const ev = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
    ev.dataTransfer = { types: ["Files"], files: [pngFile("x.png")] };
    box.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(h.posts).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Open Alpha.png" }));
    const dialog = screen.getByRole("dialog");
    dropFiles(dialog, [pngFile("y.png")]);
    expect(h.posts).toEqual([]);
    fireEvent.dragOver(dialog, { dataTransfer: { types: ["Files"], dropEffect: "copy" } });
    expect(document.querySelector("[data-library-drop]")).toBeNull();
  });

  it("a file drag over the page is cancelled even while an upload runs (no navigating away)", async () => {
    const h = holdTickets();
    render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    dropFiles(document.body, [pngFile("a.png")]);
    await waitFor(() => expect(h.posts).toHaveLength(1));
    const ev = new Event("dragover", { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
    ev.dataTransfer = { types: ["Files"], dropEffect: "none" };
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.querySelector("[data-library-drop]")).toBeNull();
    h.release();
    await waitFor(() => expect(FakeXHR.sent).toHaveLength(1));
  });
});

describe("a refusal that every file would get stops the queue", () => {
  it("stops on too_many_uploads and says how many were not sent", async () => {
    const h = holdTickets();
    h.answer["b.png"] = new Response(JSON.stringify({ error: "too_many_uploads" }), { status: 429 });
    const { container } = render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    dropFiles(document.body, [pngFile("a.png"), pngFile("b.png"), pngFile("c.png"), pngFile("d.png")]);
    await waitFor(() => expect(h.posts).toEqual(["a.png"]));
    h.release();
    await waitFor(() => expect(h.posts).toEqual(["a.png", "b.png"]));
    h.release();
    const alert = await screen.findByText(/2 of 4 files could not be sent|3 of 4 files could not be sent/);
    expect(h.posts).toEqual(["a.png", "b.png"]);
    const box = alert.closest("[role=alert]") as HTMLElement;
    expect(box.textContent).toContain(en.media.errors.too_many_uploads);
    expect(box.textContent).toContain(tu.notSent.replace("{n}", "2"));
    expect(box.textContent).toContain("3 of 4 files could not be sent");
    expect(container.querySelector('input[type="file"]')).toHaveProperty("disabled", false);
  });

  it("a plain per-file error (too large) keeps going", async () => {
    const h = holdTickets();
    h.answer["a.png"] = new Response(JSON.stringify({ error: "too_large", max_bytes: 10 }), { status: 413 });
    render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    dropFiles(document.body, [pngFile("a.png"), pngFile("b.png")]);
    await waitFor(() => expect(h.posts).toEqual(["a.png"]));
    h.release();
    await waitFor(() => expect(h.posts).toEqual(["a.png", "b.png"]));
    h.release();
    await waitFor(() => expect(FakeXHR.sent).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });

  it("'Stop after this file' ends a multi-file queue and reports the rest as not sent", async () => {
    const h = holdTickets();
    render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    expect(screen.queryByRole("button", { name: tu.cancelQueue })).toBeNull();
    dropFiles(document.body, [pngFile("a.png"), pngFile("b.png"), pngFile("c.png")]);
    await waitFor(() => expect(h.posts).toEqual(["a.png"]));
    fireEvent.click(screen.getByRole("button", { name: tu.cancelQueue }));
    h.release();
    const msg = await screen.findByText(tu.notSent.replace("{n}", "2"));
    expect(msg).toBeTruthy();
    expect(h.posts).toEqual(["a.png"]);
    expect(screen.queryByRole("button", { name: tu.cancelQueue })).toBeNull();
  });
});

describe("name sort uses the app's language", () => {
  it("the same names order differently for sv than for en", () => {
    const a = asset("image", "ä.png", 1);
    const b = asset("image", "z.png", 2);
    const view = { filter: "all" as const, query: "", sort: "name" as const };
    expect(visibleAssets([b, a], view, undefined, "en").map((x) => x.name)).toEqual(["ä.png", "z.png"]);
    expect(visibleAssets([a, b], view, undefined, "sv").map((x) => x.name)).toEqual(["z.png", "ä.png"]);
  });
});

describe("the address wins after a soft navigation", () => {
  it("?kind=video then a link to the bare page shows All again", () => {
    window.history.replaceState(null, "", "/x/library?kind=video");
    mockSearch = "kind=video";
    const view = () => <MediaLibrary orgId={ORG} initial={lib(photos)} initialView={parseView(new URLSearchParams("kind=video"))} />;
    const { rerender, container } = render(wrap(view()));
    expect(order(container)).toEqual(["Open intro.mp4"]);

    window.history.pushState(null, "", "/x/library");
    mockSearch = "";
    rerender(wrap(view()));
    expect(order(container)).toHaveLength(4);
    expect(screen.getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("the echo of the page's own address change does not undo typing", () => {
    const { container } = render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    const box = screen.getByRole("searchbox", { name: tm.search });
    fireEvent.change(box, { target: { value: "in" } });
    fireEvent.change(box, { target: { value: "int" } });
    mockSearch = "q=in"; // Next reports the older address late
    window.dispatchEvent(new Event("resize"));
    expect((box as HTMLInputElement).value).toBe("int");
    expect(order(container)).toEqual(["Open intro.mp4"]);
  });
});

describe("selection stays on what is shown", () => {
  const start = () => {
    const r = render(wrap(<MediaLibrary orgId={ORG} initial={lib(photos)} />));
    fireEvent.click(screen.getByRole("button", { name: tm.select }));
    return r;
  };
  it("a filter, a search and Back drop hidden files from the selection (bulk actions never reach them)", () => {
    const { container } = start();
    fireEvent.click(screen.getByRole("button", { name: "Select Alpha.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Select intro.mp4" }));
    const count = () => container.querySelector("[data-library-selection] [role=status]")?.textContent;
    expect(count()).toBe("2 selected");
    fireEvent.click(screen.getByRole("button", { name: /^Videos/ }));
    expect(count()).toBe("1 selected");
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(count()).toBe("1 selected");
    fireEvent.change(screen.getByRole("searchbox", { name: tm.search }), { target: { value: "alpha" } });
    expect(count()).toBe("0 selected");
  });

  it("the Shift-click anchor does not survive leaving select mode", () => {
    const { container } = start();
    fireEvent.click(screen.getByRole("button", { name: "Select Alpha.png" }));
    fireEvent.click(screen.getByRole("button", { name: tm.selectDone }));
    fireEvent.click(screen.getByRole("button", { name: tm.select }));
    fireEvent.click(screen.getByRole("button", { name: "Select beach.png" }), { shiftKey: true });
    expect(container.querySelector("[data-library-selection] [role=status]")?.textContent).toBe("1 selected");
  });

  it("scroll-padding keeps focused tiles clear of the bar while select mode is on, and is undone after", () => {
    start();
    expect(document.documentElement.style.scrollPaddingBottom).not.toBe("");
    fireEvent.click(screen.getByRole("button", { name: tm.selectDone }));
    expect(document.documentElement.style.scrollPaddingBottom).toBe("");
  });
});
