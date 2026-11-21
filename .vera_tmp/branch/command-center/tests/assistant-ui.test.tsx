// @vitest-environment jsdom
/**
 * The Assistant's plan on screen (components/assistant/AssistantPlanner):
 * making and editing a plan only asks prices; one Start creates each item
 * once, with its own idempotency key, in order; a refusal stops the rest
 * before anything more is spent; a step that cannot be priced disables Start
 * with the reason; a reload re-sends the same keys, never new ones.
 *
 * What would break without these: a plan that starts spending while it is
 * still being edited; a double press that pays twice; five Shorts started
 * after the first was refused for credits; a total that counts an unpriced
 * step as 0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/space/home",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/space${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, fmt, type Locale } from "@/lib/i18n";
import { AssistantPlanner, ASSISTANT_STORAGE_KEY } from "@/components/assistant/AssistantPlanner";
import type { StudioModel } from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const models: StudioModel[] = [
  { id: "img-a", displayName: "A", capabilities: ["t2i"], beta: false },
  { id: "tts-a", displayName: "C", capabilities: ["tts"], beta: false },
];
const channels = [{ id: "UC_space", slug: "space", name: "Space Daily", language: "English" }];

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

type Handler = (url: string, init: RequestInit | undefined) => Promise<Response> | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
let override: Handler | null = null;

beforeEach(() => {
  override = null;
  window.localStorage.clear();
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const hit = override?.(url, init);
    if (hit) return hit;
    if (url.startsWith("/api/creative/quote")) return json({ quote: { credits: 2 } });
    if (url.startsWith("/api/credits/estimate"))
      return json({ supported: true, enforced: true, exempt: false, estimate: { credits: 12, basis: "price", sample: 0 }, available: 500 });
    if (url.startsWith("/api/creative/jobs")) return json({ job: { id: "22222222-2222-4222-8222-222222222222" }, replay: false }, 201);
    if (url.startsWith("/api/agent/run")) return json({ ok: true, backend: "queue", credits_reserved: 12 });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Every call that could spend: a job or a run. A quote or an estimate holds nothing. */
const spends = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).startsWith("/api/creative/jobs") || String(url).startsWith("/api/agent/run"))
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }));

function mount(over: Partial<Parameters<typeof AssistantPlanner>[0]> = {}, locale: Locale = "en") {
  return render(
    <I18nProvider locale={locale}>
      <AssistantPlanner
        orgId={ORG}
        models={models}
        channels={channels}
        currentSlug="space"
        canRun
        runConfigured
        {...over}
      />
    </I18nProvider>,
  );
}

async function makePlan(goal: string) {
  fireEvent.change(screen.getByLabelText(t.assistant.goalLabel), { target: { value: goal } });
  fireEvent.click(screen.getByRole("button", { name: new RegExp(t.assistant.makePlan) }));
}

const startButton = () => screen.getByRole("button", { name: /^Start/ });

describe("the plan", () => {
  it("is priced and edited without a single job or run, and the total follows the edits", async () => {
    mount();
    await makePlan("2 shorts about tea and 3 images about tea");
    await waitFor(() => expect(startButton()).toHaveProperty("disabled", false));
    // 2 × 12 (runs) + 3 × 2 (images)
    expect(startButton().textContent).toBe(fmt(t.assistant.start, { n: "30" }));
    expect(screen.getByTestId("assistant-total").textContent).toBe(fmt(t.assistant.totalCredits, { n: "30" }));

    const steps = screen.getAllByRole("listitem");
    fireEvent.click(within(steps[1]).getByRole("button", { name: new RegExp(t.assistant.more) }));
    await waitFor(() => expect(startButton().textContent).toBe(fmt(t.assistant.start, { n: "32" })));
    fireEvent.click(within(steps[0]).getByRole("button", { name: new RegExp(t.assistant.remove) }));
    await waitFor(() => expect(startButton().textContent).toBe(fmt(t.assistant.start, { n: "8" })));

    expect(spends()).toEqual([]);
    // The run's price is Run now's own estimate, for its length.
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/credits/estimate?channel=UC_space&duration=60")).toBe(true);
  });

  it("a step that cannot be priced disables Start and says which and why", async () => {
    override = (url) => (url.startsWith("/api/creative/quote") ? json({ error: "unpriced" }, 422) : undefined);
    mount();
    await makePlan("a short about tea and an image about tea");
    await waitFor(() => expect(screen.getByText(fmt(t.assistant.blockedStep, { n: 2, reason: t.creative.errors.unpriced }))).toBeTruthy());
    expect(startButton()).toHaveProperty("disabled", true);
    fireEvent.click(startButton());
    expect(spends()).toEqual([]);
  });

  it("a blocked step (no access to start videos) disables Start before any price is asked for it", async () => {
    mount({ canRun: false });
    await makePlan("a short about tea");
    expect(startButton()).toHaveProperty("disabled", true);
    expect(screen.getByText(fmt(t.assistant.blockedStep, { n: 1, reason: t.assistant.blockers.no_access }))).toBeTruthy();
    await new Promise((r) => setTimeout(r, 450));
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/credits/estimate"))).toBe(false);
  });

  it("brackets left in a picture's words block Start until they are replaced", async () => {
    mount();
    await makePlan("2 thumbnails for my next video");
    expect(screen.getByText(fmt(t.assistant.blockedStep, { n: 1, reason: t.assistant.blockers.need_words }))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t.assistant.describeLabel), { target: { value: "A rocket on the launch pad" } });
    await waitFor(() => expect(startButton().textContent).toBe(fmt(t.assistant.start, { n: "4" })));
  });
});

describe("Start", () => {
  it("creates each item once, in order, each with its own key and the confirmed price — a second press adds nothing", async () => {
    mount();
    await makePlan("2 shorts about tea and 3 images about tea");
    await waitFor(() => expect(startButton()).toHaveProperty("disabled", false));
    await act(async () => {
      fireEvent.click(startButton());
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(screen.getByText(t.assistant.done)).toBeTruthy());

    const calls = spends();
    expect(calls.map((c) => c.url)).toEqual(["/api/agent/run", "/api/agent/run", "/api/creative/jobs", "/api/creative/jobs", "/api/creative/jobs"]);
    const keys = calls.map((c) => c.body.idempotency_key as string);
    expect(new Set(keys).size).toBe(5);
    for (const k of keys) expect(k).toMatch(/^assistant:[A-Za-z0-9-]+:s\d:\d$/);
    expect(calls[0].body).toMatchObject({ channel_id: "UC_space", duration: 60, niche: "tea", max_credits: 12 });
    expect(calls[2].body).toMatchObject({ org_id: ORG, capability: "t2i", model: "img-a", max_credits: 2 });
    expect(screen.getByTestId("assistant-progress").textContent).toBe(fmt(t.assistant.progress, { done: 5, total: 5 }));
    // Links to where the results land: the channel's videos (approval) and the Studio.
    expect(screen.getByRole("link", { name: new RegExp(t.assistant.openVideos) }).getAttribute("href")).toBe("/space/videos");
    expect(screen.getByRole("link", { name: new RegExp(t.assistant.openStudio) }).getAttribute("href")).toBe("/space/create");
  });

  it("a refused item stops the rest before anything more is spent, with the existing message", async () => {
    let runs = 0;
    override = (url) => {
      if (!url.startsWith("/api/agent/run")) return undefined;
      runs += 1;
      return runs === 2 ? json({ error: "insufficient_credits", needed: 12, available: 5 }, 402) : undefined;
    };
    mount();
    await makePlan("3 shorts about tea and 2 images about tea");
    await waitFor(() => expect(startButton()).toHaveProperty("disabled", false));
    await act(async () => fireEvent.click(startButton()));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    expect(spends().map((c) => c.url)).toEqual(["/api/agent/run", "/api/agent/run"]);
    expect(screen.getByRole("alert").textContent).toContain(fmt(t.credits.insufficient, { needed: "12", available: "5" }));
    expect(screen.getByRole("alert").textContent).toContain(t.assistant.stopped);
  });

  it.each([
    ["entitlement_required", 403],
    ["run_limit_reached", 429],
  ])("a creative refusal (%s) stops the rest too", async (code, status) => {
    override = (url) => (url.startsWith("/api/creative/jobs") ? json({ error: code }, status) : undefined);
    mount();
    await makePlan("3 images about tea and a short about tea");
    await waitFor(() => expect(startButton()).toHaveProperty("disabled", false));
    await act(async () => fireEvent.click(startButton()));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(spends().map((c) => c.url)).toEqual(["/api/creative/jobs"]);
    expect(screen.getByRole("alert").textContent).toContain(t.creative.errors[code as "entitlement_required"]);
  });

  it("Continue after a refusal re-sends the refused item with the same key and finishes the rest", async () => {
    let refuse = true;
    override = (url) => {
      if (url.startsWith("/api/creative/jobs") && refuse) {
        refuse = false;
        return json({ error: "insufficient_credits" }, 402);
      }
      return undefined;
    };
    mount();
    await makePlan("2 images about tea");
    await waitFor(() => expect(startButton()).toHaveProperty("disabled", false));
    await act(async () => fireEvent.click(startButton()));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const first = spends()[0].body.idempotency_key;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: fmt(t.assistant.continue, { n: "4" }) })));
    await waitFor(() => expect(screen.getByText(t.assistant.done)).toBeTruthy());
    const keys = spends().map((c) => c.body.idempotency_key);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(first);
    expect(keys[2]).not.toBe(first);
  });

  it("a replayed run (already started by an earlier press) counts as started, not as a failure", async () => {
    override = (url) => (url.startsWith("/api/agent/run") ? json({ error: "run_already_started" }, 409) : undefined);
    mount();
    await makePlan("a short about tea");
    await waitFor(() => expect(startButton()).toHaveProperty("disabled", false));
    await act(async () => fireEvent.click(startButton()));
    await waitFor(() => expect(screen.getByText(t.assistant.done)).toBeTruthy());
  });
});

describe("reload", () => {
  it("a plan interrupted mid-start comes back stopped, and Continue re-sends the same keys, never new ones", async () => {
    // First visit: the second item never answers (the page is closed while it is sent).
    let n = 0;
    override = (url) => {
      if (!url.startsWith("/api/creative/jobs")) return undefined;
      n += 1;
      return n === 2 ? new Promise<Response>(() => {}) : undefined;
    };
    mount();
    await makePlan("3 images about tea");
    await waitFor(() => expect(startButton()).toHaveProperty("disabled", false));
    await act(async () => fireEvent.click(startButton()));
    await waitFor(() => expect(spends()).toHaveLength(2));
    const sent = spends().map((c) => c.body.idempotency_key);
    cleanup();

    // The reload: a fresh mount reads the saved plan.
    override = null;
    fetchMock.mockClear();
    expect(window.localStorage.getItem(ASSISTANT_STORAGE_KEY)).toBeTruthy();
    mount();
    await waitFor(() => expect(screen.getByText(t.assistant.reloaded)).toBeTruthy());
    expect(spends()).toEqual([]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: fmt(t.assistant.continue, { n: "4" }) })));
    await waitFor(() => expect(screen.getByText(t.assistant.done)).toBeTruthy());
    const resent = spends().map((c) => c.body.idempotency_key);
    // The item in flight is re-sent with ITS key (the server answers the first job); the third is new.
    expect(resent).toHaveLength(2);
    expect(resent[0]).toBe(sent[1]);
    expect(sent).not.toContain(resent[1]);
  });

  it("New plan forgets the saved one", async () => {
    mount();
    await makePlan("an image about tea");
    await waitFor(() => expect(startButton()).toHaveProperty("disabled", false));
    await act(async () => fireEvent.click(startButton()));
    await waitFor(() => expect(screen.getByText(t.assistant.done)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: t.assistant.newPlan }));
    expect(window.localStorage.getItem(ASSISTANT_STORAGE_KEY)).toBeNull();
  });
});

describe("i18n", () => {
  it("every Assistant string exists in en, ru and uz", () => {
    const keys = (o: Record<string, unknown>, p = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));
    const en = keys(dictionaries.en.assistant).sort();
    expect(keys(dictionaries.ru.assistant).sort()).toEqual(en);
    expect(keys(dictionaries.uz.assistant).sort()).toEqual(en);
    for (const l of ["ru", "uz"] as const) {
      const flat = JSON.stringify(dictionaries[l].assistant);
      expect(flat).not.toMatch(/undefined/);
    }
  });

  it("renders in Uzbek", async () => {
    mount({}, "uz");
    expect(screen.getByRole("heading", { name: dictionaries.uz.assistant.title })).toBeTruthy();
  });
});
