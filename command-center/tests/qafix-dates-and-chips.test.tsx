// @vitest-environment jsdom
/**
 * QA fixes: dates in the editor project list and the library hydrate in any time zone (the server prints UTC,
 * the browser then swaps in the viewer's own time), and the library's folder chips are 44 px tall on a phone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/editor",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { EditorHome } from "@/components/editor/EditorHome";
import { formatDayTime } from "@/lib/date-format";

const ORG = "00000000-0000-4000-8000-000000000001";
// 20:30 UTC on the 24th is already the 25th, 01:30, in Tashkent (UTC+5).
const WHEN = "2026-10-24T20:30:00Z";

function page(locale: "en" | "ru" | "uz"): ReactNode {
  return (
    <I18nProvider locale={locale}>
      <EditorHome orgId={ORG} projects={[{ id: "p1", title: "Trip", updatedAt: WHEN }]} videos={[]} />
    </I18nProvider>
  );
}

afterEach(() => {
  delete process.env.TZ;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("formatDayTime pins a zone when asked", () => {
  it("UTC for the server's first render, the viewer's own time otherwise", () => {
    process.env.TZ = "Asia/Tashkent";
    expect(new Date(WHEN).getTimezoneOffset()).toBe(-300);
    const d = new Date(WHEN);
    expect(formatDayTime(d, "uz", "UTC")).toBe("24-okt, 2026, 20:30");
    expect(formatDayTime(d, "uz")).toBe("25-okt, 2026, 01:30");
    expect(formatDayTime(d, "en", "UTC")).toContain("8:30");
    expect(formatDayTime(d, "en")).not.toBe(formatDayTime(d, "en", "UTC"));
  });
});

describe("the editor's project list hydrates for a viewer who is not on UTC", () => {
  it.each(["en", "ru", "uz"] as const)("%s: no hydration error, then the viewer's own time", async (locale) => {
    process.env.TZ = "Asia/Tashkent";
    const html = renderToString(page(locale));
    expect(html).toContain(formatDayTime(new Date(WHEN), locale, "UTC").replace(/ /g, " "));
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a));
    await act(async () => {
      hydrateRoot(host, page(locale), { onRecoverableError: (e) => errors.push(e) });
    });
    expect(errors).toEqual([]);
    spy.mockRestore();
    expect(host.textContent).toContain(formatDayTime(new Date(WHEN), locale));
    expect(host.textContent).not.toContain(formatDayTime(new Date(WHEN), locale, "UTC"));
  });
});

describe("no render path formats a date without a pinned zone on first render", () => {
  it.each(["components/editor/EditorHome.tsx", "components/media/MediaLibrary.tsx", "components/media/MediaViewer.tsx"])("%s", (file) => {
    const src = readFileSync(path.join(__dirname, "..", file), "utf8");
    expect(src).not.toMatch(/toLocaleString\(|new Intl\.DateTimeFormat\(/);
  });
});

describe("library folder chips", () => {
  it("are 44 px tall on a phone (the chip and the new-folder button)", () => {
    const src = readFileSync(path.join(__dirname, "..", "components/media/FolderRail.tsx"), "utf8");
    expect(src.match(/max-lg:min-h-11/g)?.length).toBe(2);
  });
});
