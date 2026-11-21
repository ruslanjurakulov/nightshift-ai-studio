// @vitest-environment jsdom
/**
 * The frame picker and the Fit control in the editor: both are undoable
 * document edits that the preview draws (aspect box, object-fit) and Save
 * sends; nothing is rendered or spent by choosing them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";

const router = {
  push: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
};
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/chronos/editor/p",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { fmt } from "@/lib/i18n";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import {
  newDocForAnyAsset,
  newDocForAsset,
  type EditorAsset,
  type TimelineDoc,
} from "@/lib/editor";

const te = en.editor;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const P = "33333333-3333-4333-8333-333333333333";

const VIDEO: EditorAsset = {
  id: A,
  kind: "video",
  name: "beach.mp4",
  durationS: 10,
  width: 1920,
  height: 1080,
  viewUrl: "/api/media/file/a/proxy?sig=1",
  thumbUrl: null,
};
const PHOTO: EditorAsset = {
  id: P,
  kind: "image",
  name: "photo.jpg",
  durationS: null,
  width: 1200,
  height: 800,
  viewUrl: "/api/media/file/p/view?sig=1",
  thumbUrl: null,
};

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn((url: string, init?: RequestInit) =>
    String(url).endsWith(`/api/editor/projects/${PID}`) &&
    init?.method === "PUT"
      ? json({ id: PID, rev: 2 })
      : json({ error: "failed" }, 502),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
    Promise.resolve(),
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(doc: TimelineDoc, asset: EditorAsset) {
  const ui: ReactNode = (
    <I18nProvider locale="en">
      <TimelineEditor
        projectId={PID}
        title="Trip"
        rev={1}
        doc={doc}
        exports={[]}
        assets={{ [asset.id]: asset }}
        videos={[VIDEO]}
      />
    </I18nProvider>
  );
  return render(ui);
}
const mountVideo = () => mount(newDocForAsset(VIDEO)!, VIDEO);
const frameBox = () => document.querySelector("video")!.parentElement!;
const savedBody = () => {
  const put = fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
  )!;
  return JSON.parse(String((put[1] as RequestInit).body));
};
const frameRadio = (name: string) =>
  screen.getByRole("radio", { name: new RegExp(`^${name}`) });

describe("frame picker", () => {
  it("opens on the document's shape and draws the preview box at its aspect ratio", () => {
    mountVideo();
    expect(frameRadio("16:9")).toHaveProperty("checked", true);
    expect(frameRadio("9:16")).toHaveProperty("checked", false);
    expect(frameBox().style.aspectRatio).toBe("1920 / 1080");
    expect(
      screen.getByText(fmt(te.frameHint, { w: 1920, h: 1080 })),
    ).toBeTruthy();
  });

  it("is labelled as a group and each shape is a real radio", () => {
    mountVideo();
    expect(screen.getByRole("group", { name: te.frame })).toBeTruthy();
    expect(screen.getAllByRole("radio", { name: /^(9:16|16:9|1:1)/ })).toHaveLength(3);
  });

  it("changes the frame, redraws the box, is undoable and saved", async () => {
    mountVideo();
    fireEvent.click(frameRadio("9:16"));
    expect(frameBox().style.aspectRatio).toBe("1080 / 1920");
    expect(frameRadio("9:16")).toHaveProperty("checked", true);
    expect(screen.getByText(te.unsaved)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(frameBox().style.aspectRatio).toBe("1920 / 1080");
    expect(screen.getByText(te.saved)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: te.redo }));
    expect(frameBox().style.aspectRatio).toBe("1080 / 1920");

    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(screen.getByText(te.saved)).toBeTruthy());
    const body = savedBody();
    expect([body.doc.width, body.doc.height, body.doc.fps]).toEqual([
      1080, 1920, 30,
    ]);
    // Choosing a shape never asks for a render.
    expect(
      fetchMock.mock.calls.filter(([u]) => String(u).includes("/exports")),
    ).toHaveLength(0);
  });

  it("a custom size shows none selected and says so", () => {
    const doc = newDocForAsset(VIDEO)!;
    doc.width = 1280;
    doc.height = 720;
    mount(doc, VIDEO);
    for (const id of ["9:16", "16:9", "1:1"])
      expect(frameRadio(id)).toHaveProperty("checked", false);
    expect(
      screen.getByText(fmt(te.frameCustom, { w: 1280, h: 720 })),
    ).toBeTruthy();
  });
});

describe("fit control", () => {
  const video = () => document.querySelector("video")!;

  it("defaults to Fit (bars) = contain, and a project that never used it is unchanged", async () => {
    mountVideo();
    expect(screen.getByRole("radio", { name: te.fitContain })).toHaveProperty(
      "checked",
      true,
    );
    expect(video().style.objectFit).toBe("contain");
    expect(screen.getByText(te.fitHint)).toBeTruthy();
  });

  it("Fill (crop) = cover: the preview crops, undo restores bars, Save sends fit", async () => {
    mountVideo();
    fireEvent.click(screen.getByRole("radio", { name: te.fitCover }));
    expect(video().style.objectFit).toBe("cover");
    expect(screen.getByText(te.unsaved)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(video().style.objectFit).toBe("contain");
    expect(screen.getByText(te.saved)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: te.redo }));
    expect(video().style.objectFit).toBe("cover");

    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(screen.getByText(te.saved)).toBeTruthy());
    expect(savedBody().doc.tracks[0].clips[0].fit).toBe("cover");
  });

  it("going back to Fit saves a document without a fit field", async () => {
    const doc = newDocForAsset(VIDEO)!;
    doc.tracks[0].clips[0].fit = "cover";
    mount(doc, VIDEO);
    expect(video().style.objectFit).toBe("cover");
    fireEvent.click(screen.getByRole("radio", { name: te.fitContain }));
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(screen.getByText(te.saved)).toBeTruthy());
    expect("fit" in savedBody().doc.tracks[0].clips[0]).toBe(false);
  });

  it("a photo has no fit to choose and is drawn filling the frame", () => {
    const doc = newDocForAnyAsset(PHOTO)!;
    mount(doc, PHOTO);
    expect(screen.getByRole("radio", { name: te.fitContain })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("radio", { name: te.fitCover })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText(te.fitStill)).toBeTruthy();
    const img = document.querySelector("img")!;
    expect(img.style.objectFit).toBe("cover");
  });
});
