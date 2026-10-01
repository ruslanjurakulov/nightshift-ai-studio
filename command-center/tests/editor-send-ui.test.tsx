// @vitest-environment jsdom
/**
 * "Open in editor" in a browser-like DOM: the dialog offers a new project or
 * one the organization already has, sends the file once, opens the project it
 * landed in, and says in a sentence why when it could not. A failed project
 * list never blocks starting a new project; nothing here exports, prices or
 * publishes — the only requests are the list and the send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const router = { push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/chronos/library" }));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { SendToEditor } from "@/components/editor/SendToEditor";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { newDocForAnyAsset, type EditorAsset } from "@/lib/editor";
import { MediaViewer } from "@/components/media/MediaViewer";
import type { LibraryAsset } from "@/lib/media";

const ts = en.editor.send;
const ORG = "00000000-0000-4000-8000-000000000001";
const ASSET = "11111111-1111-4111-8111-111111111111";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let fetchMock: ReturnType<typeof vi.fn>;
let listing: () => Promise<Response>;
let sending: () => Promise<Response>;
const sends = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/editor/send");

beforeEach(() => {
  router.push.mockReset();
  listing = () => json({ projects: [{ id: P1, title: "Trip" }, { id: P2, title: "Promo" }] });
  sending = () => json({ id: P1, created: false });
  fetchMock = vi.fn((url: string) => (String(url).startsWith("/api/editor/projects") ? listing() : sending()));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = (ui: ReactNode, locale: "en" | "ru" | "uz" = "en") => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);
const open = async (kind: "video" | "image" | "audio" = "video", name: string | null = "Beach clip") => {
  mount(<SendToEditor orgId={ORG} assetId={ASSET} kind={kind} name={name} />);
  fireEvent.click(screen.getByTestId("open-in-editor"));
  return screen.findByTestId("open-in-editor-dialog");
};

describe("SendToEditor", () => {
  it("starts a new project named after the file and opens it", async () => {
    sending = () => json({ id: P2, created: true }, 201);
    const dialog = await open();
    const name = await within(dialog).findByLabelText(ts.projectName);
    expect((name as HTMLInputElement).value).toBe("Beach clip");
    fireEvent.change(name, { target: { value: "  My   cut " } });
    fireEvent.click(within(dialog).getByRole("button", { name: ts.submit }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/chronos/editor/${P2}`));
    expect(sends()).toHaveLength(1);
    expect(JSON.parse(String((sends()[0]![1] as RequestInit).body))).toEqual({ org_id: ORG, asset_id: ASSET, title: "My cut" });
  });

  it("adds to an existing project when asked, and sends that project's id", async () => {
    const dialog = await open();
    fireEvent.click(await within(dialog).findByLabelText(ts.existingOption));
    const pick = within(dialog).getByLabelText(ts.pickProject) as HTMLSelectElement;
    expect(pick.value).toBe(P1);
    fireEvent.change(pick, { target: { value: P2 } });
    fireEvent.click(within(dialog).getByRole("button", { name: ts.submit }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/chronos/editor/${P1}`));
    expect(JSON.parse(String((sends()[0]![1] as RequestInit).body))).toEqual({ org_id: ORG, asset_id: ASSET, project_id: P2 });
  });

  it("a second press while it is sending does not send the file twice", async () => {
    let release: (r: Response) => void = () => {};
    sending = () => new Promise<Response>((r) => (release = r));
    const dialog = await open();
    await within(dialog).findByLabelText(ts.projectName);
    const go = within(dialog).getByRole("button", { name: ts.submit });
    fireEvent.click(go);
    const busy = await within(dialog).findByRole("button", { name: ts.sending });
    fireEvent.click(busy);
    fireEvent.keyDown(within(dialog).getByLabelText(ts.projectName), { key: "Enter" });
    expect(sends()).toHaveLength(1);
    release(new Response(JSON.stringify({ id: P1, created: true }), { status: 201 }));
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["clips_full", 409],
    ["invalid_asset", 400],
    ["stale_revision", 409],
    ["forbidden", 403],
  ] as const)("says why a refusal (%s) happened and stays open for another try", async (word, status) => {
    sending = () => json({ error: word }, status);
    const dialog = await open();
    fireEvent.click(await within(dialog).findByLabelText(ts.existingOption));
    fireEvent.click(within(dialog).getByRole("button", { name: ts.submit }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(en.editor.errors[word]);
    expect(router.push).not.toHaveBeenCalled();
    expect((within(dialog).getByRole("button", { name: ts.submit }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says the server could not be reached", async () => {
    fetchMock.mockImplementation((url: string) => (String(url).startsWith("/api/editor/projects") ? listing() : Promise.reject(new Error("offline"))));
    const dialog = await open();
    await within(dialog).findByLabelText(ts.projectName);
    fireEvent.click(within(dialog).getByRole("button", { name: ts.submit }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(en.editor.errors.network);
  });

  it("a failed project list can be retried and never blocks a new project", async () => {
    listing = () => json({ error: "failed" }, 502);
    const dialog = await open();
    expect(await within(dialog).findByText(ts.projectsFailed)).toBeTruthy();
    expect(within(dialog).queryByLabelText(ts.existingOption)).toBeNull();
    expect(within(dialog).getByLabelText(ts.projectName)).toBeTruthy();
    listing = () => json({ projects: [{ id: P1, title: "Trip" }] });
    fireEvent.click(within(dialog).getByRole("button", { name: ts.retry }));
    expect(await within(dialog).findByLabelText(ts.existingOption)).toBeTruthy();
  });

  it("with no projects yet it says a new one will be created", async () => {
    listing = () => json({ projects: [] });
    const dialog = await open();
    expect(await within(dialog).findByText(ts.noProjects)).toBeTruthy();
    expect(within(dialog).queryByLabelText(ts.existingOption)).toBeNull();
  });

  it("tells what happens to each kind of file", async () => {
    for (const [kind, note] of [
      ["image", ts.stillNote.replace("{s}", "5")],
      ["audio", ts.soundNote],
      ["video", ts.videoNote],
    ] as const) {
      const dialog = await open(kind);
      expect(await within(dialog).findByText(note)).toBeTruthy();
      cleanup();
    }
  });

  it("says it is free and publishes nothing, and Escape closes it", async () => {
    const dialog = await open();
    expect(dialog.textContent).toContain(ts.lead);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("open-in-editor-dialog")).toBeNull());
    expect(sends()).toHaveLength(0);
  });

  it("falls back to the default name for a file with none", async () => {
    const dialog = await open("image", null);
    expect(((await within(dialog).findByLabelText(ts.projectName)) as HTMLInputElement).value).toBe(en.editor.defaultTitle);
  });
});

function libraryAsset(kind: "video" | "image" | "audio" | "caption"): LibraryAsset {
  return {
    id: ASSET,
    kind,
    mime: kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : kind === "image" ? "image/png" : "text/vtt",
    bytes: 2048,
    width: 1920,
    height: 1080,
    durationS: 12,
    source: "generation",
    name: "Result",
    variants: [],
    version: 1,
    createdAt: "2026-09-01T10:00:00Z",
    thumbUrl: null,
    viewUrl: null,
  } as LibraryAsset;
}

describe("the library viewer", () => {
  const viewer = (kind: "video" | "image" | "audio" | "caption", orgId?: string, onClose = vi.fn()) =>
    mount(<MediaViewer items={[libraryAsset(kind)]} index={0} onNavigate={() => {}} onClose={onClose} deleting={false} orgId={orgId} />);

  it.each(["video", "image", "audio"] as const)("offers Open in editor for a %s", (kind) => {
    viewer(kind, ORG);
    expect(screen.getByTestId("open-in-editor")).toBeTruthy();
  });

  it("offers nothing for a caption file, or when the organization is not known", () => {
    viewer("caption", ORG);
    expect(screen.queryByTestId("open-in-editor")).toBeNull();
    cleanup();
    viewer("video");
    expect(screen.queryByTestId("open-in-editor")).toBeNull();
  });

  it("Escape closes only the editor dialog, not the viewer under it", async () => {
    const onClose = vi.fn();
    viewer("image", ORG, onClose);
    fireEvent.click(screen.getByTestId("open-in-editor"));
    await screen.findByTestId("open-in-editor-dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("open-in-editor-dialog")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("a picture sent to the editor", () => {
  it("is drawn as a picture in the preview, not handed to a video player", () => {
    const pic: EditorAsset = { id: ASSET, kind: "image", name: "Cover", durationS: null, width: 1024, height: 1024, viewUrl: "/api/media/file/x/display?sig=1", thumbUrl: null };
    const doc = newDocForAnyAsset(pic)!;
    const { container } = mount(<TimelineEditor projectId={P1} title="Cover" rev={1} doc={doc} exports={[]} assets={{ [ASSET]: pic }} videos={[]} />);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector('img[src="/api/media/file/x/display?sig=1"]')).not.toBeNull();
  });
});

describe("the Studio feed", () => {
  it("puts the button on a finished result of a video, picture or sound, and never on a description", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "components/studio/JobFeed.tsx"), "utf8");
    expect(src).toMatch(/isSendKind\(kind\) && job\.result_asset_ids\[0\]/);
    // "kind" is outputKind(): a description is "text", which isSendKind refuses.
    const { isSendKind } = await import("@/components/editor/SendToEditor");
    expect(isSendKind("text")).toBe(false);
    expect(isSendKind("video") && isSendKind("image") && isSendKind("audio")).toBe(true);
  });
});

describe("the copy", () => {
  it("is complete in English, Russian and Uzbek, with the same placeholders", () => {
    const keys = Object.keys(ts);
    for (const d of [ru, uz]) {
      expect(Object.keys(d.editor.send)).toEqual(keys);
      for (const k of keys) {
        const a = (ts as Record<string, string>)[k]!;
        const b = (d.editor.send as Record<string, string>)[k]!;
        expect(b.trim().length).toBeGreaterThan(0);
        expect(b.match(/\{\w+\}/g) ?? []).toEqual(a.match(/\{\w+\}/g) ?? []);
      }
      for (const w of ["clips_full", "sounds_full", "no_duration"] as const) expect(d.editor.errors[w].length).toBeGreaterThan(0);
    }
  });

  it("names no provider, model or role", () => {
    const text = JSON.stringify([en.editor.send, ru.editor.send, uz.editor.send]).toLowerCase();
    expect(text).not.toMatch(/owner|viewer|admin|openai|gemini|kling|veo|flux|elevenlabs|higgsfield|krea/);
  });
});
