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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/x/library",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { MediaLibrary } from "@/components/media/MediaLibrary";
import { parseView } from "@/components/media/libraryView";
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
