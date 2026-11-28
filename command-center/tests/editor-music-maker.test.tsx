// @vitest-environment jsdom
/**
 * "Make music" in the editor (components/editor/MusicMaker.tsx, mounted by TimelineEditor), against a faked fetch and fake timers.
 *
 * What would break without these, one by one: a "Make music" key (or a disabled one, or a note) shown while no music model is sold
 * here, which is the case today (Lyria 3.5 is unpriced, terms-gated and on a plan-tier entitlement); the key NOT appearing once the
 * Studio's own list sells one; a duration, lyrics, seed, negative-prompt or loop control the backend refuses for music (0228) or the
 * model has no field for; a price drawn before the database quoted one; a refusal shown as one vague sentence instead of the
 * composer's words for it; a job created without a person's confirm, or with a ceiling that is not the quoted price; the finished
 * track placed anywhere but at the playhead, as anything but music, or past the editor's sound limit; a failed job that adds
 * something anyway or does not say why; a made-up percentage while it works; Escape or close leaving focus nowhere; and the
 * three languages drifting, or Uzbek written with a typewriter apostrophe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/editor/p",
  notFound: () => {
    throw new Error("notFound");
  },
}));

// The editor's server page, with its server-side reads faked: only to see what it loads the music list with, and passes on.
const server = vi.hoisted(() => ({
  loadStudioModels: vi.fn<(org: string | null) => Promise<unknown[]>>(async () => []),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<Record<string, unknown>>()), isSupabaseConfigured: true }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: "0a000000-0000-4000-8000-00000000000a" } }) }));
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => ({ id: "u1" }), createClient: async () => null }));
vi.mock("@/lib/i18n/server", async () => {
  const { dictionaries: d } = await import("@/lib/i18n");
  return { getDictionary: async () => ({ t: d.en, locale: "en" }) };
});
vi.mock("@/lib/creative/registry", () => ({ loadSellableModels: async () => ({ status: "ok", models: [] }) }));
vi.mock("@/lib/server/ai-tools", () => ({ loadAiToolAvailability: async () => [], loadImproveModels: async () => [] }));
vi.mock("@/lib/server/creative", () => ({ loadStudioModels: server.loadStudioModels }));
vi.mock("@/lib/server/editor", () => ({
  loadEditorVideos: async () => ({ state: "ok", value: [] }),
  loadEditorSounds: async () => ({ state: "ok", value: [] }),
  loadEditorImages: async () => ({ state: "ok", value: [] }),
  loadEditorProject: async (id: string) => ({
    state: "ok",
    value: { id, title: "Trip", rev: 1, doc: { tracks: [] }, exports: [], assets: {}, orgId: "0e000000-0000-4000-8000-0000000000e0", multiRatio: false, hires: false },
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, fmt, type Locale } from "@/lib/i18n";
import { MusicMaker, musicModelsFrom, musicParams } from "@/components/editor/MusicMaker";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { MAX_EDITOR_SOUNDS, addSound, newDocForAsset, toDoc, toModel, validateTimeline, type EditorAsset, type TimelineDoc } from "@/lib/editor";
import { apiErrorMessage, failureReason, type StudioModel } from "@/lib/creative/studio";
import { resetCreditsLive } from "@/lib/credits-live";
import EditorProjectPage from "@/app/(app)/[channel]/editor/[id]/page";
import { Children, isValidElement, type ReactElement } from "react";

const LOCALES: Locale[] = ["en", "ru", "uz"];
const en = dictionaries.en;
const tm = (l: Locale = "en") => dictionaries[l].editorMusic;
const ORG = "0a000000-0000-4000-8000-00000000000a";
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VID = "11111111-1111-4111-8111-111111111111";
const JOB = "0b000000-0000-4000-8000-00000000000b";
const TRACK = "0d000000-0000-4000-8000-00000000000d";

const VIDEO: EditorAsset = { id: VID, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };
const LYRIA: StudioModel = { id: "google-lyria-3.5", displayName: "Lyria 3.5", capabilities: ["music"], beta: false };
const OTHER_MUSIC: StudioModel = { id: "acme-music-1", displayName: "Acme Music", capabilities: ["music"], beta: false };
const UPSCALER: StudioModel = { id: "acme-upscale", displayName: "Acme Upscale", capabilities: ["upscale"], beta: false };

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const jobRow = (status: string, extra: Record<string, unknown> = {}) => ({
  id: JOB,
  capability: "music",
  status,
  requested_model: LYRIA.id,
  params: { prompt: "calm piano" },
  quoted_credits: 12,
  charged_credits: null,
  error_code: null,
  result: null,
  result_asset_ids: [],
  created_at: "2026-11-28T10:00:00Z",
  ...extra,
});

let fetchMock: ReturnType<typeof vi.fn>;
let quoteAnswer: () => Promise<Response>;
let jobAnswers: Array<() => Promise<Response>>;

beforeEach(() => {
  window.sessionStorage.clear();
  vi.useFakeTimers();
  // jsdom has no media playback; the editor's preview only needs the calls to exist.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  resetCreditsLive();
  quoteAnswer = () => json({ quote: { credits: 12 } });
  jobAnswers = [() => json({ job: jobRow("running") }), () => json({ job: jobRow("completed", { result_asset_ids: [TRACK] }) })];
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === "/api/creative/quote") return quoteAnswer();
    if (u === "/api/creative/jobs" && init?.method === "POST") return json({ job: jobRow("queued") }, 201);
    if (u === `/api/creative/jobs/${JOB}`) return (jobAnswers.shift() ?? (() => json({ job: jobRow("running") })))();
    if (u === `/api/media/${TRACK}`)
      return json({ asset: { id: TRACK, kind: "audio", mime: "audio/mpeg", name: "Calm piano", durationS: 30 }, urls: {} });
    if (u.endsWith(`/api/editor/projects/${PID}`) && init?.method === "PUT") return json({ id: PID, rev: 2 });
    return json({ error: "failed" }, 502);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const withI18n = (ui: ReactNode, locale: Locale = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const calls = (pred: (url: string, init?: RequestInit) => boolean) =>
  fetchMock.mock.calls.filter(([u, i]) => pred(String(u), i as RequestInit | undefined));
const quoteCalls = () => calls((u) => u === "/api/creative/quote");
const createCalls = () => calls((u, i) => u === "/api/creative/jobs" && i?.method === "POST");
const bodyOf = (c: unknown[]) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>;

function mountPanel(over: Partial<React.ComponentProps<typeof MusicMaker>> = {}, locale: Locale = "en") {
  const props = { orgId: ORG, projectId: PID, models: [LYRIA], canAdd: true, position: vi.fn(() => 2), onAdd: vi.fn<(a: EditorAsset, at: number) => boolean>(() => true), onClose: vi.fn(), ...over };
  render(withI18n(<MusicMaker {...props} />, locale));
  return props;
}
async function describeMusic(words = "calm piano") {
  fireEvent.change(screen.getByLabelText(tm().promptLabel), { target: { value: words } });
  await advance(450);
}
const makeKey = () => screen.getByTestId("music-make") as HTMLButtonElement;
const why = () => screen.getByTestId("music-why").textContent ?? "";

// =================================================================================================================================
describe("the visibility rule: the key exists only while the Studio's list sells a music model here", () => {
  const doc = (): TimelineDoc => toDoc(toModel(newDocForAsset(VIDEO)!));
  const editor = (musicModels: readonly StudioModel[] | undefined) =>
    withI18n(<TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc()} exports={[]} assets={{ [VID]: VIDEO }} videos={[VIDEO]} soundFiles={[]} orgId={ORG} aiModels={[UPSCALER]} musicModels={musicModels} />);
  // React's generated ids differ between two mounts; everything else must be the same markup.
  const markup = (musicModels: readonly StudioModel[] | undefined) => {
    const { container, unmount } = render(editor(musicModels));
    const html = container.innerHTML.replace(/[:«]r[0-9a-z]+[:»]/g, "~id~");
    unmount();
    return html;
  };

  it("no sellable music model (today): no Make music key, and an unsellable music model changes nothing at all", () => {
    for (const models of [undefined, [], [UPSCALER], [{ ...LYRIA, lock: "not_on_sale" as const }, UPSCALER]]) {
      render(editor(models));
      expect(screen.queryByRole("button", { name: tm().open })).toBeNull();
      expect(screen.queryByTestId("music-maker")).toBeNull();
      cleanup();
    }
    // A music model nobody can buy changes nothing at all: no key, no disabled key, no note.
    expect(markup([{ ...LYRIA, lock: "not_on_sale" }, UPSCALER])).toBe(markup(undefined));
    expect(quoteCalls()).toHaveLength(0);
  });

  it("a sellable music model in the same list: the key appears next to Add sound and opens a labelled panel", () => {
    render(editor([UPSCALER, LYRIA]));
    const open = screen.getByRole("button", { name: tm().open });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(open);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: tm().title })).toBeTruthy();
  });

  it("musicModelsFrom keeps a lock a person can lift (first purchase, age) and drops one nobody can", () => {
    expect(musicModelsFrom(null)).toEqual([]);
    expect(musicModelsFrom([UPSCALER])).toEqual([]);
    expect(musicModelsFrom([{ ...LYRIA, lock: "not_on_sale" }])).toEqual([]);
    expect(musicModelsFrom([{ ...LYRIA, lock: "adult_only" }]).map((m) => m.id)).toEqual([LYRIA.id]);
    expect(musicModelsFrom([{ ...LYRIA, lock: "first_purchase" }, UPSCALER]).map((m) => m.id)).toEqual([LYRIA.id]);
  });
});

// =================================================================================================================================
describe("the request: words only, exactly what 0228 accepts for music", () => {
  it("has no duration, lyrics, seed, negative prompt or loop control: one text box and nothing else to set", () => {
    mountPanel();
    const panel = screen.getByTestId("music-maker");
    expect(panel.querySelectorAll("textarea")).toHaveLength(1);
    expect(panel.querySelectorAll("input")).toHaveLength(0);
    expect(panel.querySelectorAll("select")).toHaveLength(0);
    expect(panel.textContent ?? "").not.toMatch(/duration|seconds|seed|negative|loop/i);
    expect(within(panel).queryByRole("slider")).toBeNull();
    expect(within(panel).queryByRole("checkbox")).toBeNull();
  });

  it("one model is named, not offered as a picker of one; two are a labelled picker", () => {
    mountPanel();
    expect(screen.getByTestId("music-model").textContent).toBe(fmt(tm().madeWith, { model: "Lyria 3.5" }));
    expect(screen.queryByRole("combobox")).toBeNull();
    cleanup();
    mountPanel({ models: [LYRIA, OTHER_MUSIC] });
    expect(screen.getByRole("combobox", { name: tm().model })).toBeTruthy();
  });

  it("the quote asks for music with the words alone, trimmed, and names the model", async () => {
    expect(musicParams("  calm piano \n")).toEqual({ prompt: "calm piano" });
    mountPanel();
    await describeMusic("  calm piano ");
    expect(quoteCalls()).toHaveLength(1);
    expect(bodyOf(quoteCalls()[0])).toEqual({ org_id: ORG, capability: "music", model: LYRIA.id, params: { prompt: "calm piano" } });
  });

  it("says under the words where they go, linking the privacy and terms sections, with SynthID for Lyria", () => {
    mountPanel();
    const line = screen.getByTestId("music-disclosure");
    expect(line.textContent).toContain(tm().synthId);
    expect(within(line).getByRole("link", { name: en.legal.privacy }).getAttribute("href")).toBe("/privacy#processors");
    expect(within(line).getByRole("link", { name: en.legal.terms }).getAttribute("href")).toBe("/terms#third-parties");
    cleanup();
    mountPanel({ models: [OTHER_MUSIC] });
    expect(screen.getByTestId("music-disclosure").textContent).not.toContain("SynthID");
  });
});

// =================================================================================================================================
describe("the price: only the database's quote, and the key disabled with its reason", () => {
  it("draws no number before the quote, and no quote before words", async () => {
    let release: (r: Response) => void = () => {};
    quoteAnswer = () => new Promise<Response>((r) => (release = r));
    mountPanel();
    expect(makeKey().disabled).toBe(true);
    expect(why()).toBe(tm().needWords);
    expect(quoteCalls()).toHaveLength(0);
    await describeMusic();
    expect(makeKey().disabled).toBe(true);
    expect(makeKey().textContent).toBe(tm().make);
    expect(makeKey().textContent).not.toMatch(/\d/);
    await act(async () => release(new Response(JSON.stringify({ quote: { credits: 12 } }), { status: 200 })));
    expect(makeKey().textContent).toBe(fmt(tm().makePriced, { n: "12" }));
    expect(makeKey().disabled).toBe(false);
  });

  it.each([
    ["unpriced", 422],
    ["invalid_params", 400],
    ["country_blocked", 451],
    ["country_unverified", 451],
    ["adult_attestation_required", 403],
    ["insufficient_credits", 402],
    ["prompt_too_long", 400],
  ])("a %s refusal reads the composer's own words, and the key stays disabled with no price", async (code, status) => {
    quoteAnswer = () => json({ error: code }, status);
    mountPanel();
    await describeMusic();
    expect(makeKey().disabled).toBe(true);
    expect(makeKey().textContent).not.toMatch(/\d/);
    expect(screen.getByTestId("music-refused").getAttribute("data-code")).toBe(code);
    expect(why()).toContain(apiErrorMessage(en, code));
  });

  it("a model this workspace cannot buy yet is not priced: its lock is named (first purchase, adult only)", async () => {
    for (const lock of ["first_purchase", "adult_only"] as const) {
      mountPanel({ models: [{ ...LYRIA, lock }] });
      await describeMusic();
      expect(quoteCalls()).toHaveLength(0);
      expect(makeKey().disabled).toBe(true);
      expect(screen.getByTestId("music-locked").getAttribute("data-lock")).toBe(lock);
      expect(why()).toContain(en.gen.lockWhy[lock]);
      cleanup();
    }
  });

  it("an entitlement refusal from the quote is named by its reason, like the composer", async () => {
    quoteAnswer = () => json({ error: "entitlement_required" }, 403);
    mountPanel({ models: [{ ...LYRIA, entitlement: "paid" }] });
    await describeMusic();
    expect(why()).toContain(en.gen.lockWhy.first_purchase);
  });

  it("a model that went away mid-flow stops the panel and offers nothing in its place", async () => {
    quoteAnswer = () => json({ error: "model_not_sellable" }, 422);
    mountPanel();
    await describeMusic();
    expect(makeKey().disabled).toBe(true);
    expect(why()).toContain(apiErrorMessage(en, "model_not_sellable"));
    expect(why()).toContain(tm().noSubstitute);
    // Stopped: no price, no confirm, no other model offered in its place.
    fireEvent.click(makeKey());
    expect(screen.queryByTestId("music-confirm")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByTestId("music-model").textContent).toBe(fmt(tm().madeWith, { model: "Lyria 3.5" }));
  });

  it("a picked model that leaves the list is not replaced by another: the panel stops and the open confirm is dropped", async () => {
    const props = { orgId: ORG, projectId: PID, canAdd: true, position: () => 0, onAdd: vi.fn(() => true), onClose: vi.fn() };
    const view = render(withI18n(<MusicMaker {...props} models={[LYRIA, OTHER_MUSIC]} />));
    await describeMusic();
    fireEvent.click(makeKey());
    expect(screen.getByTestId("music-confirm")).toBeTruthy();
    view.rerender(withI18n(<MusicMaker {...props} models={[OTHER_MUSIC]} />));
    await advance(450);
    expect(screen.queryByTestId("music-confirm")).toBeNull();
    expect(makeKey().disabled).toBe(true);
    expect(screen.getByTestId("music-gone").textContent).toContain(tm().noSubstitute);
    expect(quoteCalls().every((c) => bodyOf(c).model === LYRIA.id)).toBe(true);
    expect(createCalls()).toHaveLength(0);
  });

  it("no room on the timeline: the key is disabled and says so, before anything is spent", async () => {
    mountPanel({ canAdd: false });
    await describeMusic();
    expect(makeKey().disabled).toBe(true);
    expect(why()).toBe(tm().full);
  });
});

// =================================================================================================================================
describe("confirm, create, and the job", () => {
  it("the first press only asks; the confirm creates one job with max_credits equal to the quote", async () => {
    mountPanel();
    await describeMusic();
    fireEvent.click(makeKey());
    expect(createCalls()).toHaveLength(0);
    expect(screen.getByTestId("music-confirm").textContent).toContain(fmt(tm().confirm, { n: "12" }));
    fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
    await advance(0);
    expect(createCalls()).toHaveLength(1);
    const body = bodyOf(createCalls()[0]);
    expect(body).toMatchObject({ org_id: ORG, capability: "music", model: LYRIA.id, params: { prompt: "calm piano" }, max_credits: 12 });
    expect(typeof body.idempotency_key).toBe("string");
    expect(Object.keys(body).sort()).toEqual(["capability", "idempotency_key", "max_credits", "model", "org_id", "params"]);
  });

  it("a double press on the confirm creates one job", async () => {
    mountPanel();
    await describeMusic();
    fireEvent.click(makeKey());
    const go = screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) });
    fireEvent.click(go);
    fireEvent.click(go);
    await advance(0);
    expect(createCalls()).toHaveLength(1);
  });

  it("a create whose answer is lost (5xx) is retried with the SAME idempotency key; new words get a new one", async () => {
    let answer: () => Promise<Response> = () => json({ error: "failed" }, 502);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/creative/quote") return json({ quote: { credits: 12 } });
      if (u === "/api/creative/jobs" && init?.method === "POST") return answer();
      return json({ error: "failed" }, 502);
    });
    const press = async () => {
      fireEvent.click(makeKey());
      fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
      await advance(0);
    };
    mountPanel();
    await describeMusic();
    await press();
    answer = () => Promise.reject(new TypeError("offline"));
    await press();
    const keys = createCalls().map((c) => bodyOf(c).idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    answer = () => json({ error: "failed" }, 502);
    await describeMusic("calm piano and strings");
    await press();
    expect(bodyOf(createCalls()[2]).idempotency_key).not.toBe(keys[0]);
  });

  it("a definitive refusal (4xx) lets the next press use a new key", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/creative/quote") return json({ quote: { credits: 12 } });
      if (u === "/api/creative/jobs" && init?.method === "POST") return json({ error: "insufficient_credits" }, 402);
      return json({ error: "failed" }, 502);
    });
    mountPanel();
    await describeMusic();
    for (let i = 0; i < 2; i++) {
      fireEvent.click(makeKey());
      fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
      await advance(0);
    }
    const keys = createCalls().map((c) => bodyOf(c).idempotency_key);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("Back drops the confirm, and changing the words drops it too (a new price needs a new yes)", async () => {
    mountPanel();
    await describeMusic();
    fireEvent.click(makeKey());
    fireEvent.click(screen.getByRole("button", { name: tm().back }));
    expect(screen.queryByTestId("music-confirm")).toBeNull();
    fireEvent.click(makeKey());
    await describeMusic("calm piano and strings");
    expect(screen.queryByTestId("music-confirm")).toBeNull();
    expect(createCalls()).toHaveLength(0);
  });

  it("while it works: elapsed time, never a percentage; then the library's audio file is handed over, and the panel closes", async () => {
    const p = mountPanel();
    await describeMusic();
    fireEvent.click(makeKey());
    fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
    await advance(0);
    expect(screen.getByTestId("music-status").textContent).toBe(tm().working);
    await advance(3000); // first read: still running
    expect(screen.getByTestId("music-elapsed").textContent).toBe(fmt(tm().elapsed, { now: "0:03" }));
    expect(screen.getByTestId("music-maker").textContent ?? "").not.toMatch(/%/);
    expect(p.onAdd).not.toHaveBeenCalled();
    await advance(3000); // second read: completed
    expect(p.onAdd).toHaveBeenCalledTimes(1);
    expect(p.onAdd).toHaveBeenCalledWith({ id: TRACK, kind: "audio", name: "Calm piano", durationS: 30, width: null, height: null, viewUrl: null, thumbUrl: null }, 2);
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it("a finished file the library does not hold as audio is not placed", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/creative/quote") return json({ quote: { credits: 12 } });
      if (u === "/api/creative/jobs" && init?.method === "POST") return json({ job: jobRow("queued") }, 201);
      if (u === `/api/creative/jobs/${JOB}`) return json({ job: jobRow("completed", { result_asset_ids: [TRACK] }) });
      if (u === `/api/media/${TRACK}`) return json({ asset: { id: TRACK, kind: "video", mime: "video/mp4", durationS: 30 }, urls: {} });
      return json({ error: "failed" }, 502);
    });
    const p = mountPanel();
    await describeMusic();
    fireEvent.click(makeKey());
    fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
    await advance(0); // the create answers; the job is then read every 3 s
    await advance(3100);
    expect(p.onAdd).not.toHaveBeenCalled();
    expect(screen.getByTestId("music-error").textContent).toContain(tm().unreadable);
  });

  it("a failed job adds nothing and says what happened and what to do", async () => {
    jobAnswers = [() => json({ job: jobRow("failed", { error_code: "policy" }) })];
    const p = mountPanel();
    await describeMusic();
    fireEvent.click(makeKey());
    fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
    await advance(0); // the create answers; the job is then read every 3 s
    await advance(3100);
    expect(p.onAdd).not.toHaveBeenCalled();
    expect(p.onClose).not.toHaveBeenCalled();
    const alert = screen.getByTestId("music-error");
    expect(alert.textContent).toContain(tm().failed);
    expect(alert.textContent).toContain(failureReason(en, { status: "failed", error_code: "policy" }));
    expect(calls((u) => u.startsWith("/api/media/"))).toHaveLength(0);
  });

  it("a timeline that filled up while it worked: nothing is placed, it says so, and Add it now places it once there is room", async () => {
    const onAdd = vi.fn<(a: EditorAsset, at: number) => boolean>(() => false);
    const props = { orgId: ORG, projectId: PID, models: [LYRIA], position: () => 2, onAdd, onClose: vi.fn() };
    const view = render(withI18n(<MusicMaker {...props} canAdd />));
    await describeMusic();
    fireEvent.click(makeKey());
    fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
    await advance(0); // the create answers; the job is then read every 3 s
    await advance(6100);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("music-error").textContent).toContain(tm().fullAfter);
    view.rerender(withI18n(<MusicMaker {...props} canAdd={false} />));
    expect((screen.getByTestId("music-add-now") as HTMLButtonElement).disabled).toBe(true);
    onAdd.mockImplementation(() => true);
    view.rerender(withI18n(<MusicMaker {...props} canAdd />));
    fireEvent.click(screen.getByTestId("music-add-now"));
    expect(onAdd).toHaveBeenLastCalledWith(expect.objectContaining({ id: TRACK }), 2);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(`nightshift:editor-music:${PID}`)).toBeNull();
  });

  it("closed while the finished file is being read: nothing is placed and nothing closes, and the job is kept for the next open", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/creative/quote") return json({ quote: { credits: 12 } });
      if (u === "/api/creative/jobs" && init?.method === "POST") return json({ job: jobRow("queued") }, 201);
      if (u === `/api/creative/jobs/${JOB}`) return json({ job: jobRow("completed", { result_asset_ids: [TRACK] }) });
      if (u === `/api/media/${TRACK}`) return new Promise<Response>((r) => (release = r));
      return json({ error: "failed" }, 502);
    });
    const props = { orgId: ORG, projectId: PID, models: [LYRIA], canAdd: true, position: () => 2, onAdd: vi.fn(() => true), onClose: vi.fn() };
    const view = render(withI18n(<MusicMaker {...props} />));
    await describeMusic();
    fireEvent.click(makeKey());
    fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
    await advance(0);
    await advance(3000);
    expect(screen.getByTestId("music-status").textContent).toBe(tm().reading);
    view.unmount();
    await act(async () =>
      release(new Response(JSON.stringify({ asset: { id: TRACK, kind: "audio", mime: "audio/mpeg", name: "x", durationS: 30 }, urls: {} }), { status: 200 })),
    );
    await advance(10);
    expect(props.onAdd).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(JSON.parse(window.sessionStorage.getItem(`nightshift:editor-music:${PID}`)!)).toMatchObject({ jobId: JOB, at: 2 });
  });

  it.each([401, 403])("a %i on a job read stops asking at once and says to sign in again", async (status) => {
    jobAnswers = [() => json({ error: "unauthorized" }, status)];
    const p = mountPanel();
    await describeMusic();
    fireEvent.click(makeKey());
    fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
    await advance(0);
    await advance(3000);
    expect(screen.getByTestId("music-error").getAttribute("data-state")).toBe("signedOut");
    expect(screen.getByTestId("music-error").textContent).toContain(tm().signedOut);
    const reads = calls((u) => u === `/api/creative/jobs/${JOB}`).length;
    await advance(30_000);
    expect(calls((u) => u === `/api/creative/jobs/${JOB}`).length).toBe(reads);
    expect(p.onAdd).not.toHaveBeenCalled();
  });

  it("job reads that keep failing (a 5xx, no network) stop after a bounded run, and say to check the library", async () => {
    jobAnswers = Array.from({ length: 30 }, (_, i) => (i % 2 ? () => json({ error: "failed" }, 502) : () => Promise.reject(new TypeError("offline"))));
    mountPanel();
    await describeMusic();
    fireEvent.click(makeKey());
    fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
    await advance(0);
    await advance(3000 * 10 + 100);
    expect(screen.getByTestId("music-error").getAttribute("data-state")).toBe("stalled");
    expect(screen.getByTestId("music-error").textContent).toContain(tm().stalled);
    const reads = calls((u) => u === `/api/creative/jobs/${JOB}`).length;
    expect(reads).toBe(10);
    await advance(60_000);
    expect(calls((u) => u === `/api/creative/jobs/${JOB}`).length).toBe(reads);
  });

  it("a job still running past the ceiling stops being waited for, and says so", async () => {
    jobAnswers = [];
    window.sessionStorage.setItem(`nightshift:editor-music:${PID}`, JSON.stringify({ jobId: JOB, startedAt: Date.now() - 21 * 60_000, at: 0 }));
    mountPanel();
    await advance(0);
    expect(screen.getByTestId("music-error").getAttribute("data-state")).toBe("stalled");
  });

  it("a refused create says why and keeps the panel open", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/creative/quote") return json({ quote: { credits: 12 } });
      if (u === "/api/creative/jobs" && init?.method === "POST") return json({ error: "insufficient_credits" }, 402);
      return json({ error: "failed" }, 502);
    });
    mountPanel();
    await describeMusic();
    fireEvent.click(makeKey());
    fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
    await advance(0);
    expect(why()).toContain(apiErrorMessage(en, "insufficient_credits"));
    expect(screen.getByRole("link", { name: en.gen.addCredits })).toBeTruthy();
  });
});

// =================================================================================================================================
describe("in the editor page", () => {
  const editor = (doc: TimelineDoc, assets: Record<string, EditorAsset>) =>
    withI18n(<TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]} assets={assets} videos={[VIDEO]} soundFiles={[]} orgId={ORG} musicModels={[LYRIA]} />);

  it("a finished track lands as a music sound where the playhead was at the confirm, and saves as a valid document", async () => {
    render(editor(toDoc(toModel(newDocForAsset(VIDEO)!)), { [VID]: VIDEO }));
    const slider = screen.getByRole("slider", { name: en.editor.playhead });
    fireEvent.change(slider, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: tm().open }));
    await describeMusic();
    fireEvent.click(makeKey());
    fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
    await advance(0); // the create answers; the job is then read every 3 s
    fireEvent.change(slider, { target: { value: "7" } }); // moved while it works: the track still goes where it was asked for
    await advance(6100);
    expect(screen.queryByTestId("music-maker")).toBeNull();
    await advance(10);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: tm().open }));
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: en.editor.save }));
    const isSave = ([u, i]: unknown[]) => String(u).endsWith(`/api/editor/projects/${PID}`) && (i as RequestInit | undefined)?.method === "PUT";
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(isSave)).toBe(true));
    const saved = JSON.parse(String((fetchMock.mock.calls.find(isSave)![1] as RequestInit).body)).doc as TimelineDoc;
    const a = saved.tracks.filter((t) => t.kind === "A");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ role: "music" });
    expect(a[0].clips[0]).toMatchObject({ asset_id: TRACK, start_s: 3, in_s: 0 });
    expect(validateTimeline(saved)).toEqual([]);
  });

  it(`a project already holding ${MAX_EDITOR_SOUNDS} sounds cannot spend on another: the key says the timeline is full`, async () => {
    let m = toModel(newDocForAsset(VIDEO)!);
    const assets: Record<string, EditorAsset> = { [VID]: VIDEO };
    for (let i = 0; i < MAX_EDITOR_SOUNDS; i++) {
      const id = `0f000000-0000-4000-8000-00000000000${i}`;
      const s: EditorAsset = { id, kind: "audio", name: `s${i}`, durationS: 5, width: null, height: null, viewUrl: null, thumbUrl: null };
      assets[id] = s;
      m = addSound(m, s, 0)!.model;
    }
    render(editor(toDoc(m), assets));
    fireEvent.click(screen.getByRole("button", { name: tm().open }));
    await describeMusic();
    expect(makeKey().disabled).toBe(true);
    expect(why()).toBe(tm().full);
  });

  it("closed while the job was being created: the editor still says the music is being made", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/creative/quote") return json({ quote: { credits: 12 } });
      if (u === "/api/creative/jobs" && init?.method === "POST") return new Promise<Response>((r) => (release = r));
      return json({ job: jobRow("running") });
    });
    render(editor(toDoc(toModel(newDocForAsset(VIDEO)!)), { [VID]: VIDEO }));
    fireEvent.click(screen.getByRole("button", { name: tm().open }));
    await describeMusic();
    fireEvent.click(makeKey());
    fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
    fireEvent.click(screen.getByRole("button", { name: tm().close }));
    expect(screen.queryByTestId("music-pending")).toBeNull();
    await act(async () => release(new Response(JSON.stringify({ job: jobRow("queued") }), { status: 201 })));
    await advance(10);
    expect(screen.getByTestId("music-pending").textContent).toContain(tm().pending);
  });

  it("closed mid-job: the editor says the music is still being made, and Show picks it up again", async () => {
    jobAnswers = [() => json({ job: jobRow("running") })];
    render(editor(toDoc(toModel(newDocForAsset(VIDEO)!)), { [VID]: VIDEO }));
    fireEvent.click(screen.getByRole("button", { name: tm().open }));
    await describeMusic();
    fireEvent.click(makeKey());
    fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: tm().close }));
    await advance(10);
    fireEvent.click(within(screen.getByTestId("music-pending")).getByRole("button", { name: tm().pendingShow }));
    await advance(0);
    expect(screen.getByTestId("music-status").textContent).toBe(tm().working);
    expect(createCalls()).toHaveLength(1);
  });

  it("Escape closes the panel and focus returns to Make music; so does the close key", async () => {
    render(editor(toDoc(toModel(newDocForAsset(VIDEO)!)), { [VID]: VIDEO }));
    const open = screen.getByRole("button", { name: tm().open });
    fireEvent.click(open);
    fireEvent.keyDown(screen.getByLabelText(tm().promptLabel), { key: "Escape" });
    expect(screen.queryByTestId("music-maker")).toBeNull();
    await advance(10);
    expect(document.activeElement).toBe(open);
    fireEvent.click(open);
    fireEvent.click(screen.getByRole("button", { name: tm().close }));
    expect(screen.queryByTestId("music-maker")).toBeNull();
    await advance(10);
    expect(document.activeElement).toBe(open);
  });

  it("every key in the panel is a 44 px target", async () => {
    mountPanel();
    await describeMusic();
    fireEvent.click(makeKey());
    for (const b of within(screen.getByTestId("music-maker")).getAllByRole("button")) expect(b.className).toMatch(/min-h-11/);
  });
});

// =================================================================================================================================
describe("the editor page loads the music list for the workspace", () => {
  const PROJECT_ORG = "0e000000-0000-4000-8000-0000000000e0";
  function findEditor(node: unknown): ReactElement<Record<string, unknown>> | null {
    if (!isValidElement(node)) return null;
    const el = node as ReactElement<Record<string, unknown>>;
    if (el.type === TimelineEditor) return el;
    for (const child of Children.toArray(el.props.children as ReactNode)) {
      const hit = findEditor(child);
      if (hit) return hit;
    }
    return null;
  }
  const page = async () =>
    findEditor(await EditorProjectPage({ params: Promise.resolve({ id: PID }), searchParams: Promise.resolve({}) }));

  it("asks the Studio's loader WITH the project's organization (its locks then see the workspace's purchases), and passes music only", async () => {
    server.loadStudioModels.mockResolvedValueOnce([UPSCALER, LYRIA, { ...OTHER_MUSIC, lock: "first_purchase" }]);
    const ed = await page();
    expect(server.loadStudioModels).toHaveBeenCalledWith(PROJECT_ORG);
    expect((ed!.props.musicModels as StudioModel[]).map((m) => m.id)).toEqual([LYRIA.id, OTHER_MUSIC.id]);
    expect((ed!.props.musicModels as StudioModel[])[1].lock).toBe("first_purchase");
  });

  it("a failed read is no music model (the editor stays as it was), never a crash", async () => {
    server.loadStudioModels.mockRejectedValueOnce(new Error("db down"));
    const ed = await page();
    expect(ed!.props.musicModels).toEqual([]);
  });
});

// =================================================================================================================================
describe("a refresh mid-job, and cancel", () => {
  const KEY = `nightshift:editor-music:${PID}`;
  const pend = (project = PID) =>
    window.sessionStorage.setItem(`nightshift:editor-music:${project}`, JSON.stringify({ jobId: JOB, startedAt: Date.now() - 20_000, at: 4 }));
  async function startJob() {
    await describeMusic();
    fireEvent.click(makeKey());
    fireEvent.click(screen.getByRole("button", { name: fmt(tm().confirmGo, { n: "12" }) }));
    await advance(0);
  }

  it("the create records the job for this project only, and the finished track clears it", async () => {
    mountPanel();
    await startJob();
    expect(JSON.parse(window.sessionStorage.getItem(KEY)!)).toMatchObject({ jobId: JOB });
    await advance(6100);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("after a refresh the editor says music is still being made; Show re-adopts the job, adds it on completion, and asks no new price", async () => {
    pend();
    jobAnswers = [() => json({ job: jobRow("running") }), () => json({ job: jobRow("completed", { result_asset_ids: [TRACK] }) })];
    render(
      withI18n(<TimelineEditor projectId={PID} title="Trip" rev={1} doc={toDoc(toModel(newDocForAsset(VIDEO)!))} exports={[]} assets={{ [VID]: VIDEO }} videos={[VIDEO]} soundFiles={[]} orgId={ORG} musicModels={[LYRIA]} />),
    );
    await advance(0);
    const line = screen.getByTestId("music-pending");
    expect(line.textContent).toContain(tm().pending);
    fireEvent.click(within(line).getByRole("button", { name: tm().pendingShow }));
    await advance(0); // read at once: still running
    expect(screen.getByTestId("music-status").textContent).toBe(tm().working);
    expect(screen.getByTestId("music-elapsed").textContent).toBe(fmt(tm().elapsed, { now: "0:20" }));
    await advance(3000); // completed
    await advance(10);
    expect(screen.queryByTestId("music-maker")).toBeNull();
    expect(screen.queryByTestId("music-pending")).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(quoteCalls()).toHaveLength(0);
    expect(createCalls()).toHaveLength(0);
    expect(calls((u) => u === `/api/media/${TRACK}`)).toHaveLength(1);
  });

  it("a pending job the route answers 404 for is dropped, said in words, and nothing is added", async () => {
    pend();
    jobAnswers = [() => json({ error: "not_found" }, 404)];
    const p = mountPanel();
    await advance(0);
    expect(screen.getByTestId("music-error").textContent).toContain(tm().lost);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(p.onAdd).not.toHaveBeenCalled();
  });

  it("another project's pending job is ignored", async () => {
    pend("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    render(
      withI18n(<TimelineEditor projectId={PID} title="Trip" rev={1} doc={toDoc(toModel(newDocForAsset(VIDEO)!))} exports={[]} assets={{ [VID]: VIDEO }} videos={[VIDEO]} soundFiles={[]} orgId={ORG} musicModels={[LYRIA]} />),
    );
    await advance(0);
    expect(screen.queryByTestId("music-pending")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: tm().open }));
    await advance(3100);
    expect(calls((u) => u.startsWith("/api/creative/jobs/"))).toHaveLength(0);
  });

  it("storage that throws breaks nothing: the editor opens, and a track is still made and placed", async () => {
    const boom = () => {
      throw new DOMException("denied", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(boom);
    render(
      withI18n(<TimelineEditor projectId={PID} title="Trip" rev={1} doc={toDoc(toModel(newDocForAsset(VIDEO)!))} exports={[]} assets={{ [VID]: VIDEO }} videos={[VIDEO]} soundFiles={[]} orgId={ORG} musicModels={[LYRIA]} />),
    );
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: tm().open }));
    await startJob();
    await advance(6100);
    await advance(10);
    expect(screen.queryByTestId("music-maker")).toBeNull();
    expect(calls((u) => u === `/api/media/${TRACK}`)).toHaveLength(1);
  });

  it("a queued job can be cancelled through the job route; the hold is released and the entry cleared", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/creative/quote") return json({ quote: { credits: 12 } });
      if (u === "/api/creative/jobs" && init?.method === "POST") return json({ job: jobRow("queued") }, 201);
      if (u === `/api/creative/jobs/${JOB}` && init?.method === "POST") return json({ job: jobRow("cancelled") });
      if (u === `/api/creative/jobs/${JOB}`) return json({ job: jobRow("queued") });
      return json({ error: "failed" }, 502);
    });
    const p = mountPanel();
    await startJob();
    fireEvent.click(screen.getByTestId("music-cancel"));
    await advance(0);
    const posts = calls((u, i) => u === `/api/creative/jobs/${JOB}` && i?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0])).toEqual({ action: "cancel" });
    expect(screen.getByTestId("music-cancelled").textContent).toBe(en.captions.cancelled);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    await advance(6100);
    expect(p.onAdd).not.toHaveBeenCalled();
  });

  it("a job the provider already started is not cancellable: said so, and the wait goes on", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/creative/quote") return json({ quote: { credits: 12 } });
      if (u === "/api/creative/jobs" && init?.method === "POST") return json({ job: jobRow("queued") }, 201);
      if (u === `/api/creative/jobs/${JOB}` && init?.method === "POST") return json({ error: "not_cancellable" }, 409);
      if (u === `/api/creative/jobs/${JOB}`) return json({ job: jobRow("running") });
      return json({ error: "failed" }, 502);
    });
    mountPanel();
    await startJob();
    fireEvent.click(screen.getByTestId("music-cancel"));
    await advance(0);
    expect(screen.getByTestId("music-cancel-note").textContent).toBe(en.captions.notCancellable);
    expect(screen.queryByTestId("music-cancel")).toBeNull();
    expect(screen.getByTestId("music-status").textContent).toBe(tm().working);
  });

  it("a running job offers no cancel key (only a queued one can be stopped)", async () => {
    jobAnswers = [() => json({ job: jobRow("running") })];
    mountPanel();
    await startJob();
    expect(screen.getByTestId("music-cancel")).toBeTruthy();
    await advance(3000);
    expect(screen.queryByTestId("music-cancel")).toBeNull();
  });
});

// =================================================================================================================================
describe("the words", () => {
  it("en, ru and uz have every key, none empty, with the same placeholders", () => {
    const keys = Object.keys(tm("en")).sort();
    for (const l of LOCALES) {
      expect(Object.keys(tm(l)).sort()).toEqual(keys);
      for (const k of keys) {
        const v = (tm(l) as Record<string, string>)[k];
        expect(v.trim(), `${l}.${k}`).not.toBe("");
        const holes = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort();
        expect(holes(v), `${l}.${k}`).toEqual(holes((tm("en") as Record<string, string>)[k]));
      }
    }
  });

  it("Uzbek uses the modifier letters (U+02BB, U+02BC), never a typewriter or curly apostrophe", () => {
    const all = Object.values(tm("uz")).join(" ");
    expect(all).not.toMatch(/['‘’]/);
    expect(all).toMatch(/ʻ/);
    expect(all).toMatch(/ʼ/);
  });

  it("the panel renders in each language without an English leftover", () => {
    for (const l of LOCALES) {
      mountPanel({}, l);
      expect(screen.getByRole("region", { name: tm(l).title })).toBeTruthy();
      expect(screen.getByLabelText(tm(l).promptLabel)).toBeTruthy();
      cleanup();
    }
  });
});
