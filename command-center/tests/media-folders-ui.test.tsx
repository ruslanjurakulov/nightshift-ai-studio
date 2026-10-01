// @vitest-environment jsdom
/**
 * Library folders in a browser-like DOM (migration 0049): the rail (All
 * files, each folder with its count, New folder), a folder's menu (rename,
 * delete with a confirmation that says the files stay), select → "Move to…"
 * as ONE call to /api/media/move, search that asks the server when the page
 * does not hold the whole library, the database's refusals said as sentences,
 * and focus that always lands somewhere real when a dialog closes.
 *
 * Before 0049 is applied the page has no folders at all: no rail, no Move.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/x/library",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { fmt } from "@/lib/i18n";
import { MediaLibrary } from "@/components/media/MediaLibrary";
import type { LibraryAsset, MediaLibraryData } from "@/lib/media";
import type { MediaFolder } from "@/lib/media-folders";

const ORG = "00000000-0000-4000-8000-000000000001";
const BRAND = "f0000000-0000-4000-8000-000000000001";
const CLIENT = "f0000000-0000-4000-8000-000000000002";
const NEW = "f0000000-0000-4000-8000-000000000003";
const tm = en.media;
const tf = en.media.folders;

function withI18n(ui: ReactNode) {
  return <I18nProvider locale="en">{ui}</I18nProvider>;
}

let n = 0;
function asset(name: string, folderId: string | null, extra: Partial<LibraryAsset> = {}): LibraryAsset {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind: "image",
    mime: "image/png",
    bytes: 2048,
    width: 640,
    height: 480,
    durationS: null,
    source: "upload",
    name,
    variants: ["thumb"],
    version: 1,
    createdAt: `2026-09-${String(10 + (n % 15)).padStart(2, "0")}T10:00:00Z`,
    thumbUrl: `/api/media/file/x/thumb?sig=${n}`,
    viewUrl: `/api/media/file/x/original?sig=${n}`,
    folderId,
    ...extra,
  };
}

const FOLDERS: MediaFolder[] = [
  { id: BRAND, name: "Brand", count: 2 },
  { id: CLIENT, name: "Client work", count: null },
];

function lib(assets: LibraryAsset[], over: Partial<MediaLibraryData> = {}, folders: MediaFolder[] = FOLDERS): MediaLibraryData {
  return {
    available: true,
    host: { media: true, staging: true, signing: true },
    assets,
    uploads: [],
    quota: { usedBytes: 0, limitBytes: 1_000_000, maxUploadBytes: 100_000 },
    folders: { available: true, folders, total: assets.length, unfiled: null },
    folder: null,
    query: "",
    truncated: false,
    ...over,
  };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

type Route = (url: string, init?: RequestInit) => Promise<Response> | undefined;
let routes: Route[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
const calls = (method: string, prefix: string) =>
  fetchMock.mock.calls.filter(([u, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === method && String(u).startsWith(prefix));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  routes = [];
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    for (const r of routes) {
      const res = r(url, init);
      if (res) return res;
    }
    return json(lib([]));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

const rail = () => screen.getByRole("navigation", { name: tf.rail });

describe("the rail", () => {
  const a = asset("logo.png", BRAND);
  const b = asset("cover.png", BRAND);
  const c = asset("loose.png", null);

  it("lists All files and each folder with its count; an unknown count is not a number", () => {
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b, c])} />));
    const items = within(rail()).getAllByRole("button");
    expect(items.map((x) => x.getAttribute("aria-label") ?? x.textContent)).toEqual([
      "All files, 3 files",
      "Brand, 2 files",
      "Client work",
      tf.newFolder,
    ]);
    expect(items[0].getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("heading", { name: tf.allFiles })).toBeTruthy();
  });

  it("choosing a folder narrows the grid at once and reads that folder from the server", async () => {
    routes.push((url) => (url.includes(`folder=${BRAND}`) ? json(lib([a, b], { folder: BRAND })) : undefined));
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b, c])} />));
    fireEvent.click(within(rail()).getByRole("button", { name: "Brand, 2 files" }));
    // Before the answer: the loose file is already gone from a folder's view.
    expect(container.querySelectorAll("[data-asset-kind]")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Brand" })).toBeTruthy();
    await waitFor(() => expect(calls("GET", "/api/media?")).toHaveLength(1));
    expect(calls("GET", "/api/media?")[0][0]).toBe(`/api/media?org=${ORG}&folder=${BRAND}`);
    expect(within(rail()).getByRole("button", { name: "Brand, 2 files" }).getAttribute("aria-current")).toBe("true");
    // An upload made now lands in this folder (0051), and the folder says so.
    expect(screen.getByText(new RegExp(tf.uploadsLandHere))).toBeTruthy();
  });

  it("an empty folder says how to fill it", () => {
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([], { folder: CLIENT }, FOLDERS)} />));
    expect(container.querySelector("[data-folder-empty]")?.textContent).toContain(tf.emptyFolder);
    expect(container.querySelector("[data-library-empty]")).toBeNull();
  });

  it("before 0049 there is no rail and no Move — the library works as before", () => {
    const old = lib([a, c], { folders: { available: false, folders: [], total: null, unfiled: null } });
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={old} />));
    expect(container.querySelector("[data-folder-rail]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: tm.select }));
    expect(screen.queryByRole("button", { name: tf.moveTo })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete (0)" })).toBeTruthy();
  });
});

describe("creating, renaming and deleting a folder", () => {
  it("New folder: a named dialog, one POST, then that folder is open", async () => {
    routes.push((url, init) => (url === "/api/media/folders" && init?.method === "POST" ? json({ id: NEW, name: "Shorts" }, 201) : undefined));
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([asset("x.png", null)])} />));
    fireEvent.click(within(rail()).getByRole("button", { name: tf.newFolder }));
    const dialog = screen.getByRole("dialog", { name: tf.createTitle });
    const input = within(dialog).getByRole("textbox", { name: tf.nameLabel });
    expect(document.activeElement).toBe(input);
    expect((within(dialog).getByRole("button", { name: tf.create }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "  Shorts " } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: tf.create }));
    });
    expect(bodyOf(calls("POST", "/api/media/folders")[0])).toEqual({ org_id: ORG, name: "Shorts" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(fmt(tf.created, { name: "Shorts" }))).toBeTruthy();
    await waitFor(() => expect(calls("GET", "/api/media?").map(([u]) => u)).toContain(`/api/media?org=${ORG}&folder=${NEW}`));
  });

  it("a refusal is a sentence in the dialog, which stays open with what was typed; Escape returns focus", async () => {
    routes.push((url, init) => (url === "/api/media/folders" && init?.method === "POST" ? json({ error: "name_taken" }, 409) : undefined));
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([asset("x.png", null)])} />));
    const opener = within(rail()).getByRole("button", { name: tf.newFolder });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: tf.createTitle });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Brand" } });
    await act(async () => {
      fireEvent.submit(within(dialog).getByRole("textbox").closest("form")!);
    });
    expect(within(dialog).getByRole("alert").textContent).toBe(tf.errors.name_taken);
    expect((within(dialog).getByRole("textbox") as HTMLInputElement).value).toBe("Brand");

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("Rename from the folder's menu: prefilled, one PATCH", async () => {
    routes.push((url, init) => (url === `/api/media/folders/${BRAND}` && init?.method === "PATCH" ? json({ id: BRAND, name: "Brand 2026" }) : undefined));
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([asset("logo.png", BRAND)], { folder: BRAND })} />));
    const menu = screen.getByRole("button", { name: tf.actions });
    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.click(items[0]);

    const dialog = screen.getByRole("dialog", { name: tf.renameTitle });
    const input = within(dialog).getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Brand");
    fireEvent.change(input, { target: { value: "Brand 2026" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: tf.save }));
    });
    expect(bodyOf(calls("PATCH", "/api/media/folders/")[0])).toEqual({ name: "Brand 2026" });
    expect(screen.getByText(fmt(tf.renamed, { name: "Brand 2026" }))).toBeTruthy();
  });

  it("the menu closes on Escape and gives focus back to its button", () => {
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([asset("logo.png", BRAND)], { folder: BRAND })} />));
    const menu = screen.getByRole("button", { name: tf.actions });
    fireEvent.click(menu);
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it("Delete asks first, says the files stay, starts on Cancel; then All files is open and focused", async () => {
    routes.push((url, init) => (url === `/api/media/folders/${BRAND}` && init?.method === "DELETE" ? json({ ok: true }) : undefined));
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([asset("logo.png", BRAND), asset("b.png", BRAND)], { folder: BRAND })} />));
    fireEvent.click(screen.getByRole("button", { name: tf.actions }));
    fireEvent.click(screen.getAllByRole("menuitem")[1]);

    const dialog = screen.getByRole("dialog", { name: fmt(tf.deleteTitle, { name: "Brand" }) });
    expect(dialog.textContent).toContain("Its files (2 files) stay in the library, in All files. Only the folder goes.");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: tf.cancel }));
    expect(calls("DELETE", "/api/media/folders/")).toHaveLength(0);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: tf.delete }));
    });
    expect(calls("DELETE", "/api/media/folders/")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(tf.deleted)).toBeTruthy();
    const all = within(rail()).getByRole("button", { name: /^All files/ });
    expect(all.getAttribute("aria-current")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(all));
  });

  it("a folder whose count could not be read does not claim a number", () => {
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([asset("w.png", CLIENT)], { folder: CLIENT })} />));
    fireEvent.click(screen.getByRole("button", { name: tf.actions }));
    fireEvent.click(screen.getAllByRole("menuitem")[1]);
    expect(screen.getByRole("dialog").textContent).toContain(tf.deleteBodyUnknown);
  });
});

describe("select → Move to…", () => {
  const a = asset("a.png", null);
  const b = asset("b.png", null);
  const c = asset("c.png", BRAND);

  beforeEach(() => {
    // The list the page reads back after an action.
    routes.push((url, init) => (url.startsWith("/api/media?") && !init?.method ? json(lib([a, b, c])) : undefined));
  });

  function pick(...names: string[]) {
    fireEvent.click(screen.getByRole("button", { name: tm.select }));
    for (const nm of names) fireEvent.click(screen.getByRole("button", { name: `Select ${nm}` }));
  }

  it("moves the selection in ONE call, then says where they went and puts focus back on Select", async () => {
    routes.push((url) => (url === "/api/media/move" ? json({ ok: true, moved: 2, folder_id: BRAND }) : undefined));
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b, c])} />));
    pick("a.png", "b.png");
    fireEvent.click(screen.getByRole("button", { name: tf.moveTo }));

    const sheet = screen.getByRole("dialog", { name: "Move 2 files" });
    // Both are in no folder: that row is "here now" and cannot be chosen.
    const none = within(sheet).getByRole("button", { name: new RegExp(tf.noFolder) });
    expect((none as HTMLButtonElement).disabled).toBe(true);
    expect(none.textContent).toContain(tf.here);
    // Focus starts on the first place they can go.
    expect(document.activeElement?.textContent).toContain("Brand");

    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: /Brand/ }));
    });
    const moves = calls("POST", "/api/media/move");
    expect(moves).toHaveLength(1);
    expect(bodyOf(moves[0])).toEqual({ org_id: ORG, folder_id: BRAND, asset_ids: [a.id, b.id] });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("2 files moved to “Brand”.")).toBeTruthy();
    expect(screen.queryByText(fmt(tm.selectedCount, { n: 2 }))).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: tm.select })));
  });

  it("'No folder' takes files out of their folder", async () => {
    routes.push((url) => (url === "/api/media/move" ? json({ ok: true, moved: 1, folder_id: null }) : undefined));
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b, c])} />));
    pick("c.png");
    fireEvent.click(screen.getByRole("button", { name: tf.moveTo }));
    const sheet = screen.getByRole("dialog");
    // c.png is in Brand: Brand is "here now".
    expect((within(sheet).getByRole("button", { name: /Brand/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: new RegExp(tf.noFolder) }));
    });
    expect(bodyOf(calls("POST", "/api/media/move")[0]).folder_id).toBeNull();
    expect(screen.getByText("1 file taken out of their folder.")).toBeTruthy();
  });

  it("a refusal is said in the sheet and nothing closes", async () => {
    routes.push((url) => (url === "/api/media/move" ? json({ error: "invalid_asset" }, 400) : undefined));
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b, c])} />));
    pick("a.png");
    fireEvent.click(screen.getByRole("button", { name: tf.moveTo }));
    const sheet = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: /Client work/ }));
    });
    expect(within(sheet).getByRole("alert").textContent).toBe(tf.errors.invalid_asset);
    expect(screen.getByText(fmt(tm.selectedCount, { n: 1 }))).toBeTruthy();
  });

  it("a network failure is a sentence too, never a silent nothing", async () => {
    routes.push((url) => (url === "/api/media/move" ? Promise.reject(new TypeError("offline")) : undefined));
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b, c])} />));
    pick("a.png");
    fireEvent.click(screen.getByRole("button", { name: tf.moveTo }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Brand/ }));
    });
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toBe(tf.errors.network);
  });

  it("New folder for these files: creates it, then moves into it", async () => {
    routes.push((url, init) => (url === "/api/media/folders" && init?.method === "POST" ? json({ id: NEW, name: "Picks" }, 201) : undefined));
    routes.push((url) => (url === "/api/media/move" ? json({ ok: true, moved: 1, folder_id: NEW }) : undefined));
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b, c])} />));
    pick("b.png");
    fireEvent.click(screen.getByRole("button", { name: tf.moveTo }));
    const sheet = screen.getByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: tf.newAndMove }));
    fireEvent.change(within(sheet).getByRole("textbox", { name: tf.nameLabel }), { target: { value: "Picks" } });
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: tf.createAndMove }));
    });
    expect(bodyOf(calls("POST", "/api/media/folders")[0])).toEqual({ org_id: ORG, name: "Picks" });
    expect(bodyOf(calls("POST", "/api/media/move")[0])).toEqual({ org_id: ORG, folder_id: NEW, asset_ids: [b.id] });
    expect(screen.getByText("1 file moved to “Picks”.")).toBeTruthy();
  });

  it("Select all picks every file the grid shows, and clears again", () => {
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b, c])} />));
    fireEvent.click(screen.getByRole("button", { name: tm.select }));
    fireEvent.click(screen.getByRole("button", { name: tf.selectAll }));
    expect(screen.getByText(fmt(tm.selectedCount, { n: 3 }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tf.clearSelection }));
    expect(screen.getByText(fmt(tm.selectedCount, { n: 0 }))).toBeTruthy();
  });

  it("the existing actions stay: bulk delete is still the DELETE once per file", async () => {
    routes.push((url, init) => (init?.method === "DELETE" ? json({ ok: true, deleted: true }) : undefined));
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a, b, c])} />));
    pick("a.png", "c.png");
    fireEvent.click(screen.getByRole("button", { name: "Delete (2)" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete (2)" }));
    });
    expect(calls("DELETE", "/api/media/").map(([u]) => u).sort()).toEqual([`/api/media/${a.id}`, `/api/media/${c.id}`].sort());
    expect(calls("POST", "/api/media/move")).toHaveLength(0);
  });
});

describe("search", () => {
  it("a page that holds the whole library is searched here, with no request", async () => {
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([asset("beach.png", null), asset("city.png", BRAND)])} />));
    fireEvent.change(screen.getByRole("searchbox", { name: tm.search }), { target: { value: "BEA" } });
    expect(container.querySelectorAll("[data-asset-kind]")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 450));
    expect(calls("GET", "/api/media?")).toHaveLength(0);
  });

  it("a full page says there are more, and the search then asks the server", async () => {
    const page = Array.from({ length: 3 }, (_, i) => asset(`file-${i}.png`, null));
    const full = lib(page, { truncated: true, folders: { available: true, folders: FOLDERS, total: 950, unfiled: 900 } });
    const old = asset("old beach.png", null);
    routes.push((url) => (url.includes("q=beach") ? json(lib([old], { query: "beach" })) : undefined));
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={full} />));
    expect(container.querySelector("[data-library-truncated]")?.textContent).toBe(fmt(tf.truncatedOf, { shown: 3, total: 950 }));

    fireEvent.change(screen.getByRole("searchbox", { name: tm.search }), { target: { value: "beach" } });
    await waitFor(() => expect(calls("GET", "/api/media?").map(([u]) => u)).toContain(`/api/media?org=${ORG}&q=beach`));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open old beach.png" })).toBeTruthy());
  });
});

describe("the viewer", () => {
  it("names the folder a file is in; Use in Studio and delete are still there", () => {
    const a = asset("logo.png", BRAND);
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([a])} />));
    fireEvent.click(screen.getByRole("button", { name: "Open logo.png" }));
    const dialog = screen.getByRole("dialog", { name: "logo.png" });
    expect(within(dialog).getByText(tm.viewer.folder)).toBeTruthy();
    expect(within(dialog).getByText("Brand")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: tm.delete })).toBeTruthy();
    expect(within(dialog).getByText(en.gen.useInStudio)).toBeTruthy();
  });
});
