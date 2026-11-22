// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { NightshiftAiPanel } from "@/components/brain/NightshiftAiPanel";

/**
 * The panel's plan step at its edges (Probe on S1). What would break without these: a double press taking every turn twice; a
 * refresh mid-plan pressing again instead of waiting; a stale remembered press blocking the outline forever; plan_over_cap offering a
 * Retry that meets the same refusal; a failed plan with no step said as "chapter undefined of undefined"; a network drop losing the
 * press id (so its Retry is a second plan, not the same press).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/chronos/studio" }));

const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const outline = (title: string) => ({ title, idea: `idea ${title}`, target_seconds: 120, characters: [{ id: "c1" }], scenes: [],
  chapters: [{ id: "ch1", title: "a", seconds: 60, beats: [] }, { id: "ch2", title: "b", seconds: 60, beats: [] }] });
const en = dictionaries.en.aiChat;
const PROPOSING = { session: { id: S1, step: "proposing" }, card: null, brief: { version: 1, kind: "short" },
  messages: [{ id: 1, role: "assistant", content: "Pick one", payload: { scenarios: [outline("Alpha"), outline("Beta")] } }] };
const READY = { session: { id: S1, step: "ready" }, card: null,
  brief: { version: 1, session_id: S1, status: "ready", kind: "short", title: "Alpha", idea: "idea Alpha", language: "English", target_seconds: 120, voice: { mode: "off" },
           music: { mode: "off" }, characters: [], scenes: [{ id: "s1", n: 1, title: "a", duration_s: 60 }, { id: "s2", n: 2, title: "b", duration_s: 60 }] },
  messages: [...PROPOSING.messages, { id: 2, role: "user", content: "Alpha" }] };

let sent: Record<string, unknown>[] = [];
let release: (() => void) | null = null;
let turnReply: { status: number; body: unknown } | "throw" = { status: 502, body: {} };
let holdTurn = true;
let sessionReads = 0;
let readyAfter = Infinity;

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/brain/history")) {
      if (/session=/.test(url)) {
        sessionReads += 1;
        return json(200, sessionReads > readyAfter ? READY : PROPOSING);
      }
      return json(200, { sessions: [], next_before: null });
    }
    if (url.startsWith("/api/brain/turn")) {
      sent.push(JSON.parse(String(init?.body)));
      if (holdTurn) await new Promise<void>((r) => { release = r; });
      if (turnReply === "throw") throw new TypeError("Failed to fetch");
      return json(turnReply.status, turnReply.body);
    }
    return json(200, { plan: { used: 0, limit: 30, trial_left: null, max_input_chars: 2000 }, model: "available", canEdit: true, canRun: true, session: { id: S1 } });
  }));
}
const mount = () => render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
const chooseAlpha = () => screen.getByRole("button", { name: en.chooseThisNamed.replace("{title}", "Alpha") });
const key = `nightshift-ai-plan:${S1}`;

beforeEach(() => {
  sent = [];
  release = null;
  holdTurn = true;
  sessionReads = 0;
  readyAfter = Infinity;
  turnReply = { status: 502, body: { error: "plan_failed", reason: "vendor_error", step: { window: 1, windows: 1, chapter: 1, chapters: 2 } } };
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("pressing choose twice, and refreshing mid-plan", () => {
  it("a second press while the storyboard is being written sends nothing", async () => {
    stub();
    mount();
    await screen.findByText("Alpha");
    fireEvent.click(chooseAlpha());
    fireEvent.click(chooseAlpha());
    fireEvent.click(screen.getByRole("button", { name: en.chooseThisNamed.replace("{title}", "Beta") }));
    await waitFor(() => expect(sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
    await act(async () => release!());
  });

  it("a refresh mid-plan waits for the remembered press: no second POST, the status says it is writing, and the plan arrives", async () => {
    window.sessionStorage.setItem(key, JSON.stringify({ rid: "pmidplan1234", index: 0, title: "Alpha", at: Date.now() }));
    readyAfter = 1; // the first read (the mount) is still proposing; the wait's first poll finds the stored plan.
    stub();
    mount();
    expect(await screen.findByText(en.planWriting)).toBeTruthy();
    expect(sent).toHaveLength(0);
    // The wait polls every 5 s (real time: the panel's own timer).
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull(), { timeout: 8_000 });
    await waitFor(() => expect(screen.queryByText(en.planWriting)).toBeNull());
    expect(sent).toHaveLength(0);
    expect(await screen.findByRole("region", { name: en.planReady })).toBeTruthy();
  }, 15_000);

  it("a remembered press older than the route's 300 s is forgotten: the outlines can be chosen again, with a new id", async () => {
    window.sessionStorage.setItem(key, JSON.stringify({ rid: "pstale12345", index: 0, title: "Alpha", at: Date.now() - 400_000 }));
    stub();
    mount();
    await screen.findByText("Alpha");
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
    expect(screen.queryByText(en.planWriting)).toBeNull();
    fireEvent.click(chooseAlpha());
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].request_id).not.toBe("pstale12345");
    await act(async () => release!());
  });

  it("a malformed remembered press (someone else's JSON in the key) is ignored, never crashes the panel", async () => {
    window.sessionStorage.setItem(key, "{not json");
    stub();
    mount();
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.queryByText(en.planWriting)).toBeNull();
  });

  it("a duplicate_request answer (the same press already running) waits for that plan instead of failing", async () => {
    holdTurn = false;
    turnReply = { status: 409, body: { error: "duplicate_request" } };
    stub();
    mount();
    await screen.findByText("Alpha");
    fireEvent.click(chooseAlpha());
    await waitFor(() => expect(sent).toHaveLength(1));
    // Still writing (waiting on the first copy), never an error.
    expect(await screen.findByText(en.planWriting)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(window.sessionStorage.getItem(key)).toContain(String(sent[0].request_id));
  });

  it("a network drop keeps the press id: its Retry is the same press (the server answers it as a duplicate, never a second plan)", async () => {
    turnReply = "throw";
    stub();
    mount();
    await screen.findByText("Alpha");
    fireEvent.click(chooseAlpha());
    await waitFor(() => expect(sent).toHaveLength(1));
    await act(async () => release!());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.errors.unavailable);
    fireEvent.click(screen.getByRole("button", { name: en.retry }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].request_id).toBe(sent[0].request_id);
    await act(async () => release!());
  });
});

describe("the plan's refusals, each with its own words and remedy", () => {
  const cases: { name: string; status: number; body: Record<string, unknown>; text: string; retry: boolean }[] = [
    { name: "plan_over_cap at left == needed - 1", status: 429, body: { error: "plan_over_cap", needed: 8, left: 7 },
      text: en.errors.plan_over_cap.replace("{needed}", "8").replace("{left}", "7"), retry: false },
    { name: "plan_over_cap with one left", status: 429, body: { error: "plan_over_cap", needed: 2, left: 1 },
      text: en.errors.plan_over_cap.replace("{needed}", "2").replace("{left}", "1"), retry: false },
    { name: "plan_length_mismatch with its step", status: 502, body: { error: "plan_length_mismatch", step: { window: 2, windows: 3, chapter: 2, chapters: 3 } },
      text: en.errors.plan_length_mismatch.replace("{n}", "2").replace("{total}", "3"), retry: true },
    { name: "plan_length_mismatch from the merge (no step)", status: 502, body: { error: "plan_length_mismatch", step: null },
      text: en.errors.plan_length_mismatch_plain, retry: true },
    { name: "plan_failed with no step", status: 502, body: { error: "plan_failed", reason: "unavailable", step: null },
      text: en.errors.plan_failed_plain, retry: true },
    { name: "plan_failed timeout on chapter 3 of 4", status: 502, body: { error: "plan_failed", reason: "timeout", step: { window: 5, windows: 8, chapter: 3, chapters: 4 } },
      text: en.errors.plan_failed.replace("{n}", "3").replace("{total}", "4"), retry: true },
    { name: "the daily cap met by a re-ask", status: 429, body: { error: "chat_daily_cap", used: 30, limit: 30 },
      text: en.errors.chat_daily_cap.replace("{used}", "30").replace("{limit}", "30"), retry: false },
    { name: "the plan's own safety refusal", status: 422, body: { error: "content_refused" }, text: en.errors.content_refused, retry: false },
  ];
  for (const c of cases) {
    it(`${c.name}: said in its own words, ${c.retry ? "with" : "without"} Retry, the outlines still on screen, the press forgotten`, async () => {
      holdTurn = false;
      turnReply = { status: c.status, body: c.body };
      stub();
      mount();
      await screen.findByText("Alpha");
      fireEvent.click(chooseAlpha());
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(c.text);
      expect(alert.textContent).not.toMatch(/undefined|\{n\}|\{total\}|\{needed\}|\{left\}/);
      expect(!!screen.queryByRole("button", { name: en.retry })).toBe(c.retry);
      expect(chooseAlpha()).toBeTruthy();
      expect(window.sessionStorage.getItem(key)).toBeNull();
    });
  }

  it("plan_over_cap without its numbers is never drawn with blanks: the generic line instead", async () => {
    holdTurn = false;
    turnReply = { status: 429, body: { error: "plan_over_cap" } };
    stub();
    mount();
    await screen.findByText("Alpha");
    fireEvent.click(chooseAlpha());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/undefined|\{needed\}/);
  });

  it("the quota a failed plan reports replaces the meter's count (the turns it did take are shown)", async () => {
    holdTurn = false;
    turnReply = { status: 502, body: { error: "plan_failed", reason: "vendor_error", step: { window: 2, windows: 3, chapter: 2, chapters: 3 }, quota: { used: 12, limit: 30, trial_left: null } } };
    stub();
    mount();
    await screen.findByText("Alpha");
    fireEvent.click(chooseAlpha());
    await screen.findByRole("alert");
    expect(await screen.findByText(en.quota.replace("{used}", "12").replace("{limit}", "30"))).toBeTruthy();
  });
});
