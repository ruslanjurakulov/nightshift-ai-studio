// @vitest-environment jsdom
/**
 * The editor with local drafts: the unsaved mark, the debounce, the resume
 * banner (restore, discard, a project that moved on) and storage that fails.
 * Save stays explicit and export stays blocked while unsaved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

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
import { ru } from "@/lib/i18n/ru";
import { fmt } from "@/lib/i18n";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import {
  DRAFT_DEBOUNCE_MS,
  allowDraftWrites,
  clearAllEditorDrafts,
  draftKey,
  readDraft,
  writeDraft,
} from "@/lib/editor-draft";
import {
  newDocForAsset,
  setSpeed,
  toDoc,
  toModel,
  type EditorAsset,
  type TimelineDoc,
} from "@/lib/editor";

const te = en.editor;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U1 = "user-1";
const U2 = "user-2";
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

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
let fetchMock: ReturnType<typeof vi.fn>;
let putStatus = 200;
let putBody: unknown = { id: PID, rev: 2 };

beforeEach(() => {
  localStorage.clear();
  allowDraftWrites();
  putStatus = 200;
  putBody = { id: PID, rev: 2 };
  fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    init?.method === "PUT" ? json(putBody, putStatus) : json({ error: "failed" }, 502),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
    Promise.resolve(),
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const base = () => newDocForAsset(ASSET)!;
const doubled = (): TimelineDoc => {
  const m = toModel(base());
  return toDoc(setSpeed(m, m.clips[0].id, 2));
};

function mount(
  over: Partial<{
    userId: string | undefined;
    projectId: string;
    rev: number;
    locale: "en" | "ru";
  }> = {},
) {
  return render(
    <I18nProvider locale={over.locale ?? "en"}>
      <TimelineEditor
        projectId={over.projectId ?? PID}
        title="Trip"
        rev={over.rev ?? 1}
        doc={base()}
        exports={[]}
        assets={{ [A]: ASSET }}
        videos={[ASSET, OTHER]}
        {...("userId" in over ? { userId: over.userId } : { userId: U1 })}
      />
    </I18nProvider>,
  );
}

const live = () =>
  screen.getByText(
    (_, el) => el?.getAttribute("aria-live") === "polite" && el.tagName === "SPAN",
  );
const banner = () => screen.queryByRole("region", { name: te.draftRegion });
const speed = (x: string) => screen.getByRole("radio", { name: x });
const store = (rev = 1, user = U1, project = PID) =>
  readDraft(user, project, rev);

describe("the unsaved indicator", () => {
  it("is words in a polite live region, with a second cue that is not colour", () => {
    mount();
    expect(live().getAttribute("aria-live")).toBe("polite");
    expect(live().textContent).toBe(te.saved);
    const mark = () => live().querySelector("[aria-hidden]") as HTMLElement;
    expect(mark().className).not.toContain("bg-current");
    fireEvent.click(speed("2×"));
    expect(live().textContent).toBe(te.unsaved);
    expect(mark().className).toContain("bg-current"); // filled, where saved is hollow
    expect(live().className).toContain("font-medium");
  });

  it("reads in Russian", () => {
    mount({ locale: "ru" });
    fireEvent.click(screen.getByRole("radio", { name: "2×" }));
    expect(live().textContent).toBe(ru.editor.unsaved);
  });

  it("says Saving while a save is on its way", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementation(
      (_u: string, init?: RequestInit) =>
        init?.method === "PUT"
          ? new Promise<Response>((r) => (release = r))
          : json({}, 502),
    );
    mount();
    fireEvent.click(speed("2×"));
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(live().textContent).toBe(te.saving));
    release(new Response(JSON.stringify({ id: PID, rev: 2 }), { status: 200 }));
    await waitFor(() => expect(live().textContent).toBe(te.saved));
  });
});

describe("autosave to this device", () => {
  it("waits for a quiet moment, then keeps one draft under user + project + revision", () => {
    vi.useFakeTimers();
    mount();
    fireEvent.click(speed("2×"));
    act(() => void vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 1));
    expect(localStorage.length).toBe(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem(draftKey(U1, PID, 1))).not.toBeNull();
    expect(store()?.doc).toEqual(doubled());
    expect(screen.getByText(te.draftKept)).toBeTruthy();
  });

  it("another change restarts the wait", () => {
    vi.useFakeTimers();
    mount();
    fireEvent.click(speed("2×"));
    act(() => void vi.advanceTimersByTime(1000));
    fireEvent.click(speed("0.5×"));
    act(() => void vi.advanceTimersByTime(1000));
    expect(localStorage.length).toBe(0);
    act(() => void vi.advanceTimersByTime(500));
    expect(store()?.doc.tracks[0].clips[0]).toMatchObject({ speed: 0.5 });
  });

  it("writes at once when the tab is hidden or the page goes away", () => {
    vi.useFakeTimers();
    mount();
    fireEvent.click(speed("2×"));
    expect(localStorage.length).toBe(0);
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(store()).not.toBeNull();
  });

  it("writes at once when the editor closes (in-app navigation)", () => {
    vi.useFakeTimers();
    const { unmount } = mount();
    fireEvent.click(speed("2×"));
    unmount();
    expect(store()).not.toBeNull();
  });

  it("writes nothing for a clean document, and removes the draft when changes are undone", () => {
    vi.useFakeTimers();
    mount();
    act(() => void vi.advanceTimersByTime(5000));
    expect(localStorage.length).toBe(0);
    fireEvent.click(speed("2×"));
    act(() => void vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS));
    expect(localStorage.length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(localStorage.length).toBe(0);
  });

  it("a successful Save removes the draft", async () => {
    mount();
    fireEvent.click(speed("2×"));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(store()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(live().textContent).toBe(te.saved));
    expect(localStorage.length).toBe(0);
  });

  it("does nothing without a signed-in member", () => {
    mount({ userId: undefined });
    fireEvent.click(speed("2×"));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(localStorage.length).toBe(0);
    expect(screen.queryByText(te.draftKept)).toBeNull();
  });

  it("keeps working, and says so, when the browser refuses to store (full)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    mount();
    fireEvent.click(speed("2×"));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(screen.getByText(te.draftOff)).toBeTruthy();
    expect(live().textContent).toBe(te.unsaved);
    expect(screen.getByRole("button", { name: te.save })).toHaveProperty("disabled", false);
  });

  it("keeps working when localStorage cannot even be reached", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    mount();
    fireEvent.click(speed("2×"));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(banner()).toBeNull();
    expect(live().textContent).toBe(te.unsaved);
    expect(screen.getByText(te.draftOff)).toBeTruthy();
  });

  it("export stays blocked while unsaved, draft or no draft", () => {
    mount();
    fireEvent.click(speed("2×"));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(screen.getByRole("button", { name: te.export })).toHaveProperty("disabled", true);
    expect(screen.getByText(te.exportNeedsSave)).toBeTruthy();
  });
});

describe("resuming", () => {
  it("offers a draft based on this revision, applies nothing until asked, and Save stays explicit", async () => {
    writeDraft(U1, PID, 1, { title: "Trip 2", doc: doubled() });
    mount();
    const region = await screen.findByRole("region", { name: te.draftRegion });
    expect(region.textContent).toContain(te.draftFound.split("{when}")[0].trim());
    // nothing applied yet
    expect(live().textContent).toBe(te.saved);
    expect(speed("1×")).toHaveProperty("checked", true);
    // the draft was not overwritten by the (clean) editor
    expect(store()?.title).toBe("Trip 2");

    fireEvent.click(screen.getByRole("button", { name: te.draftRestore }));
    expect(banner()).toBeNull();
    expect(live().textContent).toBe(te.unsaved);
    expect(speed("2×")).toHaveProperty("checked", true);
    expect((screen.getByLabelText(te.projectTitle) as HTMLInputElement).value).toBe("Trip 2");
    expect(fetchMock).not.toHaveBeenCalled(); // nothing was saved by itself
    expect(screen.getByRole("button", { name: te.export })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(live().textContent).toBe(te.saved));
    const [, init] = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === "PUT")!;
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent.base_rev).toBe(1);
    expect(sent.title).toBe("Trip 2");
    expect(sent.doc.tracks[0].clips[0]).toMatchObject({ speed: 2 });
  });

  it("Restore keeps an edit made while the offer was open one Undo away", async () => {
    writeDraft(U1, PID, 1, { title: "Trip", doc: doubled() });
    mount();
    await screen.findByRole("region", { name: te.draftRegion });
    fireEvent.click(speed("0.5×")); // a different, live edit while the offer is open
    fireEvent.click(screen.getByRole("button", { name: te.draftRestore }));
    expect(speed("2×")).toHaveProperty("checked", true); // the draft was applied
    const undo = screen.getByRole("button", { name: te.undo });
    expect(undo).toHaveProperty("disabled", false);
    fireEvent.click(undo);
    expect(speed("0.5×")).toHaveProperty("checked", true); // the live edit is back
    expect(screen.getByRole("button", { name: te.redo })).toHaveProperty("disabled", false);
  });

  it("announces the offer to assistive technology (role=status)", async () => {
    writeDraft(U1, PID, 1, { title: "Trip", doc: doubled() });
    mount();
    const region = await screen.findByRole("region", { name: te.draftRegion });
    expect(screen.getByRole("status", { name: "" }).textContent).toContain(
      te.draftFound.split("{when}")[0].trim(),
    );
    expect(region.contains(screen.getByRole("status"))).toBe(true);
  });

  it("clamps a restored title to the length the input allows", async () => {
    writeDraft(U1, PID, 1, { title: "x".repeat(300), doc: doubled() });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: te.draftRestore }));
    expect((screen.getByLabelText(te.projectTitle) as HTMLInputElement).value).toHaveLength(120);
  });

  it("the banner buttons are real buttons at least 44 px high and reachable by keyboard", async () => {
    writeDraft(U1, PID, 1, { title: "Trip", doc: doubled() });
    mount();
    const region = await screen.findByRole("region", { name: te.draftRegion });
    const buttons = Array.from(region.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual([te.draftRestore, te.draftDiscard]);
    for (const b of buttons) {
      expect(b.className).toContain("min-h-11");
      expect(b.getAttribute("tabindex")).toBeNull();
      expect(b.tagName).toBe("BUTTON");
    }
    // not a dialog, not a drawer: the editor behind it stays usable
    expect(region.getAttribute("role")).toBeNull();
    expect(document.querySelector("[aria-modal]")).toBeNull();
    fireEvent.click(speed("0.5×"));
    expect(live().textContent).toBe(te.unsaved);
  });

  it("while the offer is open, edits do not overwrite the found draft", async () => {
    writeDraft(U1, PID, 1, { title: "Trip", doc: doubled() });
    mount();
    await screen.findByRole("region", { name: te.draftRegion });
    fireEvent.click(speed("0.5×"));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(store()?.doc.tracks[0].clips[0]).toMatchObject({ speed: 2 });
  });

  it("Discard removes the draft from this device and leaves the saved version", async () => {
    writeDraft(U1, PID, 1, { title: "Trip", doc: doubled() });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: te.draftDiscard }));
    expect(banner()).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(live().textContent).toBe(te.saved);
    expect(speed("1×")).toHaveProperty("checked", true);
  });

  it("a draft that equals the saved version is not offered, and is removed", () => {
    writeDraft(U1, PID, 1, { title: "Trip", doc: toDoc(toModel(base())) });
    mount();
    expect(banner()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("restores a draft that added a library video", async () => {
    const m = toModel(base());
    const withB = toDoc({
      ...m,
      clips: [
        ...m.clips,
        { ...m.clips[0], id: "c2", asset_id: B, start_s: 10, in_s: 0, out_s: 4 },
      ],
    });
    writeDraft(U1, PID, 1, { title: "Trip", doc: withB });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: te.draftRestore }));
    expect(
      screen.getAllByRole("button").some((b) => b.getAttribute("aria-label")?.includes("city.mp4")),
    ).toBe(true);
  });

  it("a draft naming a file that is gone from the library is explained and dropped", async () => {
    const m = toModel(base());
    const gone = toDoc({
      ...m,
      clips: [{ ...m.clips[0], asset_id: "33333333-3333-4333-8333-333333333333" }],
    });
    writeDraft(U1, PID, 1, { title: "Trip", doc: gone });
    mount();
    expect(await screen.findByText(te.draftUnusable)).toBeTruthy();
    expect(screen.queryByRole("button", { name: te.draftRestore })).toBeNull();
    expect(localStorage.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: te.draftDiscard }));
    expect(banner()).toBeNull();
  });

  it("when the project moved on (stale revision) it says so, never restores, and Discard clears it", async () => {
    writeDraft(U1, PID, 1, { title: "Trip", doc: doubled() });
    mount({ rev: 2 });
    expect(await screen.findByText(te.draftStale)).toBeTruthy();
    expect(screen.queryByRole("button", { name: te.draftRestore })).toBeNull();
    expect(live().textContent).toBe(te.saved);
    expect(speed("1×")).toHaveProperty("checked", true);
    // still there until the member decides
    expect(readDraft(U1, PID, 1)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: te.draftDiscard }));
    expect(banner()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("a save refused as stale keeps the draft, and the next open explains it", async () => {
    putStatus = 409;
    putBody = { error: "stale_revision" };
    const first = mount();
    fireEvent.click(speed("2×"));
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    expect(await screen.findByText(te.errors.stale_revision)).toBeTruthy();
    first.unmount(); // the editor closing keeps what is not saved
    expect(store(1)).not.toBeNull();
    cleanup();
    mount({ rev: 2 });
    expect(await screen.findByText(te.draftStale)).toBeTruthy();
  });

  it("is isolated: another member, another project, or a signed-out page sees no offer", () => {
    writeDraft(U1, PID, 1, { title: "Trip", doc: doubled() });
    mount({ userId: U2 });
    expect(banner()).toBeNull();
    expect(screen.queryByText(te.draftStale)).toBeNull();
    cleanup();
    mount({ projectId: OTHER_PID });
    expect(banner()).toBeNull();
    expect(screen.queryByText(te.draftStale)).toBeNull();
    cleanup();
    mount({ userId: undefined });
    expect(banner()).toBeNull();
    // the owner's draft is untouched by all of that
    expect(readDraft(U1, PID, 1)).not.toBeNull();
  });

  it("after sign-out nobody is offered the old draft and a closing editor does not write it back", async () => {
    vi.useFakeTimers();
    const { unmount } = mount();
    fireEvent.click(speed("2×"));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(localStorage.length).toBe(1);
    clearAllEditorDrafts(); // what Sign out does
    unmount();
    expect(localStorage.length).toBe(0);
  });

  it("the offer reads in Russian", async () => {
    writeDraft(U1, PID, 1, { title: "Trip", doc: doubled() });
    mount({ locale: "ru" });
    expect(await screen.findByRole("button", { name: ru.editor.draftRestore })).toBeTruthy();
    expect(screen.getByRole("region", { name: ru.editor.draftRegion }).textContent).toContain(
      fmt(ru.editor.draftFound, { when: "" }).split(" ")[0],
    );
  });
});
