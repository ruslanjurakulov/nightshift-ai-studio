// @vitest-environment jsdom
/**
 * Uploading into a folder (migration 0051) and folder controls by role, in a
 * browser-like DOM.
 *
 * What would break without these: a file chosen while a folder is open
 * landing in All files (the ticket never named the folder); its card
 * vanishing while it is checked because the folder hid every upload; a
 * deployment without 0051 putting the file in All files without a word; and
 * a viewer being offered New folder / Rename / Delete / Move to… — buttons the
 * database would only refuse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/x/library",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { MediaLibrary } from "@/components/media/MediaLibrary";
import type { LibraryAsset, MediaLibraryData, MediaUpload } from "@/lib/media";
import type { MediaFolder } from "@/lib/media-folders";

const ORG = "00000000-0000-4000-8000-000000000001";
const BRAND = "f0000000-0000-4000-8000-000000000001";
const CLIENT = "f0000000-0000-4000-8000-000000000002";
const TICKET = "70000000-0000-4000-8000-000000000001";
const tm = en.media;
const tf = en.media.folders;

const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;

let n = 0;
function asset(name: string, folderId: string | null): LibraryAsset {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind: "image",
    mime: "image/png",
    bytes: 2048,
    width: 64,
    height: 64,
    durationS: null,
    source: "upload",
    name,
    variants: ["thumb"],
    version: 1,
    createdAt: "2026-09-20T10:00:00Z",
    thumbUrl: `/api/media/file/x/thumb?sig=${n}`,
    viewUrl: `/api/media/file/x/original?sig=${n}`,
    folderId,
  };
}

function pendingUpload(name: string, folderId: string | null, status: MediaUpload["status"] = "uploaded"): MediaUpload {
  n += 1;
  return {
    id: `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name,
    status,
    reason: null,
    bytes: 4096,
    assetId: null,
    createdAt: "2026-09-20T10:00:00Z",
    folderId,
  };
}

const FOLDERS: MediaFolder[] = [
  { id: BRAND, name: "Brand", count: 1 },
  { id: CLIENT, name: "Client work", count: 0 },
];

function lib(assets: LibraryAsset[], over: Partial<MediaLibraryData> = {}): MediaLibraryData {
  return {
    available: true,
    host: { media: true, staging: true, signing: true },
    assets,
    uploads: [],
    quota: { usedBytes: 0, limitBytes: 1_000_000, maxUploadBytes: 100_000 },
    folders: { available: true, folders: FOLDERS, total: assets.length, unfiled: null },
    folder: null,
    query: "",
    truncated: false,
    ...over,
  };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

/** The body PUT: answers 200 at once, reporting full progress. */
class FakeXHR {
  static sent: { url: string; body: unknown }[] = [];
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private url = "";
  open(_method: string, url: string) {
    this.url = url;
  }
  send(body: unknown) {
    FakeXHR.sent.push({ url: this.url, body });
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 });
      this.status = 200;
      this.responseText = JSON.stringify({ ok: true });
      this.onload?.();
    }, 0);
  }
}

let ticketAnswer: () => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
const posts = () =>
  fetchMock.mock.calls
    .filter(([u, init]) => String(u) === "/api/media/uploads" && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

beforeEach(() => {
  FakeXHR.sent = [];
  ticketAnswer = () => json({ ok: true, ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}`, folder_id: BRAND, folder_applied: true });
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/media/uploads" && init?.method === "POST") return ticketAnswer();
    const folder = new URL(url, "https://x").searchParams.get("folder");
    return json(lib([], { folder }));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

function choose(container: HTMLElement, name = "logo.png") {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

const rail = () => screen.getByRole("navigation", { name: tf.rail });

describe("an editor uploading", () => {
  it("while a folder is open, the ticket names that folder", async () => {
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([asset("a.png", BRAND)], { folder: BRAND })} />));
    expect(screen.getByText(new RegExp(tf.uploadsLandHere))).toBeTruthy();
    choose(container);
    await waitFor(() => expect(FakeXHR.sent).toHaveLength(1));
    expect(posts()).toEqual([{ org_id: ORG, filename: "logo.png", mime: "image/png", bytes: 3, folder_id: BRAND }]);
    expect(FakeXHR.sent[0].url).toBe(`/api/media/uploads/${TICKET}`);
  });

  it("in All files, the ticket names no folder at all", async () => {
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([asset("a.png", null)])} />));
    choose(container);
    await waitFor(() => expect(FakeXHR.sent).toHaveLength(1));
    expect(posts()).toHaveLength(1);
    expect("folder_id" in posts()[0]).toBe(false);
  });

  it("the folder is the one open when the file was chosen, after switching too", async () => {
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([asset("a.png", BRAND)])} />));
    fireEvent.click(within(rail()).getByRole("button", { name: /^Client work/ }));
    choose(container);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].folder_id).toBe(CLIENT);
  });

  it("a deployment without 0051 says the file went to All files", async () => {
    ticketAnswer = () => json({ ok: true, ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}`, folder_id: null, folder_applied: false });
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([asset("a.png", BRAND)], { folder: BRAND })} />));
    choose(container);
    await waitFor(() => expect(FakeXHR.sent).toHaveLength(1));
    await waitFor(() => expect(container.querySelector("[data-library-notice]")?.textContent).toBe(tf.uploadedToAll));
  });

  it("a folder deleted meanwhile is a sentence, and nothing is sent", async () => {
    ticketAnswer = () => json({ error: "folder_not_found" }, 404);
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([asset("a.png", BRAND)], { folder: BRAND })} />));
    choose(container);
    await waitFor(() => expect(screen.getByText(tm.errors.folder_not_found)).toBeTruthy());
    expect(FakeXHR.sent).toEqual([]);
  });
});

describe("uploads on their way wait in the folder they will land in", () => {
  const toBrand = pendingUpload("to-brand.png", BRAND);
  const toAll = pendingUpload("to-all.png", null);

  it("a folder shows its own, not the others' — and is not 'empty' while one is coming", () => {
    const { container } = render(
      withI18n(<MediaLibrary orgId={ORG} initial={lib([], { folder: CLIENT, uploads: [toBrand, toAll, pendingUpload("to-client.png", CLIENT)] })} />),
    );
    const cards = [...container.querySelectorAll("[data-upload-status]")].map((x) => x.textContent ?? "");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("to-client.png");
    expect(container.querySelector("[data-folder-empty]")).toBeNull();
  });

  it("All files shows every upload on its way", () => {
    const { container } = render(withI18n(<MediaLibrary orgId={ORG} initial={lib([], { uploads: [toBrand, toAll] })} />));
    expect(container.querySelectorAll("[data-upload-status]")).toHaveLength(2);
  });
});

describe("a viewer (read-only member)", () => {
  const filed = asset("logo.png", BRAND);
  const loose = asset("loose.png", null);
  const viewer = (over: Partial<MediaLibraryData> = {}) =>
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([filed, loose], over)} canEditFolders={false} />));

  it("reads and opens folders, but is offered no New folder, no folder menu and no Move to…", () => {
    const { container } = viewer({ folder: BRAND });
    const items = within(rail()).getAllByRole("button").map((x) => x.textContent ?? "");
    expect(items.some((t) => t.includes(tf.newFolder))).toBe(false);
    expect(items.some((t) => t.includes("Brand"))).toBe(true);
    expect(screen.queryByRole("button", { name: tf.actions })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: tm.select }));
    expect(screen.queryByRole("button", { name: tf.moveTo })).toBeNull();
    // Deleting a file is a member's right (0038) and stays.
    expect(screen.getByRole("button", { name: "Delete (0)" })).toBeTruthy();
    expect(container.querySelector("[data-folder-header]")?.textContent).toContain(tf.uploadsLand);
  });

  it("uploads from inside a folder go to All files: no folder is sent", async () => {
    const { container } = viewer({ folder: BRAND });
    choose(container);
    await waitFor(() => expect(FakeXHR.sent).toHaveLength(1));
    expect("folder_id" in posts()[0]).toBe(false);
  });

  it("an empty folder does not tell a viewer to move files in", () => {
    const { container } = render(
      withI18n(<MediaLibrary orgId={ORG} initial={lib([], { folder: CLIENT })} canEditFolders={false} />),
    );
    const text = container.querySelector("[data-folder-empty]")?.textContent ?? "";
    expect(text).toContain(tf.emptyFolderReadOnly);
    expect(text).not.toContain(tf.emptyFolder);
  });

  it("an editor of the same library sees every control", () => {
    render(withI18n(<MediaLibrary orgId={ORG} initial={lib([filed, loose], { folder: BRAND })} canEditFolders />));
    expect(within(rail()).getByRole("button", { name: tf.newFolder })).toBeTruthy();
    expect(screen.getByRole("button", { name: tf.actions })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tm.select }));
    expect(screen.getByRole("button", { name: tf.moveTo })).toBeTruthy();
  });
});
