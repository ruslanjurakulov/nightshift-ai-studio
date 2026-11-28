// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { NightshiftAiPanel } from "@/components/brain/NightshiftAiPanel";
import { BRAIN_ACTIVITY_EVENT, BRAIN_BRIEF_EVENT } from "@/lib/brain/canvas-events";
import type { BrainStreamEvent } from "@/lib/brain/stream-events";

vi.mock("@/lib/legal", () => ({ LEGAL: { contactEmail: "help@example.test" } }));
const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace }), usePathname: () => "/chronos/studio" }));

/**
 * The panel reading POST /api/brain/turn's stream (docs/studio/LIVE_CREATION_PLAN.md §3.1, §3.5). What would break without these: a
 * progress line made up by a timer instead of counted from the chapters the server really finished; a window's text shown unlabelled,
 * as if it were the chosen plan; Choose pressable before `end`; the canvas not told what the stream said; a server with the stream off
 * (plain JSON) no longer understood; a stream cut by a proxy said as a failure, or pressed again, instead of followed via the lease.
 */

const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const outline = (title: string) => ({ title, idea: `idea ${title}`, target_seconds: 120, characters: [{ id: "c1" }], scenes: [],
  chapters: [{ id: "ch1", title: "Dawn", seconds: 60, beats: [] }, { id: "ch2", title: "Dusk", seconds: 60, beats: [] }] });
const DONE_BODY = {
  brief: { version: 1, kind: "short", title: "Alpha", idea: "idea Alpha", target_seconds: 120, voice: { mode: "off" }, music: { mode: "off" },
           scenes: [{ id: "s1" }], characters: [], price: { state: "priced", total_credits: 40, spendable: 100, fits: true, shorter: null } },
  film: { id: "film-1", version: 2 }, models: { clip: { id: "minimax-h3", name: "MiniMax H3" }, keyframe: null },
};
const scene = (title: string, seconds: number) => ({ title, seconds, visual_prompt: `prompt of ${title}`, dialogue: [] });
const part = (n: number, title: string, p = 1, of = 1) => ({ chapter_id: `ch${n}`, chapter_n: n, title, part: p, parts: of, scenes: [scene(`${title}-${p}`, 60 / of)] });

let sent: Record<string, unknown>[] = [];
/** What the turn route answers: a live stream the test writes into, or today's JSON. */
let answer: { kind: "stream" } | { kind: "json"; status: number; body: unknown } = { kind: "stream" };
let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
const enc = new TextEncoder();
const send = async (e: BrainStreamEvent | Record<string, unknown>) => {
  await act(async () => {
    ctl!.enqueue(enc.encode(`${JSON.stringify(e)}\n`));
    await new Promise((r) => setTimeout(r, 0));
  });
};
let historyReads = 0;

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/brain/history")) {
      if (/session=/.test(url)) {
        historyReads += 1;
        return json(200, { session: { id: S1, step: "proposing" }, card: null, brief: { version: 1, kind: "short" }, plan: null,
          messages: [{ id: 1, role: "assistant", content: "Pick one", payload: { scenarios: [outline("Alpha"), outline("Beta")] } }] });
      }
      return json(200, { sessions: [], next_before: null });
    }
    if (url.startsWith("/api/brain/turn")) {
      sent.push(JSON.parse(String(init?.body)));
      if (answer.kind === "json") return json(answer.status, answer.body);
      const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
      return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }
    return json(200, { plan: { used: 0, limit: 30, trial_left: null, max_input_chars: 2000 }, model: "available", canEdit: true, canRun: true,
                       session: { id: S1 }, gate: null });
  }));
}

const activity: unknown[] = [];
const briefs: unknown[] = [];
const onActivity = (e: Event) => activity.push((e as CustomEvent).detail);
const onBrief = (e: Event) => briefs.push((e as CustomEvent).detail);

beforeEach(() => {
  sent = [];
  ctl = null;
  historyReads = 0;
  answer = { kind: "stream" };
  activity.length = 0;
  briefs.length = 0;
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  window.addEventListener(BRAIN_ACTIVITY_EVENT, onActivity);
  window.addEventListener(BRAIN_BRIEF_EVENT, onBrief);
  stub();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.removeEventListener(BRAIN_ACTIVITY_EVENT, onActivity);
  window.removeEventListener(BRAIN_BRIEF_EVENT, onBrief);
});

const fmt = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k]));
const chooseAlpha = (words = dictionaries.en.aiChat) => screen.getByRole("button", { name: words.chooseThisNamed.replace("{title}", "Alpha") });

async function openAndChoose(locale: "en" | "ru" | "uz" = "en") {
  render(<I18nProvider locale={locale}><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
  await screen.findByText("Alpha");
  await act(async () => fireEvent.click(chooseAlpha(dictionaries[locale].aiChat)));
  await waitFor(() => expect(sent).toHaveLength(1));
}

describe("Nightshift AI panel: the stream", () => {
  it("asks for the stream on a press, counts chapters the server finished, labels their checked text Written, and allows Choose only after end", async () => {
    const en = dictionaries.en.aiChat;
    await openAndChoose();
    expect(sent[0]).toMatchObject({ action: "choose", index: 0, stream: true });
    await waitFor(() => expect(ctl).not.toBeNull());
    // Before plan.begun there is no count to show: the plan's own words only, never a made-up "1 of ?".
    const region = screen.getByText(en.planWriting);
    expect(region.getAttribute("role")).toBe("status");
    expect(screen.queryByText(/Chapters written/)).toBeNull();

    await send({ type: "phase", phase: "planning" });
    await send({ type: "plan.begun", windows: 2, chapters: 2, at_most: 4, about: 2 });
    expect(await screen.findByText(fmt(en.planProgress, { n: 0, total: 2 }))).toBeTruthy();
    // One status region, kept mounted, its words swapped (Pixel): the plan note gives way to the count, never two lines at once.
    expect(region.isConnected).toBe(true);
    expect(region.textContent).toBe(fmt(en.planProgress, { n: 0, total: 2 }));
    expect(screen.queryByText(en.planWriting)).toBeNull();
    // A newer server's event the panel does not know is skipped, never a crash.
    await send({ type: "plan.scene", n: 1 });
    await send({ type: "ping" });

    await send({ type: "plan.window", index: 1, n: 2, of: 2, parts: [part(2, "Dusk")] });
    expect(await screen.findByText(fmt(en.planProgress, { n: 1, total: 2 }))).toBeTruthy();
    const written = screen.getByRole("region", { name: fmt(en.planChapter, { n: 2, title: "Dusk" }) });
    expect(written.textContent).toContain(en.planWritten);
    expect(written.textContent).toContain("prompt of Dusk-1");
    // The count sits under the chapter list, so it stays in view at 360 px.
    expect(written.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Choosing again is closed while the stream runs (busy): only `end` decides.
    expect((chooseAlpha() as HTMLButtonElement).disabled).toBe(true);

    await send({ type: "plan.window", index: 0, n: 1, of: 2, parts: [part(1, "Dawn")] });
    expect(await screen.findByText(fmt(en.planAllWritten, { total: 2 }))).toBeTruthy();
    await send({ type: "phase", phase: "saving" });
    expect(await screen.findByText(en.planSaving)).toBeTruthy();
    await send({ type: "phase", phase: "pricing" });
    expect(await screen.findByText(en.planPricing)).toBeTruthy();

    await send({ type: "end", status: 200, body: DONE_BODY });
    await act(async () => { ctl!.close(); });
    expect(await screen.findByText(en.modelVideo.replace("{name}", "MiniMax H3"))).toBeTruthy();
    // The live plan is gone with `end`: what stands is the saved plan.
    expect(document.querySelector("[data-live-plan]")).toBeNull();
    expect(screen.queryByText(en.planWriting)).toBeNull();

    // The canvas heard the same real events, for this conversation, then the end and the brief.
    expect(activity).toEqual([
      { session_id: S1, phase: "planning" },
      { session_id: S1, phase: "planning", plan: { windows: 0, of: 2, chapters_written: 0, chapters: 2 } },
      { session_id: S1, phase: "planning", plan: { windows: 1, of: 2, chapters_written: 1, chapters: 2 } },
      { session_id: S1, phase: "planning", plan: { windows: 2, of: 2, chapters_written: 2, chapters: 2 } },
      { session_id: S1, phase: "saving", plan: { windows: 2, of: 2, chapters_written: 2, chapters: 2 } },
      { session_id: S1, phase: "pricing", plan: { windows: 2, of: 2, chapters_written: 2, chapters: 2 } },
      { session_id: S1, phase: "end" },
    ]);
    expect(briefs.at(-1)).toMatchObject({ session_id: S1 });
  });

  it("a chapter split across two windows counts as written only once both parts arrived", async () => {
    const en = dictionaries.en.aiChat;
    await openAndChoose();
    await waitFor(() => expect(ctl).not.toBeNull());
    await send({ type: "plan.begun", windows: 3, chapters: 2, at_most: 6, about: 3 });
    await send({ type: "plan.window", index: 0, n: 1, of: 3, parts: [part(1, "Dawn", 1, 2)] });
    expect(await screen.findByText(fmt(en.planProgress, { n: 0, total: 2 }))).toBeTruthy();
    expect(screen.queryByRole("region", { name: fmt(en.planChapter, { n: 1, title: "Dawn" }) })).toBeNull();
    await send({ type: "plan.window", index: 1, n: 2, of: 3, parts: [part(1, "Dawn", 2, 2)] });
    const ch = await screen.findByRole("region", { name: fmt(en.planChapter, { n: 1, title: "Dawn" }) });
    expect(ch.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText(fmt(en.planProgress, { n: 1, total: 2 }))).toBeTruthy();
  });

  it("a failure in end is today's refusal, and what the stream had shown is dropped", async () => {
    const en = dictionaries.en.aiChat;
    await openAndChoose();
    await waitFor(() => expect(ctl).not.toBeNull());
    await send({ type: "plan.begun", windows: 2, chapters: 2, at_most: 4, about: 2 });
    await send({ type: "plan.window", index: 0, n: 1, of: 2, parts: [part(1, "Dawn")] });
    await send({ type: "end", status: 502, body: { error: "plan_failed", reason: "vendor_error", step: { window: 2, windows: 2, chapter: 2, chapters: 2 } } });
    await act(async () => { ctl!.close(); });
    expect(await screen.findByRole("button", { name: en.retry })).toBeTruthy();
    expect(document.querySelector("[data-live-plan]")).toBeNull();
    expect(screen.queryByText("prompt of Dawn-1")).toBeNull();
  });

  it("a stream cut before end follows the plan through its lease (waitForPlan), never says it failed and never presses again", async () => {
    const en = dictionaries.en.aiChat;
    await openAndChoose();
    await waitFor(() => expect(ctl).not.toBeNull());
    await send({ type: "plan.begun", windows: 2, chapters: 2, at_most: 4, about: 2 });
    await send({ type: "plan.window", index: 0, n: 1, of: 2, parts: [part(1, "Dawn")] });
    await act(async () => { ctl!.close(); await new Promise((r) => setTimeout(r, 0)); });
    // Still waiting for the plan that runs on the server: its words, no error, no Retry, no second press.
    expect(await screen.findByText(en.planConnectionLost)).toBeTruthy();
    // The last live view stays while the plan is followed: the chapter already written is still on screen.
    expect(screen.getByRole("region", { name: fmt(en.planChapter, { n: 1, title: "Dawn" }) })).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.retry })).toBeNull();
    expect(screen.queryByText(en.errors.unavailable)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("a network error mid-stream (read() rejects) is the same cut: waitForPlan, never 'unavailable' (Lens M1)", async () => {
    const en = dictionaries.en.aiChat;
    await openAndChoose();
    await waitFor(() => expect(ctl).not.toBeNull());
    await send({ type: "plan.begun", windows: 2, chapters: 2, at_most: 4, about: 2 });
    await act(async () => { ctl!.error(new TypeError("network")); await new Promise((r) => setTimeout(r, 0)); });
    expect(await screen.findByText(en.planConnectionLost)).toBeTruthy();
    expect(screen.queryByText(en.errors.unavailable)).toBeNull();
    expect(screen.queryByRole("button", { name: en.retry })).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("a server with the stream off answers JSON, and the panel reads it as before", async () => {
    answer = { kind: "json", status: 200, body: DONE_BODY };
    await openAndChoose();
    expect(await screen.findByText(dictionaries.en.aiChat.modelVideo.replace("{name}", "MiniMax H3"))).toBeTruthy();
    expect(activity).toEqual([]);
  });

  it.each(["en", "ru", "uz"] as const)("says the progress, the Written label and the chapter in %s", async (locale) => {
    const w = dictionaries[locale].aiChat;
    await openAndChoose(locale);
    await waitFor(() => expect(ctl).not.toBeNull());
    await send({ type: "plan.begun", windows: 2, chapters: 2, at_most: 4, about: 2 });
    expect(await screen.findByText(fmt(w.planProgress, { n: 0, total: 2 }))).toBeTruthy();
    await send({ type: "plan.window", index: 0, n: 1, of: 2, parts: [part(1, "Dawn")] });
    const region = await screen.findByRole("region", { name: fmt(w.planChapter, { n: 1, title: "Dawn" }) });
    expect(region.textContent).toContain(w.planWritten);
    await send({ type: "phase", phase: "saving" });
    expect(await screen.findByText(w.planSaving)).toBeTruthy();
  });
});

describe("the stream's words", () => {
  it("exist in en, ru and uz, are not English in ru and uz, and keep their placeholders", () => {
    const keys = ["planProgress", "planAllWritten", "planConnectionLost", "planSaving", "planPricing", "planWritten", "planChapter"] as const;
    for (const k of keys) {
      const en = dictionaries.en.aiChat[k];
      for (const l of ["ru", "uz"] as const) {
        const v = dictionaries[l].aiChat[k];
        expect(typeof v === "string" && v.length > 0, `${l}.${k}`).toBe(true);
        expect(v, `${l}.${k}`).not.toBe(en);
        expect((v.match(/\{\w+\}/g) ?? []).sort(), `${l}.${k}`).toEqual((en.match(/\{\w+\}/g) ?? []).sort());
      }
    }
  });
});
