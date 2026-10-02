// @vitest-environment jsdom
/**
 * The Style Library page in a browser-like DOM (migration 0065): the grid with
 * its honest "Palette preview" label, search and tag filters that narrow, a
 * detail sheet with the whole direction, "Add to my styles" that creates ONE
 * kit however many times it is pressed, and "Use in Studio" that only FILLS the
 * Studio's style chip — it adds the kit if needed and navigates, and never
 * calls anything that prices, holds credits or starts a job.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/styles",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { fmt } from "@/lib/i18n";
import { StyleLibrary, type AddState } from "@/components/styles/StyleLibrary";
import { STYLE_LIBRARY, libraryStyleById } from "@/lib/styles/library";

const ORG = "0a000000-0000-4000-8000-00000000000a";
const KIT = "0b000000-0000-4000-8000-00000000000b";
const ts = en.styleLibrary;

function ui(props: Partial<{ orgId: string | null; addState: AddState; initialAdded: Record<string, string> }> = {}, locale: "en" | "ru" | "uz" = "en"): ReactNode {
  return (
    <I18nProvider locale={locale}>
      <StyleLibrary orgId={ORG} addState="ready" initialAdded={{}} {...props} />
    </I18nProvider>
  );
}

type FetchCall = { url: string; init?: RequestInit };
let calls: FetchCall[];
let respond: (url: string, init?: RequestInit) => Promise<Response>;

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  calls = [];
  nav.push.mockReset();
  respond = () => json(201, { id: KIT, created: true });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tile = (name: string) => screen.getByRole("button", { name: fmt(ts.open, { name }) });
const body = (c: FetchCall) => JSON.parse(String(c.init?.body)) as Record<string, unknown>;

describe("the grid", () => {
  it("shows every style as a tile labelled 'Palette preview', never as a sample of output", () => {
    render(ui());
    const grid = screen.getAllByRole("listitem").filter((li) => li.querySelector("button[aria-haspopup='dialog']"));
    expect(grid).toHaveLength(STYLE_LIBRARY.length);
    expect(screen.getAllByText(ts.previewLabel)).toHaveLength(STYLE_LIBRARY.length);
    expect(screen.getByText(fmt(ts.count, { n: STYLE_LIBRARY.length, total: STYLE_LIBRARY.length }))).toBeTruthy();
    // No fetch just for looking.
    expect(calls).toEqual([]);
  });

  it("narrows by search and says how many are left; an empty result can be cleared", () => {
    render(ui());
    fireEvent.change(screen.getByRole("searchbox", { name: ts.searchLabel }), { target: { value: "risograph" } });
    expect(screen.getByText(fmt(ts.count, { n: 1, total: STYLE_LIBRARY.length }))).toBeTruthy();
    expect(tile("Two-colour risograph")).toBeTruthy();
    expect(screen.queryByRole("button", { name: fmt(ts.open, { name: "Linocut" }) })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz nothing" } });
    expect(screen.getByText(ts.noMatch)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: ts.clear })[0]);
    expect(screen.getByText(fmt(ts.count, { n: STYLE_LIBRARY.length, total: STYLE_LIBRARY.length }))).toBeTruthy();
  });

  it("filters by tag (aria-pressed), narrows further with a second tag, and clears", () => {
    render(ui());
    const group = screen.getByRole("group", { name: ts.filterLabel });
    const kids = within(group).getByRole("button", { name: ts.tags.kids });
    expect(kids.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(kids);
    expect(kids.getAttribute("aria-pressed")).toBe("true");
    const withKids = STYLE_LIBRARY.filter((s) => s.tags.includes("kids"));
    expect(screen.getByText(fmt(ts.count, { n: withKids.length, total: STYLE_LIBRARY.length }))).toBeTruthy();
    for (const s of withKids) expect(tile(s.name.en)).toBeTruthy();

    fireEvent.click(within(group).getByRole("button", { name: ts.tags.shorts }));
    const both = STYLE_LIBRARY.filter((s) => s.tags.includes("kids") && s.tags.includes("shorts"));
    expect(screen.getByText(fmt(ts.count, { n: both.length, total: STYLE_LIBRARY.length }))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: ts.clear }));
    expect(kids.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(fmt(ts.count, { n: STYLE_LIBRARY.length, total: STYLE_LIBRARY.length }))).toBeTruthy();
  });
});

describe("the detail sheet", () => {
  it("shows the whole direction, the swatch, what it is good for and the formats", () => {
    const s = libraryStyleById("bauhaus-poster")!;
    render(ui());
    fireEvent.click(tile(s.name.en));
    const dialog = screen.getByRole("dialog", { name: s.name.en });
    expect(within(dialog).getByText(s.description)).toBeTruthy();
    expect(within(dialog).getByText(s.goodFor.en)).toBeTruthy();
    for (const hex of s.swatch) expect(within(dialog).getByRole("img", { name: ts.swatch.replace("{hex}", hex) })).toBeTruthy();
    for (const a of s.aspects) expect(within(dialog).getByText(a)).toBeTruthy();
    expect(within(dialog).getByText(ts.previewLabel)).toBeTruthy();
    expect(within(dialog).getByText(ts.useHint)).toBeTruthy();
  });

  it("closes on Escape and the close button, and puts focus back on the tile", () => {
    const s = libraryStyleById("linocut-print")!;
    render(ui());
    const opener = tile(s.name.en);
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: ts.close }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Add to my styles", () => {
  it("creates one kit through the add route with the library id and the person's language — never the text", async () => {
    const s = libraryStyleById("linocut-print")!;
    render(ui({}, "ru"));
    fireEvent.click(screen.getByRole("button", { name: fmt(ru.styleLibrary.open, { name: s.name.ru }) }));
    fireEvent.click(screen.getByRole("button", { name: ru.styleLibrary.add }));
    await waitFor(() => expect(screen.getByText(ru.styleLibrary.justAdded)).toBeTruthy());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/style-library/add");
    expect(calls[0].init?.method).toBe("POST");
    expect(body(calls[0])).toEqual({ library_id: "linocut-print", locale: "ru", org_id: ORG });
    // Now it reads as added, and Add is gone.
    expect(screen.queryByRole("button", { name: ru.styleLibrary.add })).toBeNull();
    expect(screen.getByText(ru.styleLibrary.added)).toBeTruthy();
  });

  it("adds once however many times it is pressed while the request is in flight", async () => {
    let release: (r: Response) => void = () => {};
    respond = () => new Promise<Response>((res) => (release = res));
    render(ui());
    fireEvent.click(tile("Linocut"));
    const add = screen.getByRole("button", { name: ts.add });
    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.click(add);
    expect(calls).toHaveLength(1);
    await act(async () => release(new Response(JSON.stringify({ id: KIT, created: true }), { status: 201 })));
    expect(calls).toHaveLength(1);
  });

  it("never posts for a style that is already in the workspace; the tile says so", () => {
    render(ui({ initialAdded: { "linocut-print": KIT } }));
    expect(within(tile("Linocut")).getByText(ts.addedBadge)).toBeTruthy();
    fireEvent.click(tile("Linocut"));
    expect(screen.queryByRole("button", { name: ts.add })).toBeNull();
    expect(screen.getByText(ts.added)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("when the server says it was already there, says so and adds no second copy", async () => {
    respond = () => json(200, { id: KIT, created: false });
    render(ui());
    fireEvent.click(tile("Linocut"));
    fireEvent.click(screen.getByRole("button", { name: ts.add }));
    await waitFor(() => expect(screen.getByText(ts.alreadyAdded)).toBeTruthy());
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["limit_reached", 409, ts.errors.limit_reached],
    ["forbidden", 403, ts.errors.forbidden],
    ["not_available", 503, ts.errors.not_available],
    ["something else", 502, ts.errors.failed],
  ])("says what went wrong when the server refuses (%s) and leaves it un-added", async (word, status, text) => {
    respond = () => json(status, { error: word });
    render(ui());
    fireEvent.click(tile("Linocut"));
    fireEvent.click(screen.getByRole("button", { name: ts.add }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(text));
    expect(screen.getByRole("button", { name: ts.add })).toBeTruthy();
  });

  it("is disabled, with the reason shown, when there is no workspace or 0065 is not applied; browsing still works", () => {
    for (const [addState, note] of [
      ["no-org", ts.noOrg],
      ["not-enabled", ts.notEnabled],
      ["read-failed", ts.readFailed],
    ] as const) {
      cleanup();
      render(ui({ addState, orgId: addState === "no-org" ? null : ORG }));
      expect(screen.getByText(note)).toBeTruthy();
      fireEvent.click(tile("Linocut"));
      expect((screen.getByRole("button", { name: ts.add }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: ts.useInStudio }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});

describe("Use in Studio", () => {
  it("adds the style if needed, then opens the Studio with that kit as the style — and calls nothing that prices or starts", async () => {
    render(ui());
    fireEvent.click(tile("Linocut"));
    fireEvent.click(screen.getByRole("button", { name: ts.useInStudio }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(1));
    expect(nav.push).toHaveBeenCalledWith(`/chronos/create?tool=t2i&style=${KIT}`);
    // The only request is the add: no quote, no job, no credit hold.
    expect(calls.map((c) => c.url)).toEqual(["/api/style-library/add"]);
    expect(calls.some((c) => /\/api\/creative|quote|jobs|render|publish|credits/.test(c.url))).toBe(false);
  });

  it("goes straight to the Studio when the style is already in the workspace, with no request at all", async () => {
    render(ui({ initialAdded: { "linocut-print": KIT } }));
    fireEvent.click(tile("Linocut"));
    fireEvent.click(screen.getByRole("button", { name: ts.useInStudio }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/chronos/create?tool=t2i&style=${KIT}`));
    expect(calls).toEqual([]);
  });

  it("stays put and says why when the add fails", async () => {
    respond = () => json(403, { error: "forbidden" });
    render(ui());
    fireEvent.click(tile("Linocut"));
    fireEvent.click(screen.getByRole("button", { name: ts.useInStudio }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(ts.errors.forbidden));
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe("languages", () => {
  it.each([
    ["ru", ru],
    ["uz", uz],
  ] as const)("renders in %s: the labels, the names and the tag chips", (locale, d) => {
    render(ui({}, locale));
    expect(screen.getAllByText(d.styleLibrary.previewLabel).length).toBe(STYLE_LIBRARY.length);
    const s = libraryStyleById("samarkand-golden-hour")!;
    expect(screen.getByRole("button", { name: fmt(d.styleLibrary.open, { name: s.name[locale] }) })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: d.styleLibrary.filterLabel })).getByRole("button", { name: d.styleLibrary.tags.history })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: d.styleLibrary.searchLabel })).toBeTruthy();
  });
});
