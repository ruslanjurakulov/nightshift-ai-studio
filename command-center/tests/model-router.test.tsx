// @vitest-environment jsdom
/**
 * Model Router v1 (migration 0075) in the app: the Studio's "Auto" choice,
 * the routed quote and create, the API's routed quote, and the words.
 *
 * What must hold: Auto asks the DATABASE to pick (the browser never picks or
 * prices a model); the quote it shows names the pick and its price ("Auto
 * picked X for N credits") and why; the press sends back exactly that model,
 * that price as max_credits and one new idempotency key; a pick that changed
 * since the quote is re-quoted, never run; picking a model by hand turns Auto
 * off (exact: that model, never another); and every language says all of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import {
  CREATIVE_MODES,
  ROUTE_REASONS,
  mapCreativeError,
  parseGenerationInput,
  quote,
  type CreativeDb,
  type DbAnswer,
} from "@/lib/creative/operations";
import { quoteCreative, type ApiCaller, type Rpc } from "@/lib/api/operations";
import { coerceJobs, errorAction, fellBackLine, jobModel, routedLine, routedPick, upscaleTargetsFor, type StudioModel } from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const MODELS: StudioModel[] = [
  { id: "pic-fast", displayName: "Picture Fast", capabilities: ["t2i"], beta: false, speedTier: 5, qualityTier: 3 },
  { id: "pic-fine", displayName: "Picture Fine", capabilities: ["t2i"], beta: false, speedTier: 2, qualityTier: 5 },
  { id: "voice", displayName: "Voice One", capabilities: ["tts"], beta: false },
];
const PRICE: Record<string, number> = { "pic-fast": 4, "pic-fine": 9 };

// ── the operations layer ────────────────────────────────────────────────────

function fakeDb(answers: Partial<Record<string, DbAnswer>> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: CreativeDb = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      return answers[fn] ?? { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    },
    async readJob() {
      return { data: null, error: null };
    },
    async listJobs() {
      return { data: [], error: null };
    },
  };
  return { db, calls };
}

const BODY = { capability: "t2i", params: { prompt: "a kite" } };

describe("routed input", () => {
  it("a routed quote names no model; exact and every create still must", () => {
    const q = parseGenerationInput({ ...BODY, mode: "Auto" }, ORG, { requirePrice: false });
    expect(q.ok && q.input).toMatchObject({ mode: "auto", model: "" });
    const exact = parseGenerationInput(BODY, ORG, { requirePrice: false });
    expect(exact.ok || exact.result.body).toMatchObject({ error: "invalid_params", detail: "model is required" });
    const create = parseGenerationInput({ ...BODY, mode: "auto", max_credits: 9 }, ORG, { requirePrice: true });
    expect(create.ok || create.result.body).toMatchObject({ error: "invalid_params", detail: "model is required" });
    const ok = parseGenerationInput({ ...BODY, mode: "auto", model: "pic-fine", max_credits: 9 }, ORG, { requirePrice: true });
    expect(ok.ok && ok.input).toMatchObject({ mode: "auto", model: "pic-fine", maxCredits: 9 });
  });

  it("only the five modes are accepted", () => {
    expect([...CREATIVE_MODES]).toEqual(["exact", "auto", "cheap", "fast", "quality"]);
    for (const mode of ["turbo", "", 3, "exact; drop"]) {
      const r = parseGenerationInput({ ...BODY, model: "pic-fast", mode }, ORG, { requirePrice: false });
      expect(r.ok || r.result.body.error).toBe("invalid_params");
    }
  });

  it("a routed quote asks the database's router; exact asks for that model's price", async () => {
    const answer = { data: { credits: 9, routed_model: "pic-fine", route_reason: "best_value" }, error: null };
    const { db, calls } = fakeDb({ quote_creative_route: answer, quote_creative_job: { data: { credits: 4 }, error: null } });
    const routed = parseGenerationInput({ ...BODY, mode: "auto" }, ORG, { requirePrice: false });
    if (!routed.ok) throw new Error("parse");
    expect(await quote(db, routed.input)).toEqual({ status: 200, body: { quote: answer.data } });
    expect(calls[0]).toEqual({
      fn: "quote_creative_route",
      args: { p_org: ORG, p_capability: "t2i", p_mode: "auto", p_params: { prompt: "a kite" } },
    });
    const exact = parseGenerationInput({ ...BODY, model: "pic-fast" }, ORG, { requirePrice: false });
    if (!exact.ok) throw new Error("parse");
    await quote(db, exact.input);
    expect(calls[1].fn).toBe("quote_creative_job");
    expect(calls[1].args).not.toHaveProperty("p_mode");
  });

  it("a database without the router answers 'automatic choice is not available', not 'generation is off'", async () => {
    const { db } = fakeDb({ quote_creative_job: { data: { credits: 4 }, error: null } });
    const routed = parseGenerationInput({ ...BODY, mode: "cheap" }, ORG, { requirePrice: false });
    if (!routed.ok) throw new Error("parse");
    expect(await quote(db, routed.input)).toEqual({ status: 422, body: { error: "mode_not_supported" } });
  });

  it("the router's two refusals reach the app as their own codes", () => {
    expect(mapCreativeError({ code: "NS409", message: "route_changed", details: "quote again" })).toEqual({
      status: 409,
      body: { error: "route_changed", detail: "quote again" },
    });
    expect(mapCreativeError({ code: "NS400", message: "no_model_available", details: null }).body.error).toBe("no_model_available");
    expect(mapCreativeError({ code: "NS400", message: "no_model_available", details: null }).status).toBe(422);
    expect(errorAction("route_changed")).toBe("requote");
  });
});

describe("the API's routed quote", () => {
  function caller() {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const rpc: Rpc = async (fn, args) => {
      calls.push({ fn, args });
      return { data: { ok: true, status: 200, data: { quote: { credits: 5 } } }, error: null };
    };
    const c: ApiCaller = { keyHash: "b".repeat(64), requestId: "req_test", rpc, backend: "queue", downloads: false };
    return { c, calls };
  }

  it("sends the mode (and no model) to api_creative_quote; exact is the five-argument call as before", async () => {
    const { c, calls } = caller();
    await quoteCreative(c, { ...BODY, mode: "auto" });
    expect(calls[0]).toEqual({
      fn: "api_creative_quote",
      args: { p_key_hash: c.keyHash, p_capability: "t2i", p_model: null, p_params: { prompt: "a kite" }, p_mode: "auto", p_request_id: "req_test" },
    });
    await quoteCreative(c, { ...BODY, model: "pic-fast" });
    expect(calls[1].args).not.toHaveProperty("p_mode");
    expect(Object.keys(calls[1].args).filter((k) => /org/i.test(k))).toEqual([]);
  });
});

// ── the words ───────────────────────────────────────────────────────────────

describe("what the person reads", () => {
  const names = new Map([["pic-fine", "Picture Fine"], ["pic-fast", "Picture Fast"]]);

  it("the pick: a known model id with its picker name, a known reason, or nothing", () => {
    expect(routedPick({ routed_model: "pic-fine", route_reason: "best_value", display_name: "X" }, names)).toEqual({
      model: "pic-fine",
      name: "Picture Fine",
      reason: "best_value",
    });
    expect(routedPick({ routed_model: "other", route_reason: "nope", display_name: "Other One" }, names)).toEqual({
      model: "other",
      name: "Other One",
      reason: null,
    });
    for (const bad of [null, {}, { routed_model: "" }, { routed_model: "Bad Id!" }, { routed_model: 7 }]) expect(routedPick(bad as never)).toBeNull();
  });

  it("every language says 'Auto picked <name> for <price>', why, and a failover, in full", () => {
    for (const [loc, d] of Object.entries(dictionaries)) {
      const line = routedLine(d, { model: "pic-fine", name: "Picture Fine", reason: "best_value" }, 9, loc);
      expect(line.picked).toContain("Picture Fine");
      expect(line.picked).toContain("9");
      expect(line.why).toContain(d.gen.router.reasons.best_value);
      for (const r of ROUTE_REASONS) expect(d.gen.router.reasons[r].trim()).not.toBe("");
      for (const k of ["auto", "autoLabel", "autoOff", "picking", "note", "fellBack"] as const) expect(d.gen.router[k].trim()).not.toBe("");
      expect(d.creative.errors.route_changed.trim()).not.toBe("");
      expect(d.creative.errors.no_model_available.trim()).not.toBe("");
      expect(fellBackLine(d, { routed_model: "pic-fine", fallback_from: "pic-fast" }, names)).toMatch(/Picture Fine[\s\S]*Picture Fast|Picture Fast[\s\S]*Picture Fine/);
    }
  });

  it("customer copy names no provider and no role", () => {
    for (const d of Object.values(dictionaries)) {
      const text = JSON.stringify(d.gen.router) + d.creative.errors.route_changed + d.creative.errors.no_model_available;
      expect(text).not.toMatch(/openai|google|gemini|veo|kling|runway|eleven|flux|ideogram|seedance|minimax|luma|wan\b|owner|editor|viewer/i);
    }
  });

  it("a job shows the model that made it, and a failover says so", () => {
    const [job] = coerceJobs([
      { id: "j", status: "completed", capability: "t2i", requested_model: "pic-fast", routed_model: "pic-fine", fallback_from: "pic-fast", fallback_reason: "unavailable" },
    ]);
    expect(jobModel(job)).toBe("pic-fine");
    expect(fellBackLine(t, job, names)).toBe("Made with Picture Fine: Picture Fast was unavailable.");
    const [exact] = coerceJobs([{ id: "e", status: "completed", capability: "t2i", requested_model: "pic-fast", routed_model: "pic-fast" }]);
    expect(fellBackLine(t, exact, names)).toBeNull();
  });
});

// ── the Studio composer ─────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;
let quotes: Array<Record<string, unknown>>;
let routeAnswers: Array<{ model: string; credits: number; reason: string }>;
let createAnswer: { body: unknown; status: number };

beforeEach(() => {
  quotes = [];
  routeAnswers = [];
  createAnswer = { body: { job: { id: "0f0e0d0c-0b0a-4000-8000-000000000001" }, replay: false }, status: 201 };
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/creative/quote") {
      const body = JSON.parse(String(init?.body));
      quotes.push(body);
      if (body.mode === "auto") {
        const a = routeAnswers.shift() ?? { model: "pic-fine", credits: 9, reason: "best_value" };
        return json({ quote: { credits: a.credits, model: a.model, routed_model: a.model, route_reason: a.reason, display_name: "ignored" } });
      }
      return json({ quote: { credits: PRICE[body.model] ?? 1 } });
    }
    if (url === "/api/creative/jobs" && init?.method === "POST") return json(createAnswer.body, createAnswer.status);
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
    if (url.startsWith("/api/media")) return json({ available: true, assets: [], uploads: [] });
    if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const creates = () =>
  fetchMock.mock.calls
    .filter(([u, init]) => u === "/api/creative/jobs" && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

async function typePrompt() {
  fireEvent.change(screen.getByRole("textbox", { name: t.gen.promptLabel }), { target: { value: "a red kite" } });
}

describe("Auto in the composer", () => {
  it("is a small choice beside the model; on, the database picks and the quote says 'Auto picked <name> for <price>'", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    const auto = screen.getByRole("button", { name: t.gen.router.autoLabel });
    expect(auto.getAttribute("aria-pressed")).toBe("false");
    await typePrompt();
    fireEvent.click(auto);
    expect(auto.getAttribute("aria-pressed")).toBe("true");
    const pick = await screen.findByText("Auto picked Picture Fine for 9 credits", undefined, { timeout: 2000 });
    expect(pick).toBeTruthy();
    expect(screen.getByText(`Why: ${t.gen.router.reasons.best_value}.`)).toBeTruthy();
    const routedQuote = quotes.filter((q) => q.mode === "auto").at(-1)!;
    expect(routedQuote).not.toHaveProperty("model");
    expect(routedQuote).toMatchObject({ org_id: ORG, capability: "t2i", mode: "auto" });
    // Nothing was started by switching Auto on or by its quote.
    expect(creates()).toEqual([]);
  });

  it("the press sends back the quoted pick, its price as the ceiling and a fresh idempotency key", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    await typePrompt();
    fireEvent.click(screen.getByRole("button", { name: t.gen.router.autoLabel }));
    await screen.findByText("Auto picked Picture Fine for 9 credits", undefined, { timeout: 2000 });
    fireEvent.click(screen.getByTestId("gen-dock").querySelector("button") as HTMLElement);
    await waitFor(() => expect(creates()).toHaveLength(1));
    const [sent] = creates();
    expect(sent).toMatchObject({ org_id: ORG, capability: "t2i", mode: "auto", model: "pic-fine", max_credits: 9 });
    expect(typeof sent.idempotency_key).toBe("string");
  });

  it("a pick that changed since the quote is shown again with its new price, never started", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    await typePrompt();
    fireEvent.click(screen.getByRole("button", { name: t.gen.router.autoLabel }));
    await screen.findByText("Auto picked Picture Fine for 9 credits", undefined, { timeout: 2000 });
    createAnswer = { body: { error: "route_changed" }, status: 409 };
    routeAnswers.push({ model: "pic-fast", credits: 4, reason: "cheapest" });
    fireEvent.click(screen.getByTestId("gen-dock").querySelector("button") as HTMLElement);
    expect(await screen.findByText(t.creative.errors.route_changed)).toBeTruthy();
    await screen.findByText("Auto picked Picture Fast for 4 credits", undefined, { timeout: 2000 });
  });

  it("picking a model by hand turns Auto off: that model, exactly", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    await typePrompt();
    const auto = screen.getByRole("button", { name: t.gen.router.autoLabel });
    fireEvent.click(auto);
    fireEvent.click(screen.getByRole("button", { name: t.gen.modelChangeLabel }));
    const dialog = await screen.findByRole("dialog", { name: t.gen.sheetTitle });
    const fast = within(dialog).getAllByRole("option").find((o) => o.getAttribute("data-model") === "pic-fast")!;
    fireEvent.click(fast);
    await waitFor(() => expect(auto.getAttribute("aria-pressed")).toBe("false"));
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Picture Fast");
    await waitFor(() => expect(quotes.at(-1)).toMatchObject({ model: "pic-fast" }));
    expect(quotes.at(-1)).not.toHaveProperty("mode");
  });

  it("is not offered where there is nothing to choose", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.tts }));
    expect(screen.queryByRole("button", { name: t.gen.router.autoLabel })).toBeNull();
  });

  it("video upscale under Auto offers every size a model makes, never only the hand-picked model's", () => {
    const vids: StudioModel[] = [
      { id: "up-a", displayName: "Up A", capabilities: ["video_upscale"], beta: false, upscaleTargets: ["1k", "2k"] },
      { id: "up-b", displayName: "Up B", capabilities: ["video_upscale"], beta: false, upscaleTargets: ["4k", "2k"] },
    ];
    expect(upscaleTargetsFor(vids, vids[0], false)).toEqual(["1k", "2k"]);
    expect(upscaleTargetsFor(vids, vids[0], true)).toEqual(["1k", "2k", "4k"]);
    render(withI18n(<GeneratePanel orgId={ORG} models={vids} />));
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.video_upscale }));
    const sizes = () => within(screen.getByRole("group", { name: t.gen.targetLabel })).getAllByRole("button").map((b) => b.textContent);
    expect(sizes()).toEqual(["1K", "2K"]);
    fireEvent.click(screen.getByRole("button", { name: t.gen.router.autoLabel }));
    expect(sizes()).toEqual(["1K", "2K", "4K"]);
  });
});
