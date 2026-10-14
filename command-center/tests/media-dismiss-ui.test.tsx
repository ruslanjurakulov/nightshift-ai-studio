// @vitest-environment jsdom
/**
 * Dismissing refused and expired upload cards in the library.
 *
 * What would break without these: a card still on its way getting a Dismiss
 * button; the card staying after the server said yes (or leaving after it said
 * no); keyboard focus falling to the top of the page when the focused card
 * goes; a screen reader hearing nothing; a second press while one is running;
 * and the control missing from Russian or Uzbek.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import type { MediaLibraryData, MediaUpload } from "@/lib/media";

const ORG = "00000000-0000-4000-8000-000000000001";
const tm = en.media;
const withI18n = (ui: ReactNode, locale: "en" | "ru" | "uz" = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;

let n = 0;
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

function lib(uploads: MediaUpload[]): MediaLibraryData {
  return {
    available: true,
    host: { media: true, staging: true, signing: true },
    assets: [],
    uploads,
    quota: { usedBytes: 0, limitBytes: 1_000_000, maxUploadBytes: 100_000 },
  };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(() => json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const dismissButtons = () => screen.queryAllByRole("button", { name: /^Dismiss / });
const dismissCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/dismiss"));

describe("which cards get the button", () => {
  it("only refused and expired ones; a card still on its way has none", () => {
    const rows = [
      up("rejected", "empty.png", "empty"),
      up("expired", "late.mov", "upload_window_passed"),
      up("requested", "a.png"),
      up("receiving", "b.png"),
      up("uploaded", "c.png"),
      up("ingesting", "d.png"),
    ];
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib(rows)} />));
    expect(container.querySelectorAll("[data-upload-status]")).toHaveLength(6);
    expect(dismissButtons().map((b) => b.getAttribute("aria-label")).sort()).toEqual(["Dismiss empty.png", "Dismiss late.mov"]);
    expect(dismissButtons()).toHaveLength(2);
    for (const card of container.querySelectorAll("[data-upload-status]")) {
      const status = card.getAttribute("data-upload-status");
      const has = within(card as HTMLElement).queryByRole("button") !== null;
      expect(has, String(status)).toBe(status === "rejected" || status === "expired");
    }
  });

  it("the button is a real button, 44px class, named after its card, and reachable by Tab", () => {
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([up("rejected", "empty.png", "empty")])} />));
    const b = screen.getByRole("button", { name: "Dismiss empty.png" });
    expect(b.tagName).toBe("BUTTON");
    expect(b.textContent).toBe(tm.dismiss);
    expect(b.getAttribute("tabindex")).toBeNull();
    // btn-quiet is min-height 2.75rem on every screen (globals.css).
    expect(b.className).toContain("btn-quiet");
    // The visible word starts the accessible name (label in name).
    expect(b.getAttribute("aria-label")?.startsWith(b.textContent ?? "?")).toBe(true);
  });
});

describe("dismissing", () => {
  it("asks the server once for that ticket, removes the card, and says so in the live region", async () => {
    const a = up("rejected", "empty.png", "empty");
    const b = up("expired", "late.mov", "upload_window_passed");
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b])} />));
    const live = container.querySelector("[data-library-notice]") as HTMLElement;
    expect(live.getAttribute("role")).toBe("status");
    expect(live.getAttribute("aria-live")).toBe("polite");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss empty.png" }));
    });
    await waitFor(() => expect(container.querySelectorAll("[data-upload-status]")).toHaveLength(1));
    expect(dismissCalls()).toHaveLength(1);
    expect(dismissCalls()[0][0]).toBe(`/api/media/uploads/${a.id}/dismiss`);
    expect((dismissCalls()[0][1] as RequestInit).method).toBe("POST");
    expect(screen.queryByText("empty.png")).toBeNull();
    expect(screen.getByText("late.mov")).toBeTruthy();
    expect(live.textContent).toBe("“empty.png” removed from your list.");
  });

  it("focus moves to the next card's button, then to the previous one, so it is never lost", async () => {
    const rows = [up("rejected", "one.png", "empty"), up("rejected", "two.png", "empty"), up("rejected", "three.png", "empty")];
    // The list shows newest first; all share a date, so find the order on screen.
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib(rows)} />));
    const order = () => dismissButtons().map((b) => b.getAttribute("aria-label")!.replace("Dismiss ", ""));
    const first = order();
    expect(first).toHaveLength(3);

    // Dismiss the middle one: focus lands on the one that followed it.
    const middle = screen.getByRole("button", { name: `Dismiss ${first[1]}` });
    middle.focus();
    await act(async () => {
      fireEvent.click(middle);
    });
    await waitFor(() => expect(dismissButtons()).toHaveLength(2));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: `Dismiss ${first[2]}` }));

    // Dismiss the last one: nothing follows, so focus goes to the one before.
    await act(async () => {
      fireEvent.click(document.activeElement as HTMLElement);
    });
    await waitFor(() => expect(dismissButtons()).toHaveLength(1));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: `Dismiss ${first[0]}` }));
  });

  it("the last card to go leaves focus on the search box when there are files, else on the file picker", async () => {
    // Nothing else in the library: the page falls back to its empty state, which has no search box.
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([up("expired", "late.mov", "upload_window_passed")])} />));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss late.mov" }));
    });
    await waitFor(() => expect(dismissButtons()).toHaveLength(0));
    expect(document.activeElement).toBe(container.querySelector('input[type="file"]'));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("with files still in the library, focus lands on the search box", async () => {
    const file = {
      id: "10000000-0000-4000-8000-000000000001",
      kind: "image" as const,
      mime: "image/png",
      bytes: 10,
      width: 1,
      height: 1,
      durationS: null,
      source: "upload" as const,
      name: "keep.png",
      variants: [],
      version: 1,
      createdAt: "2026-09-01T00:00:00Z",
      thumbUrl: null,
      viewUrl: null,
    };
    render(withI18n(<MediaLibrary orgId={ORG} initial={{ ...lib([up("expired", "late.mov", "upload_window_passed")]), assets: [file] }} />));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss late.mov" }));
    });
    await waitFor(() => expect(dismissButtons()).toHaveLength(0));
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });

  it("a refusal keeps the card, keeps focus on its button, and says why", async () => {
    const row = up("rejected", "empty.png", "empty");
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith("/dismiss") ? json({ error: "not_dismissable" }, 409) : json(lib([row])),
    );
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([row])} />));
    const b = screen.getByRole("button", { name: "Dismiss empty.png" });
    b.focus();
    await act(async () => {
      fireEvent.click(b);
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(tm.errors.not_dismissable));
    expect(container.querySelectorAll("[data-upload-status]")).toHaveLength(1);
    expect(document.activeElement).toBe(b);
    expect(b.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("a lost connection keeps the card and says the connection failed", async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith("/dismiss") ? Promise.reject(new Error("offline")) : json(lib([up("rejected", "empty.png", "empty")])),
    );
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([up("rejected", "empty.png", "empty")])} />));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss empty.png" }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(tm.errors.network));
    expect(screen.getByText("empty.png")).toBeTruthy();
  });

  it("a card the server no longer knows leaves the list instead of staying stuck", async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith("/dismiss") ? json({ error: "not_found" }, 404) : json(lib([])),
    );
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([up("rejected", "empty.png", "empty")])} />));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss empty.png" }));
    });
    await waitFor(() => expect(container.querySelectorAll("[data-upload-status]")).toHaveLength(0));
  });

  it("while one dismissal runs, another press does nothing and the button says it is working", async () => {
    let finish!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (finish = r)));
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([up("rejected", "one.png", "empty"), up("rejected", "two.png", "empty")])} />));
    const [first, second] = dismissButtons();
    await act(async () => {
      fireEvent.click(first);
    });
    expect(first.textContent).toBe(tm.dismissing);
    expect(first.getAttribute("aria-disabled")).toBe("true");
    expect(second.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(first);
      fireEvent.click(second);
    });
    expect(dismissCalls()).toHaveLength(1);
    await act(async () => {
      finish(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    await waitFor(() => expect(dismissButtons()).toHaveLength(1));
  });
});

describe("words", () => {
  it("Russian and Uzbek have the control, and it is not English", () => {
    for (const [locale, d] of [["ru", ru], ["uz", uz]] as const) {
      cleanup();
      render(withI18n(<MediaLibrary orgId={ORG} initial={lib([up("rejected", "empty.png", "empty")])} />, locale));
      const b = screen.getByRole("button", { name: d.media.dismissItem.replace("{name}", "empty.png") });
      expect(b.textContent).toBe(d.media.dismiss);
      expect(d.media.dismiss).not.toBe(en.media.dismiss);
      expect(d.media.errors.not_dismissable).not.toBe(en.media.errors.not_dismissable);
    }
  });

  it("the copy names no role and no provider", () => {
    const words = [en, ru, uz].flatMap((d) => [d.media.dismiss, d.media.dismissItem, d.media.dismissing, d.media.dismissed, d.media.errors.not_dismissable]);
    for (const w of words) expect(w).not.toMatch(/owner|editor|viewer|admin|владел|редактор|наблюдател|egasi|muharrir|kuzatuvchi/i);
  });
});
