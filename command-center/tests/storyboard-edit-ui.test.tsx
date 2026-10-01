// @vitest-environment jsdom
/**
 * Editing a storyboard before approving it, and re-opening one whose render
 * failed (migration 0058), in a browser-like DOM.
 *
 * What would break without these: an Approve pressed for scenes that were
 * never saved (so the price on the button is not the price of what renders);
 * a save that sends a length or loses which scene is which; a price computed
 * in the browser instead of the one the server sent back; a stale save that
 * looks saved; a delete that cannot be undone; reordering a keyboard user
 * cannot do or follow; a Re-open offered for a render that may still run; a
 * read-only person handed editors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/x/videos/storyboard/1",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { fmt } from "@/lib/i18n";
import { StoryboardReview } from "@/components/storyboard/StoryboardReview";
import type { ReopenState, StoryboardQuote, StoryboardView } from "@/lib/storyboardReview";
import { PROVIDER_BRANDS } from "./helpers/brands";

const ts = en.storyboardReview;
const ID = "0b8f7a52-3f9c-4d1e-9b7a-1c2d3e4f5a6b";

const SB: StoryboardView = {
  id: ID,
  channelId: "chan-a",
  slug: "the-lighthouse",
  topic: "The Lighthouse",
  title: "The Last Lighthouse",
  scenes: [
    { n: 1, name: "Open", type: "hook", narration: "A light in the storm.", visual: "storm waves at night", durationS: 20 },
    { n: 2, name: "Keeper", type: "story", narration: "He kept it lit.", visual: "", durationS: 250 },
    { n: 3, name: "End", type: "story", narration: "Then it went dark.", visual: "dark tower", durationS: 30 },
  ],
  durationS: 300,
  status: "ready",
  createdAt: "2026-10-01T10:00:00Z",
  decidedAt: null,
  creditsHeld: null,
  renderJobId: null,
  revision: 2,
};

function mount(
  over: { quote?: StoryboardQuote; canRun?: boolean; storyboard?: Partial<StoryboardView>; reopen?: ReopenState | null } = {},
) {
  const ui: ReactNode = (
    <I18nProvider locale="en">
      <StoryboardReview
        storyboard={{ ...SB, ...over.storyboard }}
        quote={over.quote ?? { kind: "paid", credits: 60 }}
        canRun={over.canRun ?? true}
        backHref="/x/videos"
        reopen={over.reopen ?? null}
      />
    </I18nProvider>
  );
  return render(ui);
}

type Call = { url: string; body: unknown };
let calls: Call[] = [];
let answers: { status: number; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  answers = [];
  refresh.mockReset();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const a = answers.shift() ?? { status: 200, body: { ok: true } };
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const narration = (n: number) => screen.getAllByLabelText(ts.narration)[n - 1] as HTMLTextAreaElement;
const visual = (n: number) => screen.getAllByLabelText(ts.visual)[n - 1] as HTMLTextAreaElement;
const approveBtn = (credits: number) => screen.getByRole("button", { name: fmt(ts.approve, { credits }) }) as HTMLButtonElement;
const saveState = () => screen.getByTestId("storyboard-save-state").textContent;

describe("editing a waiting storyboard", () => {
  it("each scene has labelled editors, and it starts Saved", () => {
    mount();
    expect(screen.getAllByTestId("storyboard-scene")).toHaveLength(3);
    expect(narration(1).value).toBe("A light in the storm.");
    expect(visual(1).value).toBe("storm waves at night");
    expect(saveState()).toBe(ts.saved);
    expect(approveBtn(60).disabled).toBe(false);
  });

  it("an unsaved change says Not saved and holds the Approve until it is saved", async () => {
    mount();
    fireEvent.change(narration(2), { target: { value: "He kept it lit, every night." } });
    expect(saveState()).toBe(ts.notSaved);
    expect(approveBtn(60).disabled).toBe(true);
    expect(screen.getByText(ts.saveFirst, { exact: false })).toBeTruthy();
    // The edited scene's length is the database's to measure — none is guessed.
    expect(within(screen.getAllByTestId("storyboard-scene")[1]).getByText(ts.lengthOnSave)).toBeTruthy();
    fireEvent.click(approveBtn(60));
    expect(calls).toHaveLength(0);
  });

  it("saves the whole list with which scene is which, and shows the server's new price", async () => {
    answers = [
      {
        status: 200,
        body: {
          ok: true,
          changed: true,
          revision: 3,
          durationS: 280,
          scenes: [
            { n: 1, narration: "A light in the storm.", visual: "storm waves at night", duration_s: 20 },
            { n: 2, narration: "He kept it lit, every night.", visual: "", duration_s: 3 },
            { n: 3, narration: "Then it went dark.", visual: "dark tower", duration_s: 30 },
          ],
          quote: { kind: "paid", credits: 57 },
        },
      },
      { status: 200, body: { ok: true } },
    ];
    mount();
    fireEvent.change(narration(2), { target: { value: "He kept it lit, every night." } });
    fireEvent.click(screen.getByRole("button", { name: ts.save }));
    await waitFor(() => expect(saveState()).toBe(ts.saved));
    expect(calls[0]).toEqual({
      url: `/api/storyboards/${ID}/edit`,
      body: {
        revision: 2,
        scenes: [
          { src: 1, narration: "A light in the storm.", visual: "storm waves at night" },
          { src: 2, narration: "He kept it lit, every night.", visual: "" },
          { src: 3, narration: "Then it went dark.", visual: "dark tower" },
        ],
      },
    });
    // The price on the button is the one the server computed for the saved scenes.
    const btn = approveBtn(57);
    expect(btn.disabled).toBe(false);
    expect(within(screen.getAllByTestId("storyboard-scene")[1]).getByText(fmt(ts.seconds, { n: 3 }))).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ url: `/api/storyboards/${ID}/approve`, body: { max_credits: 57, revision: 3 } });
  });

  it("moves scenes with buttons a keyboard reaches, keeps focus on the moved scene and says where it went", () => {
    mount();
    const down = screen.getByRole("button", { name: fmt(ts.moveDownLabel, { n: 1 }) });
    down.focus();
    act(() => {
      fireEvent.click(down);
    });
    expect(narration(1).value).toBe("He kept it lit.");
    expect(narration(2).value).toBe("A light in the storm.");
    // Focus followed the scene to position 2.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: fmt(ts.moveDownLabel, { n: 2 }) }));
    expect(screen.getByTestId("storyboard-announce").textContent).toBe(fmt(ts.moved, { n: 2 }));
    expect(saveState()).toBe(ts.notSaved);
    // The first scene cannot move up, the last cannot move down.
    expect((screen.getByRole("button", { name: fmt(ts.moveUpLabel, { n: 1 }) }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: fmt(ts.moveDownLabel, { n: 3 }) }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a delete can be undone, back where it was", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: fmt(ts.deleteLabel, { n: 2 }) }));
    expect(screen.getAllByTestId("storyboard-scene")).toHaveLength(2);
    expect(screen.getByText(fmt(ts.deletedNote, { n: 2 }))).toBeTruthy();
    const undo = screen.getByRole("button", { name: ts.undo });
    expect(document.activeElement).toBe(undo);
    fireEvent.click(undo);
    expect(screen.getAllByTestId("storyboard-scene")).toHaveLength(3);
    expect(narration(2).value).toBe("He kept it lit.");
    expect(saveState()).toBe(ts.saved);
    expect(screen.queryByTestId("storyboard-undo")).toBeNull();
  });

  it("adds a scene that must be written before it can be saved, and sends it as new", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: ts.addScene }));
    expect(screen.getAllByTestId("storyboard-scene")).toHaveLength(4);
    expect(document.activeElement).toBe(narration(4));
    const save = screen.getByRole("button", { name: ts.save }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(ts.probEmpty)).toBeTruthy();
    fireEvent.change(narration(4), { target: { value: "A new ending." } });
    expect(save.disabled).toBe(false);
    answers = [{ status: 409, body: { error: "stale_revision", revision: 3 } }];
    fireEvent.click(save);
    expect(await screen.findByText(ts.errStale)).toBeTruthy();
    expect((calls[0].body as { scenes: unknown[] }).scenes[3]).toEqual({ src: null, narration: "A new ending.", visual: "" });
    // A stale save is not saved, and nothing offers to press it through.
    expect(saveState()).toBe(ts.notSaved);
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: ts.loadLatest }));
    expect(refresh).toHaveBeenCalled();
  });

  it("cue markup is named before it is sent", () => {
    mount();
    fireEvent.change(narration(1), { target: { value: "Hello [SFX:boom] world" } });
    expect(screen.getByText(ts.probMarkup)).toBeTruthy();
    expect(narration(1).getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: ts.save }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Undo changes goes back to the saved storyboard", () => {
    mount();
    fireEvent.change(visual(3), { target: { value: "lighthouse ruins" } });
    fireEvent.click(screen.getByRole("button", { name: ts.revert }));
    expect(visual(3).value).toBe("dark tower");
    expect(saveState()).toBe(ts.saved);
  });

  it("someone who may not start runs, and a database without 0058, get no editors", () => {
    mount({ canRun: false });
    expect(screen.queryAllByLabelText(ts.narration)).toHaveLength(0);
    cleanup();
    mount({ storyboard: { revision: null } });
    expect(screen.queryAllByLabelText(ts.narration)).toHaveLength(0);
    expect(screen.queryByTestId("storyboard-save-state")).toBeNull();
    expect(screen.getByText("A light in the storm.")).toBeTruthy();
  });

  it("names no provider anywhere while editing", () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: ts.addScene }));
    expect(container.textContent).not.toMatch(PROVIDER_BRANDS);
  });
});

describe("re-opening after a failed render", () => {
  it("is offered only when the server says it is safe, and spends nothing", async () => {
    mount({ storyboard: { status: "approved" }, reopen: { reopenable: true, reason: null } });
    expect(screen.getByText(ts.renderFailedNote)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: ts.reopen }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: `/api/storyboards/${ID}/reopen`, body: {} });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("is not offered while a render may still run, or to someone who may not start runs", () => {
    mount({ storyboard: { status: "approved" }, reopen: { reopenable: false, reason: "hold_not_released" } });
    expect(screen.queryByRole("button", { name: ts.reopen })).toBeNull();
    expect(screen.getByText(ts.approvedNote)).toBeTruthy();
    cleanup();
    mount({ storyboard: { status: "approved" }, reopen: { reopenable: true, reason: null }, canRun: false });
    expect(screen.queryByRole("button", { name: ts.reopen })).toBeNull();
  });

  it("a refusal says why, and nothing reads as re-opened", async () => {
    answers = [{ status: 409, body: { error: "render_in_progress" } }];
    mount({ storyboard: { status: "approved" }, reopen: { reopenable: true, reason: null } });
    fireEvent.click(screen.getByRole("button", { name: ts.reopen }));
    expect((await screen.findByRole("alert")).textContent).toBe(ts.errReopenBusy);
    expect(screen.queryByText(ts.reopenedNote)).toBeNull();
  });
});
