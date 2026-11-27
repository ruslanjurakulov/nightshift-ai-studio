// @vitest-environment jsdom
/**
 * The film editor's "Write the storyboard with AI" on screen (components/films/FilmCanvas.tsx AiWriter, lib/brain/film-plan-view).
 * What would break without these: the button on over a project that has scenes, or before the server said a plan can run; a refusal
 * shown without its reason or remedy, or offered a retry that cannot change it; a price or credits figure on the button; no progress
 * while a plan that can take minutes writes; a refresh mid-plan that offers a second press instead of following the first; a
 * finished storyboard that does not appear on the board.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { filmStudioEn as t } from "../lib/i18n/film-studio/en";
import { filmStudioRu } from "../lib/i18n/film-studio/ru";
import { filmStudioUz } from "../lib/i18n/film-studio/uz";
import { fmt } from "../lib/i18n";
import { coerceFilmView } from "../lib/films";
import { costText, readCheck, refusalText } from "../lib/brain/film-plan-view";
import { FILM, filmJson, sceneJson } from "./films-fixtures";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt: f } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt: f, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }), usePathname: () => "/alpha/create/projects" }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (s: string) => `/alpha${s}` }));

const { FilmCanvas, AiWriter, AI_WAIT_POLL_MS } = await import("../components/films/FilmCanvas");
const w = t.canvas.ai;

let calls: { method: string; url: string; body: Record<string, unknown> | undefined }[] = [];
type Answer = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
let answer: (url: string, method: string) => Answer;
const READY = { ready: true, turns: { about: 2, at_most: 3 }, left: 27, scope: "plan", sets: { clip: "MiniMax H3", keyframe: null }, plan: null };

beforeEach(() => {
  calls = [];
  window.localStorage.clear();
  answer = (url) => (url.startsWith("/api/brain/film") ? { status: 200, body: READY } : { status: 200, body: { film: filmJson() } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    const a = await answer(url, method);
    // A string body is a page that is not JSON (a proxy's own 502/504).
    if (typeof a.body === "string") return new Response(a.body, { status: a.status, headers: { "content-type": "text/html" } });
    return new Response(JSON.stringify(a.body), { status: a.status });
  }));
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const writer = (o: Partial<Parameters<typeof AiWriter>[0]> = {}) => {
  const onWritten = o.onWritten ?? vi.fn(async () => {});
  render(<AiWriter t={t} filmId={FILM} version={3} canEdit readOnly={false} hasScenes={false} dirty={false} reasonId="why" onWritten={onWritten} {...o} />);
  return onWritten;
};
const button = () => screen.getByTestId("fs-ai") as HTMLButtonElement;
const reason = () => screen.getByTestId("fs-ai-reason").textContent ?? "";
const brainCalls = () => calls.filter((c) => c.url.startsWith("/api/brain/film"));

describe("off without asking the server", () => {
  it.each([
    ["a viewer", { canEdit: false }, w.viewer],
    ["a project that can no longer be edited", { readOnly: true }, w.readOnly],
    ["a project that has scenes", { hasScenes: true }, w.hasScenes],
    ["unsaved changes", { dirty: true }, w.dirty],
  ])("%s: off with its reason, and nothing is asked", (_n, props, text) => {
    writer(props);
    expect(button().disabled).toBe(true);
    expect(reason()).toBe(text);
    expect(document.getElementById(button().getAttribute("aria-describedby")!)?.textContent).toBe(text);
    expect(brainCalls()).toHaveLength(0);
  });
});

describe("what the server says before a press", () => {
  it("checking, then on, saying what it uses of what is left, the model it sets, and no price", async () => {
    writer();
    expect(button().disabled).toBe(true);
    expect(reason()).toBe(w.checking);
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(reason()).toContain(fmt(w.cost, { about: 2, most: 3, left: 27 }));
    expect(reason()).toContain(fmt(w.setsClip, { name: "MiniMax H3" }));
    expect(reason()).not.toMatch(/\$|cr\b|price:/i);
    expect(brainCalls()[0]).toMatchObject({ method: "GET", url: `/api/brain/film?film=${FILM}` });
  });

  it.each([
    ["Nightshift AI off for this workspace", 404, { error: "not_found" }, w.off, false],
    ["no paid plan", 402, { error: "chat_plan_required" }, w.planRequired, false],
    ["the model down", 409, { error: "model_unavailable", reason: "not_on_sale" }, w.modelDown, true],
    ["the 18+ gate", 428, { error: "adult_attestation_required" }, w.confirmAge, false],
    ["the country gate", 451, { error: "country_blocked" }, w.region, false],
    ["the cap", 429, { error: "plan_over_cap", needed: 7, about: 4, left: 2 }, fmt(w.overCap, { most: 7, left: 2 }), false],
    ["the person's own cap", 429, { error: "plan_over_cap", needed: 7, about: 4, left: 2, scope: "person" }, fmt(w.overCapPerson, { most: 7, left: 2 }), false],
    ["0211 missing", 503, { error: "plan_unavailable" }, w.planUnavailable, false],
    ["the project has scenes (saved elsewhere)", 409, { error: "film_has_scenes" }, w.hasScenes, false],
    ["the project's own model off sale", 409, { error: "film_model_unavailable", role: "keyframe" }, w.keyframeOff, false],
    ["a length that cannot be planned", 409, { error: "plan_failed", reason: "not_plannable" }, w.notPlannable, false],
  ])("%s: off with its own words; Check again only where it can change", async (_n, status, body, text, retry) => {
    answer = () => ({ status, body });
    writer();
    await waitFor(() => expect(reason()).toBe(text));
    expect(button().disabled).toBe(true);
    expect(!!screen.queryByTestId("fs-ai-check")).toBe(retry);
  });

  it("a network failure says so and offers Check again, which asks again", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n += 1;
      if (n === 1) throw new TypeError("offline");
      return new Response(JSON.stringify(READY), { status: 200 });
    }));
    writer();
    await waitFor(() => expect(reason()).toBe(w.network));
    fireEvent.click(screen.getByTestId("fs-ai-check"));
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it("a trial workspace is told it uses trial messages; an unknown left says no number for it", async () => {
    expect(costText(w, { about: 2, most: 3, left: 3, scope: "trial", sets: { clip: null, keyframe: null }, lastFailed: false })).toBe(fmt(w.costTrial, { about: 2, most: 3, left: 3 }));
    expect(costText(w, { about: 2, most: 3, left: null, scope: "plan", sets: { clip: null, keyframe: null }, lastFailed: false })).toBe(fmt(w.costUnknown, { about: 2, most: 3 }));
    // A ready answer without the counts is not drawn as a number (rule 5).
    expect(readCheck(w, 200, { ready: true, turns: {} })).toMatchObject({ kind: "blocked", retry: true });
  });
});

describe("the press", () => {
  it("shows progress while the plan writes, with the button off", async () => {
    let finish: (v: { status: number; body: unknown }) => void = () => {};
    answer = (url, method) => (method === "POST" ? new Promise((r) => { finish = r; }) : { status: 200, body: READY });
    writer();
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("fs-ai-progress")).toBeTruthy());
    expect(button().disabled).toBe(true);
    expect(reason()).toContain(w.writing);
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", url: "/api/brain/film", body: { film: FILM } }]);
    // A second click while it writes sends nothing.
    fireEvent.click(button());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    await act(async () => finish({ status: 502, body: { error: "plan_failed", reason: "vendor_error" } }));
    await waitFor(() => expect(screen.getByTestId("fs-ai-notice").textContent).toBe(w.planFailed));
    expect(screen.queryByTestId("fs-ai-progress")).toBeNull();
    // A retry can change a failed call: asked again, and the button offers Try again.
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(button().textContent).toBe(w.retry);
  });

  it("a refusal a retry cannot change keeps the button off with it", async () => {
    answer = (url, method) => (method === "POST" ? { status: 422, body: { error: "content_refused" } } : { status: 200, body: READY });
    writer();
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("fs-ai-notice").textContent).toBe(w.contentRefused));
    await waitFor(() => expect(reason()).toBe(w.contentRefused));
    expect(button().disabled).toBe(true);
  });

  it("plan_superseded is said with a Reload offer, and the project is read again only when the person presses it", async () => {
    answer = (url, method) => (method === "POST" ? { status: 409, body: { error: "plan_superseded", film_id: FILM } } : { status: 200, body: READY });
    const onWritten = writer();
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("fs-ai-notice").textContent).toBe(w.superseded));
    // Never by itself: the person's edits are on screen.
    expect(onWritten).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("fs-ai-reload"));
    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("fs-ai-reload")).toBeNull();
  });

  it("success reloads the project: the scenes are on the board and the notice says how many and how long", async () => {
    const written = [sceneJson("51000000-0000-4000-8000-000000000001", 0, { planned_seconds: 100 }), sceneJson("52000000-0000-4000-8000-000000000002", 1, { planned_seconds: 80 })];
    answer = (url, method) => {
      if (url.startsWith("/api/brain/film")) return method === "POST" ? { status: 200, body: { film: { id: FILM, version: 4 }, scenes: 2, seconds: 180 } } : { status: 200, body: READY };
      return { status: 200, body: { film: filmJson({ version: 4 }, written) } };
    };
    render(<FilmCanvas initial={coerceFilmView(filmJson({}, []))!} canEdit pictures={[]} characters={[]} listHref="/alpha/create/projects" />);
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(within(screen.getByTestId("fs-board")).getAllByRole("option")).toHaveLength(2));
    expect(calls.some((c) => c.method === "GET" && c.url === `/api/films/${FILM}`)).toBe(true);
    expect(screen.getByTestId("fs-ai-notice").textContent).toBe(fmt(w.done, { n: 2, length: "3:00" }));
    // The project has scenes now: off with that reason, and never a second storyboard over them.
    expect(button().disabled).toBe(true);
    expect(reason()).toBe(w.hasScenes);
  });
});

describe("a plan already running (a refresh, another tab)", () => {
  it("is followed through its lease, never pressed twice, and the project is read when it wrote", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let running = true;
    answer = () => (running ? { status: 200, body: { ready: false, plan: { state: "running", expires_at: "2026-11-27T10:00:00Z" } } } : { status: 409, body: { error: "film_has_scenes" } });
    const onWritten = writer();
    await waitFor(() => expect(reason()).toBe(w.writingElsewhere));
    expect(button().disabled).toBe(true);
    expect(screen.getByTestId("fs-ai-progress")).toBeTruthy();
    running = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(AI_WAIT_POLL_MS + 10); });
    await waitFor(() => expect(onWritten).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("a press that finds one running waits for it instead of failing", async () => {
    answer = (url, method) => (method === "POST" ? { status: 409, body: { error: "plan_running", expires_at: "2026-11-27T10:00:00Z" } } : { status: 200, body: READY });
    writer();
    await waitFor(() => expect(button().disabled).toBe(false));
    answer = (url, method) => (method === "POST" ? { status: 409, body: { error: "plan_running" } } : { status: 200, body: { ready: false, plan: { state: "running", expires_at: null } } });
    fireEvent.click(button());
    await waitFor(() => expect(reason()).toBe(w.writingElsewhere));
    expect(screen.getByTestId("fs-ai-notice").textContent).toBe("");
  });
});

describe("every refusal has words in all three languages", () => {
  const codes: [number, Record<string, unknown>][] = [
    [404, {}], [401, { error: "unauthorized" }], [403, { error: "forbidden" }], [403, { error: "adult_only_service" }],
    [428, { error: "adult_attestation_required" }], [503, { error: "age_unavailable" }], [451, { error: "country_blocked" }],
    [451, { error: "country_unverified" }], [409, { error: "film_not_editable" }], [409, { error: "film_has_scenes" }],
    [422, { error: "content_refused" }], [409, { error: "film_model_unavailable", role: "clip" }], [409, { error: "model_unavailable" }],
    [402, { error: "chat_plan_required" }], [429, { error: "chat_daily_cap" }], [429, { error: "plan_over_cap", needed: 3, left: 1 }],
    [503, { error: "plan_unavailable" }], [409, { error: "plan_superseded" }], [502, { error: "plan_length_mismatch" }],
    [422, { error: "prompt_too_long", limit: 1500 }], [409, { error: "film_refused" }], [502, { error: "plan_failed", reason: "vendor_auth" }],
    [502, { error: "plan_failed", reason: "timeout" }], [503, { error: "unavailable" }],
    [422, { error: "source_too_long", limit: 40000 }], [422, { error: "title_claims_vendor" }], [409, { error: "film_conversation" }],
    [409, { error: "film_channel_missing" }], [409, { error: "session_closed" }], [409, { error: "nothing_to_retry" }],
    [400, { error: "message_too_long" }], [400, { error: "invalid_params" }], [429, { error: "plan_over_cap", needed: 3 }],
  ];
  it.each([["en", t], ["ru", filmStudioRu], ["uz", filmStudioUz]] as const)("%s", (_l, d) => {
    for (const [status, body] of codes) {
      const r = refusalText(d.canvas.ai, status, body);
      expect(r.text.trim().length, JSON.stringify(body)).toBeGreaterThan(10);
      expect(r.text, JSON.stringify(body)).not.toMatch(/\{\w+\}/);
    }
    // A key the vendor refused is the owner's fix: no retry; a timeout is a retry's.
    expect(refusalText(d.canvas.ai, 502, { error: "plan_failed", reason: "vendor_auth" }).retry).toBe(false);
    expect(refusalText(d.canvas.ai, 502, { error: "plan_failed", reason: "timeout" }).retry).toBe(true);
  });
});

describe("fix round: the canvas while it writes, a lost answer, unsaved changes", () => {
  it("the canvas is read-only while the press is pending: no Add scene, settings disabled; editable again when it ends", async () => {
    let finish: (v: { status: number; body: unknown }) => void = () => {};
    answer = (url, method) => {
      if (url.startsWith("/api/brain/film")) return method === "POST" ? new Promise((r) => { finish = r; }) : { status: 200, body: READY };
      return { status: 200, body: { film: filmJson() } };
    };
    render(<FilmCanvas initial={coerceFilmView(filmJson({}, []))!} canEdit pictures={[]} characters={[]} listHref="/alpha/create/projects" />);
    // Every copy of the settings panel (the wide inspector and the narrow sheet).
    const titles = () => screen.getAllByLabelText(t.create.titleLabel) as HTMLInputElement[];
    const title = () => ({ disabled: titles().every((x) => x.disabled), enabled: titles().every((x) => !x.disabled) });
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(title().enabled).toBe(true);
    expect(screen.queryByTestId("fs-add")).toBeTruthy();
    fireEvent.click(button());
    await waitFor(() => expect(title().disabled).toBe(true));
    expect(screen.queryByTestId("fs-add")).toBeNull();
    expect(screen.queryByTestId("fs-save")).toBeNull();
    await act(async () => finish({ status: 502, body: { error: "plan_failed", reason: "vendor_error" } }));
    await waitFor(() => expect(title().enabled).toBe(true));
    expect(screen.queryByTestId("fs-add")).toBeTruthy();
  });

  it("with unsaved changes on screen, a plan that finished is never reloaded over them: written, your changes are kept", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let running = true;
    answer = () => (running ? { status: 200, body: { ready: false, plan: { state: "running", expires_at: null } } } : { status: 200, body: { ready: true, turns: { about: 2, at_most: 3 }, left: 20, plan: { state: "done" } } });
    const onWritten = vi.fn(async () => {});
    const props = { t, filmId: FILM, version: 3, canEdit: true, readOnly: false, hasScenes: false, reasonId: "why", onWritten };
    const { rerender } = render(<AiWriter {...props} dirty={false} />);
    await waitFor(() => expect(reason()).toBe(w.writingElsewhere));
    rerender(<AiWriter {...props} dirty />);
    running = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(AI_WAIT_POLL_MS + 10); });
    await waitFor(() => expect(screen.getByTestId("fs-ai-notice").textContent).toBe(w.writtenKept));
    expect(onWritten).not.toHaveBeenCalled();
  });

  it.each([
    ["the POST is lost (a network error)", () => Promise.reject(new TypeError("network"))],
    ["the proxy answers 504 with its own HTML page", () => ({ status: 504, body: "<html><body>504 Gateway Time-out</body></html>" })],
  ])("%s: confirmed through GET (running, then the project has scenes), never sent again, read once", async (_n, lost) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let gets = 0;
    answer = (url, method) => {
      if (method === "POST") return lost() as Answer;
      gets += 1;
      if (gets === 1) return { status: 200, body: READY };
      return gets === 2 ? { status: 200, body: { ready: false, plan: { state: "running", expires_at: null } } } : { status: 409, body: { error: "film_has_scenes", scenes: 9 } };
    };
    const onWritten = writer();
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(reason()).toBe(w.confirming));
    expect(button().disabled).toBe(true);
    expect(screen.getByTestId("fs-ai-progress")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(AI_WAIT_POLL_MS + 10); });
    expect(onWritten).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(AI_WAIT_POLL_MS + 10); });
    await waitFor(() => expect(onWritten).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("fs-ai-notice").textContent).toBe(w.doneConfirmed);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * AI_WAIT_POLL_MS); });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(onWritten).toHaveBeenCalledTimes(1);
  });

  it("a lost POST whose plan failed is said as a failure with Retry by hand; nothing is sent again by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let gets = 0;
    answer = (url, method) => {
      if (method === "POST") return Promise.reject(new TypeError("network"));
      gets += 1;
      return gets === 1 ? { status: 200, body: READY } : { status: 200, body: { ...READY, plan: { state: "failed", reason: "vendor_error", expires_at: null } } };
    };
    const onWritten = writer();
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(reason()).toBe(w.confirming));
    await act(async () => { await vi.advanceTimersByTimeAsync(AI_WAIT_POLL_MS + 10); });
    await waitFor(() => expect(screen.getByTestId("fs-ai-notice").textContent).toBe(w.planFailed));
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(button().textContent).toBe(w.retry);
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * AI_WAIT_POLL_MS); });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(onWritten).not.toHaveBeenCalled();
  });

  it("a 503 with retry_session: the next press sends that conversation back as `session`", async () => {
    let posts = 0;
    answer = (url, method) => {
      if (method !== "POST") return { status: 200, body: READY };
      posts += 1;
      return posts === 1 ? { status: 503, body: { error: "unavailable", retry_session: "aaaaaaaa-0000-4000-8000-000000000009" } }
        : { status: 200, body: { film: { id: FILM, version: 4 }, scenes: 3, seconds: 180 } };
    };
    writer();
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("fs-ai-notice").textContent).toBe(w.unavailable));
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ film: FILM }, { film: FILM, session: "aaaaaaaa-0000-4000-8000-000000000009" }]);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("an answer without the length says how many scenes, never 0:00", async () => {
    answer = (url, method) => (method === "POST" ? { status: 200, body: { film: { id: FILM, version: 4 }, scenes: 4 } } : { status: 200, body: READY });
    writer();
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("fs-ai-notice").textContent).toBe(fmt(w.doneNoLength, { n: 4 })));
    expect(screen.getByTestId("fs-ai-notice").textContent).not.toContain("0:00");
  });

  it("only the latest GET sets what the button says: an older answer arriving late is dropped", async () => {
    let releaseFirst: (v: { status: number; body: unknown }) => void = () => {};
    let n = 0;
    answer = () => {
      n += 1;
      return n === 1 ? new Promise((r) => { releaseFirst = r; }) : { status: 200, body: READY };
    };
    const onWritten = vi.fn(async () => {});
    const props = { t, filmId: FILM, canEdit: true, readOnly: false, hasScenes: false, dirty: false, reasonId: "why", onWritten };
    const { rerender } = render(<AiWriter {...props} version={3} />);
    rerender(<AiWriter {...props} version={4} />);
    await waitFor(() => expect(button().disabled).toBe(false));
    await act(async () => releaseFirst({ status: 404, body: { error: "not_found" } }));
    expect(reason()).not.toBe(w.off);
    expect(button().disabled).toBe(false);
  });
});

describe("refusal coverage (Lens L3): every code the routes send, its words and whether a retry can change it", () => {
  it.each([
    ["source_too_long", 422, { error: "source_too_long", limit: 40000 }, fmt(w.sourceTooLong, { limit: 40000 }), false],
    ["title_claims_vendor", 422, { error: "title_claims_vendor" }, w.titleClaimsVendor, false],
    ["film_conversation", 409, { error: "film_conversation" }, w.filmConversation, false],
    ["film_channel_missing", 409, { error: "film_channel_missing" }, w.filmChannelMissing, false],
    ["session_closed", 409, { error: "session_closed" }, w.planFailed, true],
    ["nothing_to_retry", 409, { error: "nothing_to_retry" }, w.planFailed, true],
    ["message_too_long", 400, { error: "message_too_long" }, w.supportError, false],
    ["invalid_params", 400, { error: "invalid_params" }, w.supportError, false],
    ["plan_over_cap without left", 429, { error: "plan_over_cap", needed: 7 }, fmt(w.overCapNoLeft, { most: 7 }), false],
    ["the person's plan_over_cap without left", 429, { error: "plan_over_cap", needed: 7, scope: "person" }, fmt(w.overCapPersonNoLeft, { most: 7 }), false],
    ["plan_over_cap with left 0", 429, { error: "plan_over_cap", needed: 7, left: 0 }, fmt(w.overCap, { most: 7, left: 0 }), false],
  ])("%s", (_n, status, body, text, retry) => {
    expect(refusalText(w, status, body)).toEqual({ text, retry });
  });

  it("a plan_over_cap without `left` is never drawn as 0", () => {
    expect(refusalText(w, 429, { error: "plan_over_cap", needed: 7 }).text).not.toMatch(/\b0\b/);
  });
});

describe("plan_superseded says what was used, by the server's stage and count (rule 5)", () => {
  it.each([
    ["before any turn", { stage: "before_turns", used: 0 }, w.supersededBefore],
    ["after 4 turns", { stage: "after_turns", used: 4 }, fmt(w.supersededAfter, { n: 4 })],
    ["after turns it could not count", { stage: "after_turns", used: null }, w.supersededAfterUnknown],
  ])("%s: its own words, and Reload is offered", async (_n, extra, text) => {
    answer = (url, method) => (method === "POST" ? { status: 409, body: { error: "plan_superseded", film_id: FILM, ...extra } } : { status: 200, body: READY });
    const onWritten = writer();
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByTestId("fs-ai-notice").textContent).toBe(text));
    expect(screen.getByTestId("fs-ai-reload")).toBeTruthy();
    expect(onWritten).not.toHaveBeenCalled();
  });

  it.each([["en", t], ["ru", filmStudioRu], ["uz", filmStudioUz]] as const)("%s: nothing used is never said as a count, and null reads as unknown", (_l, d) => {
    const a = d.canvas.ai;
    expect(refusalText(a, 409, { error: "plan_superseded", stage: "before_turns", used: 0 }).text).toBe(a.supersededBefore);
    expect(refusalText(a, 409, { error: "plan_superseded", stage: "after_turns", used: 7 }).text).toContain("7");
    const unknown = refusalText(a, 409, { error: "plan_superseded", stage: "after_turns", used: null }).text;
    expect(unknown).toBe(a.supersededAfterUnknown);
    expect(unknown).not.toMatch(/\d/);
    expect(unknown).toMatch(/unknown|неизвестно|nomaʼlum/);
  });
});
