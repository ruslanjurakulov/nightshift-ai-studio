// @vitest-environment jsdom
/**
 * The Library's "Edit" link into the image editor (NIGHTSHIFT_IMAGE_EDITOR, default off). What would break without these:
 * a button that appears while the editor's page is a 404, a link to the wrong picture, a link on a file the editor
 * refuses (HEIC, GIF, a video), a nameless icon button for a screen reader, or ru/uz words missing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/x/library",
  useSearchParams: () => new URLSearchParams(),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { MediaLibrary } from "@/components/media/MediaLibrary";
import type { LibraryAsset, MediaKind, MediaLibraryData } from "@/lib/media";

const ORG = "00000000-0000-4000-8000-000000000001";
const e = en.imageEditor;

const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;

let n = 0;
function asset(kind: MediaKind, name: string, mime: string): LibraryAsset {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind,
    mime,
    bytes: 2048,
    width: kind === "audio" ? null : 1920,
    height: kind === "audio" ? null : 1080,
    durationS: kind === "image" ? null : 65,
    source: "upload",
    name,
    variants: ["thumb"],
    version: 1,
    createdAt: "2026-09-01T10:00:00Z",
    thumbUrl: `/api/media/file/x/thumb?sig=${n}`,
    viewUrl: `/api/media/file/x/original?sig=${n}`,
  };
}

const lib = (assets: LibraryAsset[]): MediaLibraryData => ({
  available: true,
  host: { media: true, staging: true, signing: true },
  assets,
  uploads: [],
  quota: { usedBytes: 0, limitBytes: 1_000_000, maxUploadBytes: 100_000 },
});

function open(a: LibraryAsset, all: LibraryAsset[], imageEditor?: boolean) {
  render(withI18n(<MediaLibrary orgId={ORG} initial={lib(all)} imageEditor={imageEditor} />));
  const tile = screen.getAllByRole("button").find((b) => b.getAttribute("aria-label")?.includes(a.name ?? "") || b.textContent?.includes(a.name ?? ""));
  fireEvent.click(tile!);
  return screen.getByRole("dialog");
}

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

describe("Library viewer: Edit link", () => {
  const png = asset("image", "poster.png", "image/png");

  it("flag off (the default): no Edit link", () => {
    const dialog = open(png, [png]);
    expect(within(dialog).queryByRole("link", { name: /image editor/i })).toBeNull();
    expect(dialog.querySelector("[data-edit-image]")).toBeNull();
    expect(dialog.querySelector('a[href*="/editor/image/"]')).toBeNull();
  });

  it("flag explicitly false: no Edit link", () => {
    const dialog = open(png, [png], false);
    expect(dialog.querySelector('a[href*="/editor/image/"]')).toBeNull();
  });

  it("flag on: an Edit link to this picture's editor page, with a name for screen readers", () => {
    const dialog = open(png, [png], true);
    const link = within(dialog).getByRole("link", { name: fmtLabel("poster.png") });
    expect(link.getAttribute("href")).toBe(`/x/editor/image/${png.id}`);
    expect(link.textContent).toContain(e.libraryEdit);
    // A real link: reachable with Tab, activated with Enter by the browser; not a div with a click handler.
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("tabindex")).not.toBe("-1");
    // The icon is decoration only.
    expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // Nothing is fetched or written by showing it.
  });

  it("flag on: the link follows the file when moving to another picture", () => {
    const jpg = asset("image", "photo.jpg", "image/jpeg");
    const dialog = open(png, [png, jpg], true);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    const link = within(screen.getByRole("dialog", { name: "photo.jpg" })).getByRole("link", { name: fmtLabel("photo.jpg") });
    expect(link.getAttribute("href")).toBe(`/x/editor/image/${jpg.id}`);
    expect(dialog).toBeTruthy();
  });

  it.each([
    ["HEIC", "image/heic"],
    ["GIF", "image/gif"],
    ["SVG", "image/svg+xml"],
  ])("flag on: no link on a %s picture (the editor opens JPEG, PNG and WebP only)", (_n, mime) => {
    const other = asset("image", `file.${_n}`, mime);
    const dialog = open(other, [other], true);
    expect(dialog.querySelector('a[href*="/editor/image/"]')).toBeNull();
  });

  it("flag on: no link on a video or a sound", () => {
    const v = asset("video", "clip.mp4", "video/mp4");
    expect(open(v, [v], true).querySelector('a[href*="/editor/image/"]')).toBeNull();
    cleanup();
    const a = asset("audio", "song.mp3", "audio/mpeg");
    expect(open(a, [a], true).querySelector('a[href*="/editor/image/"]')).toBeNull();
  });
});

function fmtLabel(name: string): string {
  return e.libraryEditLabel.replace("{name}", name);
}

describe("Library page wiring", () => {
  it("reads the server flag at request time and passes it down; nothing client-side reads the env", () => {
    const root = resolve(__dirname, "..");
    const page = readFileSync(resolve(root, "app/(app)/[channel]/library/page.tsx"), "utf8");
    expect(page).toContain('import { imageEditorEnabled } from "@/lib/imageEditor/flag"');
    expect(page).toContain("imageEditor={imageEditorEnabled()}");
    for (const f of ["components/media/MediaViewer.tsx", "components/media/MediaLibrary.tsx"]) {
      expect(readFileSync(resolve(root, f), "utf8"), f).not.toMatch(/process\.env|NEXT_PUBLIC_|imageEditorEnabled/);
    }
  });
});

describe("Edit strings: en, ru and uz", () => {
  const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  it.each([
    ["ru", ru],
    ["uz", uz],
  ] as const)("%s has both strings, not empty, not English, with the same {fillers}", (_loc, d) => {
    for (const k of ["libraryEdit", "libraryEditLabel"] as const) {
      expect(d.imageEditor[k], `${_loc}.${k}`).toBeTruthy();
      expect(d.imageEditor[k], `${_loc}.${k}`).not.toBe(e[k]);
      expect(fillers(d.imageEditor[k])).toEqual(fillers(e[k]));
    }
    expect(fillers(e.libraryEditLabel)).toEqual(["name"]);
  });
});
