// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { STUDIO_VOICES, type StudioModel } from "@/lib/creative/studio";

vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/create", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/alpha${p}` }));
vi.mock("@/lib/credits-live", () => ({ useLiveCredits: () => null, refreshCredits: vi.fn() }));
const styleState = vi.hoisted(() => ({ state: "ready" as "ready" | "unavailable" }));
vi.mock("@/components/studio/useStyleKits", () => ({
  useStyleKits: () => ({ state: styleState.state, kits: [{ id: "22222222-2222-4222-8222-222222222222", name: "Channel look" }], reload: vi.fn() }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const LOOK = "22222222-2222-4222-8222-222222222222";
const MODELS: StudioModel[] = [
  { id: "video-a", displayName: "Video A", capabilities: ["t2v"], beta: false, durations: [5] },
  { id: "video-b", displayName: "Video B", capabilities: ["t2v"], beta: false, durations: [5] },
  { id: "image-a", displayName: "Image A", capabilities: ["t2i"], beta: false },
  { id: "voice-a", displayName: "Voice A", capabilities: ["tts"], beta: false },
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let quoteAnswer: () => Response | Promise<Response>;
let fetcher: ReturnType<typeof vi.fn>;
const jobs = () => fetcher.mock.calls.filter(([url, init]) => url === "/api/creative/jobs" && init?.method === "POST");
const summary = () => screen.getByTestId("gen-review");
const value = (label: string) => within(summary()).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

beforeEach(() => {
  styleState.state = "ready";
  quoteAnswer = () => json({ quote: { credits: 7.5, routed_model: "video-b" } });
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/creative/quote") return quoteAnswer();
    if (url === "/api/creative/jobs" && init?.method === "POST") return json({ job: { id: "synthetic-job" } });
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetcher);
  window.localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("reviews effective snapped duration and inherited look beside the panel Generate without starting a job", async () => {
  render(<I18nProvider locale="en"><GeneratePanel orgId={ORG} models={MODELS} defaultStyleKitId={LOOK}
    initial={{ capability: "t2v", prompt: "A scene", model: "video-a", duration: 15, aspect: "16:9" }} /></I18nProvider>);
  await waitFor(() => expect(summary().dataset.state).toBe("ready"));
  expect(value(dictionaries.en.gen.modelLabel)).toBe("Video A");
  expect(value(dictionaries.en.gen.review.duration)).toBe("5 s");
  expect(value(dictionaries.en.gen.styleLabel)).toBe("Channel look");
  expect(value(dictionaries.en.gen.review.credits)).toContain("7.5");
  expect(within(summary()).queryByText(dictionaries.en.gen.review.voice, { selector: "dt" })).toBeNull();
  expect(within(summary()).queryByRole("button")).toBeNull();
  expect(jobs()).toHaveLength(0);
});

it.each(["panel", "composer"] as const)("omits unavailable style kits from the %s summary and priced params", async (layout) => {
  styleState.state = "unavailable";
  render(<I18nProvider locale="en"><GeneratePanel orgId={ORG} models={MODELS} layout={layout} defaultStyleKitId={LOOK}
    initial={{ capability: "t2v", prompt: "A scene", model: "video-a", duration: 5, aspect: "16:9" }} /></I18nProvider>);
  await waitFor(() => expect(summary().dataset.state).toBe("ready"));
  expect(screen.queryByText(dictionaries.en.gen.styleLabel)).toBeNull();
  expect(screen.queryByRole("group", { name: dictionaries.en.gen.styleLabel })).toBeNull();
  const quote = fetcher.mock.calls.filter(([url]) => url === "/api/creative/quote").at(-1);
  expect(quote).toBeTruthy();
  expect(JSON.parse(String(quote![1]?.body)).params).not.toHaveProperty("style_kit_id");
  expect(jobs()).toHaveLength(0);
});

it("reviews a preset voice ahead of the channel default, without inventing a duration for speech", async () => {
  const voice = STUDIO_VOICES[0];
  render(<I18nProvider locale="en"><GeneratePanel orgId={ORG} models={MODELS}
    dna={{ aspect: "16:9", voiceId: STUDIO_VOICES[1].id, href: "/alpha/channels" }}
    initial={{ capability: "tts", prompt: "Synthetic speech", voiceId: voice.id, model: "voice-a", aspect: "16:9", duration: 5 }} /></I18nProvider>);
  await waitFor(() => expect(summary().dataset.state).toBe("ready"));
  expect(value(dictionaries.en.gen.review.voice)).toBe(voice.name);
  expect(within(summary()).queryByText(dictionaries.en.gen.review.duration, { selector: "dt" })).toBeNull();
  expect(jobs()).toHaveLength(0);
});

it("waits for Auto's quoted model instead of displaying the hand-picked fallback", async () => {
  let finish!: (r: Response) => void;
  quoteAnswer = () => new Promise<Response>((resolve) => { finish = resolve; });
  render(<I18nProvider locale="en"><GeneratePanel orgId={ORG} models={MODELS}
    initial={{ capability: "t2v", prompt: "A scene", auto: true, duration: 5, model: "", aspect: "16:9" }} /></I18nProvider>);
  expect(value(dictionaries.en.gen.modelLabel)).toBe(dictionaries.en.gen.review.awaitingModel);
  expect(value(dictionaries.en.gen.review.credits)).toBe(dictionaries.en.gen.review.updating);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  finish(json({ quote: { credits: 12, routed_model: "video-b" } }));
  await waitFor(() => expect(summary().dataset.state).toBe("ready"));
  expect(value(dictionaries.en.gen.modelLabel)).toBe("Video B");
  expect(value(dictionaries.en.gen.review.credits)).toContain("12");
  expect(jobs()).toHaveLength(0);
});

it("shows unavailable pricing and unapplied look honestly, without a zero-credit fallback", async () => {
  quoteAnswer = () => json({ error: "unpriced" }, 409);
  render(<I18nProvider locale="en"><GeneratePanel orgId={ORG} models={MODELS}
    defaultStyleKitId="33333333-3333-4333-8333-333333333333"
    initial={{ capability: "t2i", prompt: "A scene", model: "image-a", aspect: "16:9", duration: 5 }} /></I18nProvider>);
  await waitFor(() => expect(summary().dataset.state).toBe("unavailable"));
  expect(value(dictionaries.en.gen.review.credits)).toBe(dictionaries.en.gen.review.unavailable);
  expect(value(dictionaries.en.gen.styleLabel)).toBe(dictionaries.en.gen.review.lookNotApplied);
  expect(jobs()).toHaveLength(0);
});

it("shows used and updating quotes in the composer and leaves the existing Generate request unchanged", async () => {
  render(<I18nProvider locale="en"><GeneratePanel orgId={ORG} models={MODELS} layout="composer" defaultStyleKitId={LOOK}
    initial={{ capability: "t2i", prompt: "A scene", model: "image-a", aspect: "16:9", duration: 5 }} /></I18nProvider>);
  await waitFor(() => expect(summary().dataset.state).toBe("ready"));
  fireEvent.click(screen.getByRole("button", { name: /Generate.*7.5/ }));
  await waitFor(() => expect(summary().dataset.state).toBe("stale"));
  expect(value(dictionaries.en.gen.review.credits)).toBe(dictionaries.en.gen.review.stale);
  expect(jobs()).toHaveLength(1);
  const sent = JSON.parse(jobs()[0][1].body);
  expect(sent).toMatchObject({ org_id: ORG, model: "image-a", capability: "t2i", max_credits: 7.5,
    params: { prompt: "A scene", style_kit_id: LOOK } });
  expect(Object.keys(sent).sort()).toEqual(["org_id", "model", "capability", "max_credits", "params", "idempotency_key"].sort());
  quoteAnswer = () => new Promise<Response>(() => {});
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Changed scene" } });
  await waitFor(() => expect(summary().dataset.state).toBe("updating"));
  expect(value(dictionaries.en.gen.review.credits)).toBe(dictionaries.en.gen.review.updating);
  expect(jobs()).toHaveLength(1);
});

it.each(["en", "ru", "uz"] as Locale[])("labels incomplete review in %s without adding an action", (locale) => {
  render(<I18nProvider locale={locale}><GeneratePanel orgId={ORG} models={MODELS} /></I18nProvider>);
  expect(screen.getByRole("region", { name: dictionaries[locale].gen.review.title })).toBeTruthy();
  expect(value(dictionaries[locale].gen.review.credits)).toBe(dictionaries[locale].gen.review.incomplete);
  expect(within(summary()).queryByRole("button")).toBeNull();
  expect(jobs()).toHaveLength(0);
});
