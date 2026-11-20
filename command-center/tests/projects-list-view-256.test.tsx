// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { filmStudioEn as t } from "../lib/i18n/film-studio/en";
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale() {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (path: string) => `/synthetic${path}` }));
import { FilmList } from "../components/films/FilmList";
const KEY = "ns.studio.projects.view.v1";
const mount = (available = true) => render(<FilmList initial={available ? { state: "ok", films: [] } : { state: "not_available" }} canEdit={false} channel={null} studioName="Studio" />);
const answer = (title?: string) => new Response(JSON.stringify({ films: title ? [{ id: "11111111-1111-4111-8111-111111111111", title, status: "draft", language: "en", aspect: "16:9", targetSeconds: 300 }] : [] }), { status: 200 });
beforeEach(() => { window.localStorage.clear(); vi.stubGlobal("fetch", vi.fn(async () => answer())); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("256 Studio Projects browser view preference", () => {
  it("remembers only the selected enum and restores Archived via the existing list read", async () => {
    const first = mount();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t.list.viewArchived }));
    await waitFor(() => expect(screen.getByTestId("fs-empty")).toBeTruthy());
    expect(window.localStorage.getItem(KEY)).toBe("archived");
    first.unmount();
    mount();
    await waitFor(() => expect(screen.getByTestId("fs-empty")).toBeTruthy());
    expect(screen.getByRole("button", { name: t.list.viewArchived }).getAttribute("aria-pressed")).toBe("true");
    expect(fetch).toHaveBeenLastCalledWith("/api/films?archived=1", expect.objectContaining({ method: "GET" }));
    fireEvent.click(screen.getByRole("button", { name: t.list.viewOpen }));
    expect(window.localStorage.getItem(KEY)).toBe("open");
  });

  it.each(["bogus", "{}", "null", '"archived"'])("ignores unsupported preference bytes %s without deleting or rewriting them", (raw) => {
    window.localStorage.setItem(KEY, raw);
    mount();
    expect(screen.getByRole("button", { name: t.list.viewOpen }).getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem(KEY)).toBe(raw);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a throwing storage getter uses Open and still lets the viewer switch locally", async () => {
    const getter = vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw Error("blocked"); });
    mount();
    expect(screen.getByRole("button", { name: t.list.viewOpen }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: t.list.viewArchived }));
    await waitFor(() => expect(screen.getByTestId("fs-empty")).toBeTruthy());
    expect(screen.getByRole("button", { name: t.list.viewArchived }).getAttribute("aria-pressed")).toBe("true");
    getter.mockRestore();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("write refusal keeps the selection in memory without changing any existing storage", async () => {
    window.localStorage.setItem("unrelated-safe-key", "unchanged");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("quota"); });
    mount();
    fireEvent.click(screen.getByRole("button", { name: t.list.viewArchived }));
    await waitFor(() => expect(screen.getByTestId("fs-empty")).toBeTruthy());
    expect(screen.getByRole("button", { name: t.list.viewArchived }).getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem("unrelated-safe-key")).toBe("unchanged");
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("a remembered view never activates an unavailable list or makes an API call", () => {
    window.localStorage.setItem(KEY, "archived");
    mount(false);
    expect(screen.getByText(t.notAvailable)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an older restore response cannot replace the subsequently selected view's rows", async () => {
    window.localStorage.setItem(KEY, "archived");
    let release!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("archived") ? new Promise<Response>((resolve) => { release = resolve; }) : Promise.resolve(answer("Latest open selection"))));
    mount();
    fireEvent.click(screen.getByRole("button", { name: t.list.viewOpen }));
    await screen.findByText("Latest open selection");
    await act(async () => { release(answer("Old archived response")); });
    expect(screen.queryByText("Old archived response")).toBeNull();
    expect(screen.getByText("Latest open selection")).toBeTruthy();
    expect(window.localStorage.getItem(KEY)).toBe("open");
  });
});
