// @vitest-environment jsdom
/**
 * The editor in a browser-like DOM (migration 0054): the free tools change the
 * document in memory (speed, split at the playhead, trim handles a keyboard
 * can move, text), Save sends the whole document once, Export is only for a
 * SAVED version and is one request row — the page never renders, spends or
 * publishes by itself — and every refusal reads as a sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
import { EditorHome } from "@/components/editor/EditorHome";
import {
  newDocForAsset,
  type EditorAsset,
  type EditorExport,
  type TimelineDoc,
} from "@/lib/editor";

const te = en.editor;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "00000000-0000-4000-8000-000000000001";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const ASSET: EditorAsset = {
  id: A,
  kind: "video",
  name: "beach.mp4",
  durationS: 10,
  width: 1920,
  height: 1080,
  viewUrl: "/api/media/file/a/proxy?sig=1",
  thumbUrl: null,
};
const OTHER: EditorAsset = {
  id: B,
  kind: "video",
  name: "city.mp4",
  durationS: 4,
  width: 1920,
  height: 1080,
  viewUrl: "/api/media/file/b/proxy?sig=2",
  thumbUrl: null,
};

function withI18n(ui: ReactNode) {
  return <I18nProvider locale="en">{ui}</I18nProvider>;
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
type Route = (url: string, init?: RequestInit) => Promise<Response> | undefined;
let routes: Route[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
const calls = (method: string, part: string) =>
  fetchMock.mock.calls.filter(
    ([u, init]) =>
      ((init as RequestInit | undefined)?.method ?? "GET") === method &&
      String(u).includes(part),
  );
const bodyOf = (call: unknown[]) =>
  JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  routes = [];
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    for (const r of routes) {
      const res = r(url, init);
      if (res) return res;
    }
    return json({ error: "failed" }, 502);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
    Promise.resolve(),
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  router.push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(
  over: Partial<{
    doc: TimelineDoc;
    exports: EditorExport[];
    rev: number;
  }> = {},
) {
  return render(
    withI18n(
      <TimelineEditor
        projectId={PID}
        title="Trip"
        rev={over.rev ?? 1}
        doc={over.doc ?? newDocForAsset(ASSET)!}
        exports={over.exports ?? []}
        assets={{ [A]: ASSET }}
        videos={[ASSET, OTHER]}
      />,
    ),
  );
}

const status = () =>
  screen.getByText(
    (_, el) =>
      el?.getAttribute("aria-live") === "polite" && el.tagName === "SPAN",
  );
const exportBtn = () => screen.getByRole("button", { name: te.export });
const saveBtn = () => screen.getByRole("button", { name: te.save });
const clipButtons = () =>
  within(screen.getByRole("list", { name: te.clipsTrack })).getAllByRole(
    "button",
  );

describe("the editor", () => {
  it("opens saved, with the whole video as one clip and its trim and speed tools", () => {
    mount();
    expect(status().textContent).toBe(te.saved);
    expect(clipButtons()).toHaveLength(1);
    expect(clipButtons()[0].getAttribute("aria-label")).toBe(
      fmt(te.clipLabel, { n: 1, name: "beach.mp4", length: "0:10.0" }),
    );
    expect(screen.getByRole("radio", { name: "1×" })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByRole("checkbox", { name: te.sound })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByText(new RegExp(te.freeNote))).toBeTruthy();
    expect(exportBtn()).toHaveProperty("disabled", false);
  });

  it("a speed change is unsaved, blocks export until saved, and is sent with the document", async () => {
    routes.push((url, init) =>
      url.endsWith(`/api/editor/projects/${PID}`) && init?.method === "PUT"
        ? json({ id: PID, rev: 2 })
        : undefined,
    );
    mount();
    fireEvent.click(screen.getByRole("radio", { name: "2×" }));
    expect(status().textContent).toBe(te.unsaved);
    expect(exportBtn()).toHaveProperty("disabled", true);
    expect(screen.getByText(te.exportNeedsSave)).toBeTruthy();
    expect(clipButtons()[0].getAttribute("aria-label")).toContain("0:05.0");

    fireEvent.click(saveBtn());
    await waitFor(() => expect(status().textContent).toBe(te.saved));
    const [put] = calls("PUT", `/api/editor/projects/${PID}`);
    const body = bodyOf(put);
    expect(body.base_rev).toBe(1);
    expect(body.title).toBeNull();
    expect(body.doc.tracks[0].clips[0]).toMatchObject({
      asset_id: A,
      in_s: 0,
      out_s: 10,
      speed: 2,
      audio: true,
    });
    expect(exportBtn()).toHaveProperty("disabled", false);
    // Saving never asked for a render.
    expect(calls("POST", "/exports")).toHaveLength(0);
  });

  it("undo puts the document back to what is saved", () => {
    mount();
    fireEvent.click(screen.getByRole("radio", { name: "0.5×" }));
    expect(status().textContent).toBe(te.unsaved);
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(status().textContent).toBe(te.saved);
    fireEvent.click(screen.getByRole("button", { name: te.redo }));
    expect(screen.getByRole("radio", { name: "0.5×" })).toHaveProperty(
      "checked",
      true,
    );
  });

  it("splits only where the playhead is inside the clip", () => {
    mount();
    const split = screen.getByRole("button", { name: te.split });
    expect(split).toHaveProperty("disabled", true);
    expect(screen.getByText(te.splitHint)).toBeTruthy();
    fireEvent.change(screen.getByRole("slider", { name: te.playhead }), {
      target: { value: "4" },
    });
    expect(split).toHaveProperty("disabled", false);
    fireEvent.click(split);
    expect(clipButtons()).toHaveLength(2);
    expect(clipButtons()[0].getAttribute("aria-label")).toContain("0:04.0");
    expect(clipButtons()[1].getAttribute("aria-label")).toContain("0:06.0");
  });

  it("trim handles are sliders a keyboard moves: a frame, a second with Shift", () => {
    mount();
    const start = screen.getByRole("slider", {
      name: fmt(te.trimStart, { n: 1 }),
    });
    const end = screen.getByRole("slider", { name: fmt(te.trimEnd, { n: 1 }) });
    expect(start.getAttribute("aria-valuenow")).toBe("0");
    expect(end.getAttribute("aria-valuemax")).toBe("10");
    fireEvent.keyDown(start, { key: "ArrowRight", shiftKey: true });
    expect(
      screen
        .getByRole("slider", { name: fmt(te.trimStart, { n: 1 }) })
        .getAttribute("aria-valuenow"),
    ).toBe("1");
    fireEvent.keyDown(
      screen.getByRole("slider", { name: fmt(te.trimEnd, { n: 1 }) }),
      { key: "ArrowLeft" },
    );
    expect(
      screen
        .getByRole("slider", { name: fmt(te.trimEnd, { n: 1 }) })
        .getAttribute("aria-valuenow"),
    ).toBe("9.967");
    // Never past the source.
    fireEvent.keyDown(
      screen.getByRole("slider", { name: fmt(te.trimEnd, { n: 1 }) }),
      { key: "End" },
    );
    fireEvent.keyDown(
      screen.getByRole("slider", { name: fmt(te.trimEnd, { n: 1 }) }),
      { key: "ArrowRight", shiftKey: true },
    );
    expect(
      screen
        .getByRole("slider", { name: fmt(te.trimEnd, { n: 1 }) })
        .getAttribute("aria-valuenow"),
    ).toBe("10");
    expect(screen.getByText(te.trimKeys)).toBeTruthy();
  });

  it("trims with numbers too, and the clips after it ripple", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: te.addVideo }));
    fireEvent.click(
      within(screen.getByRole("region", { name: te.addVideoTitle })).getByRole(
        "button",
        { name: /city\.mp4/ },
      ),
    );
    expect(clipButtons()).toHaveLength(2);
    fireEvent.click(clipButtons()[0]);
    const out = screen.getByLabelText(te.trimOut);
    fireEvent.change(out, { target: { value: "6" } });
    fireEvent.blur(out);
    expect(clipButtons()[0].getAttribute("aria-label")).toContain("0:06.0");
    expect(screen.getByText("0:00.0 / 0:10.0")).toBeTruthy();
  });

  it("adds text at the playhead, edits it, and shows it on the preview", async () => {
    routes.push((url, init) =>
      init?.method === "PUT" ? json({ id: PID, rev: 2 }) : undefined,
    );
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: te.addText }));
    const box = screen.getByRole("textbox", {
      name: te.textLabel,
    }) as HTMLTextAreaElement;
    expect(box.value).toBe(te.newText);
    fireEvent.change(box, { target: { value: "Day one" } });
    fireEvent.blur(box);
    fireEvent.click(screen.getByRole("radio", { name: te.positions.top }));
    expect(container.textContent).toContain("Day one");
    expect(
      within(screen.getByRole("list", { name: te.textTrack }))
        .getByRole("button")
        .getAttribute("aria-label"),
    ).toBe(
      fmt(te.textClipLabel, { text: "Day one", from: "0:00.0", to: "0:03.0" }),
    );
    fireEvent.click(saveBtn());
    await waitFor(() => expect(calls("PUT", PID)).toHaveLength(1));
    const t = bodyOf(calls("PUT", PID)[0]).doc.tracks.find(
      (x: { kind: string }) => x.kind === "T",
    );
    expect(t.clips[0]).toMatchObject({
      text: "Day one",
      start_s: 0,
      end_s: 3,
      y: 0.12,
      anchor: "top",
    });
  });

  it("an empty text is caught before saving", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: te.addText }));
    const box = screen.getByRole("textbox", { name: te.textLabel });
    fireEvent.change(box, { target: { value: "  " } });
    fireEvent.blur(box);
    expect(screen.getByRole("status").textContent).toBe(te.textEmpty);
    fireEvent.click(saveBtn());
    expect(screen.getByRole("alert").textContent).toContain(te.textEmpty);
    expect(calls("PUT", PID)).toHaveLength(0);
  });

  it("a save someone else overtook says so and offers a reload", async () => {
    routes.push((_url, init) =>
      init?.method === "PUT"
        ? json({ error: "stale_revision" }, 409)
        : undefined,
    );
    mount();
    fireEvent.click(screen.getByRole("radio", { name: "1.5×" }));
    fireEvent.click(saveBtn());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(te.errors.stale_revision);
    expect(within(alert).getByRole("button", { name: te.reload })).toBeTruthy();
    expect(status().textContent).toBe(te.unsaved);
  });

  it("export is one request for the saved version, then it is tracked until done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    routes.push((url, init) =>
      url.endsWith("/exports") && init?.method === "POST"
        ? json({ id: "e1", status: "queued" }, 201)
        : undefined,
    );
    routes.push((url, init) => {
      if (!url.endsWith(PID) || (init?.method ?? "GET") !== "GET")
        return undefined;
      polls += 1;
      const done = polls > 1;
      return json({
        id: PID,
        rev: 1,
        doc: newDocForAsset(ASSET),
        exports: [
          {
            id: "e1",
            rev: 1,
            status: done ? "done" : "rendering",
            reason: null,
            duration_s: 10,
            asset_id: done ? B : null,
          },
        ],
        assets: done ? { [B]: OTHER } : {},
      });
    });
    mount();
    fireEvent.click(exportBtn());
    await waitFor(() =>
      expect(screen.getByText(te.exportStatus.queued)).toBeTruthy(),
    );
    expect(bodyOf(calls("POST", "/exports")[0])).toEqual({ rev: 1 });
    expect(exportBtn()).toHaveProperty("disabled", true);
    expect(screen.getByText(te.exportBusy)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    await waitFor(() =>
      expect(screen.getByText(te.exportStatus.rendering)).toBeTruthy(),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    await waitFor(() =>
      expect(screen.getByText(te.exportStatus.done)).toBeTruthy(),
    );
    expect(
      screen.getByRole("link", { name: te.watch }).getAttribute("href"),
    ).toBe(OTHER.viewUrl);
    expect(
      screen.getByRole("link", { name: te.viewInLibrary }).getAttribute("href"),
    ).toBe("/chronos/library");
    expect(calls("POST", "/exports")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("a refused export and a failed one read as sentences", async () => {
    routes.push((url, init) =>
      url.endsWith("/exports") && init?.method === "POST"
        ? json({ error: "daily_limit" }, 429)
        : undefined,
    );
    mount({
      exports: [
        {
          id: "e0",
          rev: 1,
          status: "failed",
          reason: "asset_unavailable",
          durationS: 10,
          assetId: null,
          createdAt: null,
          finishedAt: null,
        },
        {
          id: "e9",
          rev: 1,
          status: "failed",
          reason: "other",
          durationS: null,
          assetId: null,
          createdAt: null,
          finishedAt: null,
        },
      ],
    });
    expect(screen.getByText(te.exportReasons.asset_unavailable)).toBeTruthy();
    expect(screen.getByText(te.exportReasons.other)).toBeTruthy();
    fireEvent.click(exportBtn());
    expect((await screen.findByRole("alert")).textContent).toContain(
      te.errors.daily_limit,
    );
  });

  it("deleting the project asks first, then goes back to the list", async () => {
    routes.push((_url, init) =>
      init?.method === "DELETE" ? json({ ok: true }) : undefined,
    );
    mount();
    fireEvent.click(screen.getByRole("button", { name: te.deleteProject }));
    expect(screen.getByText(te.deleteConfirm)).toBeTruthy();
    expect(calls("DELETE", PID)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: te.deleteYes }));
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/chronos/editor"),
    );
  });

  it("without a preview link it still edits, and says why there is no picture", () => {
    render(
      withI18n(
        <TimelineEditor
          projectId={PID}
          title="T"
          rev={1}
          doc={newDocForAsset(ASSET)!}
          exports={[]}
          assets={{ [A]: { ...ASSET, viewUrl: null } }}
          videos={[]}
        />,
      ),
    );
    expect(screen.getByText(te.noPreview)).toBeTruthy();
    expect(screen.getByRole("button", { name: te.split })).toBeTruthy();
  });
});

describe("the project list", () => {
  it("starts a project from a chosen video and opens it", async () => {
    routes.push((url, init) =>
      url === "/api/editor/projects" && init?.method === "POST"
        ? json({ id: PID }, 201)
        : undefined,
    );
    render(
      withI18n(
        <EditorHome orgId={ORG} projects={[]} videos={[ASSET, OTHER]} />,
      ),
    );
    expect(screen.getByText(te.noProjects)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /city\.mp4/ }));
    fireEvent.change(screen.getByLabelText(te.projectTitle), {
      target: { value: "  City   cut " },
    });
    fireEvent.click(screen.getByRole("button", { name: te.create }));
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith(`/chronos/editor/${PID}`),
    );
    expect(bodyOf(calls("POST", "/api/editor/projects")[0])).toEqual({
      org_id: ORG,
      title: "City cut",
      asset_id: B,
    });
  });

  it("says what is wrong when the database refuses", async () => {
    routes.push(() => json({ error: "limit_reached" }, 429));
    render(withI18n(<EditorHome orgId={ORG} projects={[]} videos={[ASSET]} />));
    fireEvent.click(screen.getByRole("button", { name: te.create }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      te.errors.limit_reached,
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("points to the library when there is no video yet, and lists projects", () => {
    render(
      withI18n(
        <EditorHome
          orgId={ORG}
          projects={[{ id: PID, title: "Trip", updatedAt: null }]}
          videos={[]}
        />,
      ),
    );
    expect(screen.getByText(te.noVideos)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: te.openLibrary }).getAttribute("href"),
    ).toBe("/chronos/library");
    expect(
      screen.getByRole("link", { name: /Trip/ }).getAttribute("href"),
    ).toBe(`/chronos/editor/${PID}`);
    expect(screen.queryByRole("button", { name: te.create })).toBeNull();
  });
});
