// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { filmStudioStrings } from "@/lib/i18n/film-studio";

const h = vi.hoisted(() => ({
  enabled: true,
  locale: "en" as "en" | "ru" | "uz",
  supported: true,
  current: { id: "synthetic-org", role: "owner" } as { id: string; role: string } | null,
  client: {} as object | null,
  read: { ok: true, films: [] } as { ok: true; films: unknown[] } | { ok: false; error: "failed" | "not_available" },
}));
vi.mock("@/lib/server/films", () => ({ filmStudioOpen: vi.fn(async () => h.enabled), listFilms: vi.fn(async () => h.read) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => h.client) }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: vi.fn(async () => ({ supported: h.supported, current: h.current })) }));
vi.mock("@/lib/channels-server", () => ({ getChannelContext: vi.fn(async () => ({ selection: "all-channels", channels: [] })) }));
vi.mock("@/lib/channels", () => ({ isScoped: () => false }));
vi.mock("@/lib/i18n/server", () => ({ getDictionary: async () => ({ locale: h.locale, t: { org: { notMigrated: "Synthetic migration notice" }, nav: { hub: "Synthetic Studio" } } }) }));
vi.mock("@/components/g3/Section", () => ({ Note: ({ children }: { children: ReactNode }) => <p>{children}</p> }));
vi.mock("@/components/films/FilmList", () => ({ FilmList: vi.fn(() => <div data-testid="existing-film-list" />) }));

import { FilmProjectsShelf } from "@/components/studio-hub/FilmProjectsShelf";
import { FilmList } from "@/components/films/FilmList";
import { filmStudioOpen, listFilms } from "@/lib/server/films";
import { createClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { getChannelContext } from "@/lib/channels-server";

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h, { enabled: true, locale: "en", supported: true, current: { id: "synthetic-org", role: "owner" }, client: {}, read: { ok: true, films: [] } });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network in shelf fixture"); }));
});
afterEach(() => { cleanup(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("Film shelf client initialization notice", () => {
  it.each(["en", "ru", "uz"] as const)("keeps a named noninteractive shelf with its existing %s read-failure copy", async (locale) => {
    h.locale = locale;
    h.client = null;
    render(await FilmProjectsShelf());
    const s = filmStudioStrings(locale);
    const region = screen.getByRole("region", { name: s.tagline });
    expect(region.getAttribute("data-studio-shelf")).toBe("films");
    expect(screen.getByRole("status").textContent).toBe(s.list.loadFailed);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByTestId("existing-film-list")).toBeNull();
    expect(listFilms).not.toHaveBeenCalled();
    expect(getChannelContext).not.toHaveBeenCalled();
  });
  it("keeps the feature-off branch hidden without initializing member/client reads", async () => {
    h.enabled = false;
    expect(await FilmProjectsShelf()).toBeNull();
    expect(filmStudioOpen).toHaveBeenCalledOnce();
    expect(getOrgContext).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(listFilms).not.toHaveBeenCalled();
  });
  it.each(["unsupported", "no-org"] as const)("preserves the existing %s notice before initializing the client", async (state) => {
    if (state === "unsupported") h.supported = false;
    else h.current = null;
    render(await FilmProjectsShelf());
    expect(screen.getByText(state === "unsupported" ? "Synthetic migration notice" : filmStudioStrings("en").noOrg)).toBeTruthy();
    expect(createClient).not.toHaveBeenCalled();
    expect(listFilms).not.toHaveBeenCalled();
  });
  it.each(["owner", "viewer"])("passes successful empty reads through to the original FilmList with the same %s editing role", async (role) => {
    h.current = { id: "synthetic-org", role };
    render(await FilmProjectsShelf());
    const props = vi.mocked(FilmList).mock.calls.at(-1)![0];
    expect(props.initial).toEqual({ state: "ok", films: [] });
    expect(props.canEdit).toBe(role === "owner");
    expect(listFilms).toHaveBeenCalledWith(h.client, "synthetic-org", false);
    expect(screen.queryByRole("status")).toBeNull();
  });
  it.each(["failed", "not_available"] as const)("keeps the existing %s read-state handling in FilmList", async (error) => {
    h.read = { ok: false, error };
    render(await FilmProjectsShelf());
    const props = vi.mocked(FilmList).mock.calls.at(-1)![0];
    expect(props.initial).toEqual({ state: error === "not_available" ? "not_available" : "failed" });
    expect(screen.getByTestId("existing-film-list")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
