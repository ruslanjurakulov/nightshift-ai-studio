// @vitest-environment jsdom
/**
 * The library page in a browser-like DOM: a skeleton (never "nothing here
 * yet") until the list has arrived; chips with counts, search and sort; the
 * viewer's keyboard (Escape, ←/→, focus back to the file's tile); bulk delete
 * as the existing DELETE, once per file; and the upload cards' states.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/x/library",
  useSearchParams: () => new URLSearchParams(),
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

it("launches real adapter/UI and Escape returns focus without losing the selected pair", async () => {
  const first = asset("image", "Synthetic_" + "longname".repeat(20) + ".png", 1, { viewUrl: " ", thumbUrl: null });
  const second = asset("image", "Synthetic second.png", 2);
  second.viewUrl = `/api/media/file/${second.id}/display?sig=synthetic`;
  second.thumbUrl = null;
  const rows = [first, second];
  const before = JSON.stringify(rows);
  const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib(rows)} />));
  // Ordinary file opening still reaches the existing viewer, not comparison.
  fireEvent.click(tile(second.name!));
  expect(container.querySelector("[data-media-viewer]")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: tm.viewer.close }));
  fireEvent.click(screen.getByRole("button", { name: tm.select }));
  for (const row of rows) fireEvent.click(screen.getByRole("button", { name: `Select ${row.name}` }));
  const compare = screen.getByRole("button", { name: tm.comparison.action });
  const calls = fetchMock.mock.calls.length;
  const address = window.location.href;
  fireEvent.click(compare);
  const region = screen.getByRole("region", { name: tm.comparison.title });
  expect(within(region).getAllByRole("figure")).toHaveLength(2);
  expect(within(region).getByText(first.name!)).toBeTruthy();
  expect(within(region).getByText(tm.comparison.unavailable)).toBeTruthy();
  expect(within(region).getByRole("img", { name: second.name! }).getAttribute("src")).toBe(second.viewUrl);
  expect(within(region).getAllByText("Version 1")).toHaveLength(2);
  expect(container.querySelector("[data-library-comparison]")).toBe(document.activeElement);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("region", { name: tm.comparison.title })).toBeNull();
  expect(document.activeElement).toBe(compare);
  expect(container.querySelector("[data-library-selection]")?.textContent).toContain("2 selected");
  for (const row of rows) expect(screen.getByRole("button", { name: `Select ${row.name}` }).getAttribute("aria-pressed")).toBe("true");
  expect(fetchMock.mock.calls).toHaveLength(calls);
  expect(window.location.href).toBe(address);
  expect(JSON.stringify(rows)).toBe(before);
});
