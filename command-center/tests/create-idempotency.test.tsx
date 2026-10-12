// @vitest-environment jsdom
/**
 * Money safety of the guided create flow (components/create/CreateStudio.tsx).
 *
 * POST /api/agent/run takes an `idempotency_key` (the hold's reference is then
 * stable for user + channel + key, so a replay is refused as
 * `run_already_started` and nothing is held twice) and `max_credits` (a dearer
 * estimate is refused as `price_changed`, nothing held). Both are honoured by
 * the route; these tests pin that the BROWSER sends them the way that needs:
 *   - one key per intent (channel + topic + options, NOT the price): the same
 *     key for a double click or a retry, even if the price moved in between; a
 *     new key when the topic or an option changes;
 *   - the ceiling is exactly the price the card is showing, never a stale one;
 *   - each answer (price changed, replay, run limit, not enough credits, a
 *     hold that did not start, a failure) is said in words that tell whether
 *     credits were taken or held;
 *   - one channel's key never reaches another.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/chronos/create" }));
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
import { CreateStudio } from "@/components/create/CreateStudio";

const t = dictionaries.en;
const f = t.create.flow;
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const priced = (credits: number | null) => ({
  supported: true,
  enforced: true,
  exempt: false,
  estimate: credits === null ? { credits: null, basis: "unknown", sample: 0, floorApplied: false, gap: "no_prices" } : { credits, basis: "per_minute", sample: 0, floorApplied: false, gap: null },
  available: 900,
});

let calls: { url: string; init?: RequestInit }[];
let estimateAnswer: (url: string) => Promise<Response>;
let runAnswer: () => Promise<Response>;
const runs = () => calls.filter((c) => c.url.startsWith("/api/agent/run"));
const body = (i: number) => JSON.parse(String(runs()[i].init?.body)) as Record<string, unknown>;

beforeEach(() => {
  calls = [];
  window.sessionStorage.clear();
  estimateAnswer = () => json(priced(120));
  runAnswer = () => json({ ok: true });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("/api/credits/estimate")) return estimateAnswer(String(url));
      if (String(url).startsWith("/api/agent/run")) return runAnswer();
      if (String(url).startsWith("/api/agent/events")) return json({ events: [], jobs: null });
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const studio = (channelId = "chan-a") => (
  <I18nProvider locale="en">
    <CreateStudio channelId={channelId} githubConfigured agentConfig={null} canRun />
  </I18nProvider>
);
const show = (channelId = "chan-a") => render(studio(channelId));
const topic = () => screen.getByRole("textbox", { name: f.topicTitle }) as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(topic(), { target: { value: v } });
const make = () => fireEvent.click(screen.getByRole("button", { name: t.create.create }));
// The confirm is held ("Checking the price…") until the price card has reported; wait for the real one.
const confirm = async () => fireEvent.click(await screen.findByRole("button", { name: t.create.confirm }));
/** Make, then confirm, then let the answer land. */
async function press() {
  make();
  await confirm();
  await act(async () => {});
}
const priceShown = (n: number) => screen.findByText(new RegExp(`About ${n} credits`));
const status = () => document.querySelector(".fl-status")?.textContent ?? "";

describe("the run carries the price that was shown and a key the route accepts", () => {
  it("sends max_credits equal to the figure on the price card", async () => {
    show();
    await priceShown(120);
    type("Ancient Khiva");
    await press();
    expect(runs()).toHaveLength(1);
    expect(body(0).max_credits).toBe(120);
    expect(String(body(0).idempotency_key)).toMatch(/^[A-Za-z0-9_:.-]{1,255}$/);
  });

  it("sends the NEW price after a length change, never the old figure", async () => {
    estimateAnswer = (url) => json(priced(url.includes("duration=300") ? 200 : 120));
    show();
    await priceShown(120);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(f.lengthLabel) }));
    fireEvent.click(screen.getByRole("radio", { name: t.agents.runDur5m }));
    await priceShown(200);
    await press();
    expect(body(0).max_credits).toBe(200);
  });

  it("while the price is being asked the confirm waits, says so, and sends nothing; then it sends the new figure", async () => {
    show();
    await priceShown(120);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(f.lengthLabel) }));
    let release: (r: Response) => void = () => {};
    estimateAnswer = () => new Promise<Response>((r) => (release = r));
    fireEvent.click(screen.getByRole("radio", { name: t.agents.runDur5m }));
    await screen.findByTestId("price-checking");
    make();
    const held = await screen.findByRole("button", { name: t.credits.priceChecking });
    expect(held.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(held);
    await act(async () => {});
    expect(runs()).toHaveLength(0);
    await act(async () => release(new Response(JSON.stringify(priced(200)), { status: 200 })));
    await priceShown(200);
    const go = await screen.findByRole("button", { name: t.create.confirm });
    expect(go.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(go);
    await act(async () => {});
    expect(runs()).toHaveLength(1);
    expect(body(0).max_credits).toBe(200);
  });

  it("an unreadable price turns the confirm into Retry; nothing is sent until a price is on screen", async () => {
    estimateAnswer = () => json({}, 503);
    show();
    await screen.findByRole("button", { name: t.common.retry });
    make();
    await waitFor(() => expect(document.querySelector(".fl-go[data-price-hold=failed]")).not.toBeNull());
    const retry = document.querySelector(".fl-go[data-price-hold=failed]") as HTMLElement;
    expect(retry.textContent).toBe(t.common.retry);
    estimateAnswer = () => json(priced(120));
    fireEvent.click(retry);
    await priceShown(120);
    expect(runs()).toHaveLength(0);
    await confirm();
    await act(async () => {});
    expect(runs()).toHaveLength(1);
    expect(body(0).max_credits).toBe(120);
  });

  it("an organization that is not charged (exempt), or a workspace with no price list, sends no ceiling but still a key", async () => {
    estimateAnswer = () => json({ ...priced(120), exempt: true });
    show();
    await screen.findByText(t.credits.estimateExempt);
    await press();
    expect("max_credits" in body(0)).toBe(false);
    expect(String(body(0).idempotency_key).length).toBeGreaterThan(0);
    cleanup();
    estimateAnswer = () => json({ supported: false, enforced: false });
    show();
    await screen.findByTestId("price-unavailable");
    await press();
    expect("max_credits" in body(1)).toBe(false);
  });

  it("an unpriced run (a pricing gap) shows no number and invents no ceiling", async () => {
    estimateAnswer = () => json(priced(null));
    show();
    await screen.findByText(t.credits.gap.no_prices);
    await press();
    expect(runs()).toHaveLength(1);
    expect("max_credits" in body(0)).toBe(false);
  });
});

describe("one intent is one key", () => {
  it("a double click posts once (three clicks in the same tick)", async () => {
    show();
    await priceShown(120);
    make();
    const go = await screen.findByRole("button", { name: t.create.confirm });
    let release: (r: Response) => void = () => {};
    runAnswer = () => new Promise<Response>((r) => (release = r));
    await act(async () => {
      fireEvent.click(go);
      fireEvent.click(go);
      fireEvent.click(go);
    });
    expect(runs()).toHaveLength(1);
    await act(async () => release(new Response("{}", { status: 200 })));
    expect(runs()).toHaveLength(1);
  });

  it("Enter while a run is starting does not ask again", async () => {
    show();
    await priceShown(120);
    make();
    let release: (r: Response) => void = () => {};
    runAnswer = () => new Promise<Response>((r) => (release = r));
    await confirm();
    fireEvent.keyDown(topic(), { key: "Enter" });
    expect(screen.queryByRole("button", { name: t.create.cancel })).toBeNull();
    await act(async () => release(new Response("{}", { status: 200 })));
    expect(runs()).toHaveLength(1);
  });

  it("after a dropped connection the retry sends the very same request (the first may have been held)", async () => {
    show();
    await priceShown(120);
    type("Ancient Khiva");
    runAnswer = () => Promise.reject(new TypeError("network"));
    await press();
    await waitFor(() => expect(status()).toContain(f.startUnsure));
    runAnswer = () => json({ ok: true });
    await press();
    expect(runs()).toHaveLength(2);
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
    expect(body(1)).toEqual(body(0));
  });

  it("the key lives in memory only: a reload starts a new attempt, and nothing is written to web storage", async () => {
    const first = show();
    await priceShown(120);
    type("Ancient Khiva");
    runAnswer = () => Promise.reject(new TypeError("network"));
    await press();
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
    first.unmount();
    runAnswer = () => json({ ok: true });
    show();
    await priceShown(120);
    type("Ancient Khiva");
    await press();
    expect(runs()).toHaveLength(2);
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("the price moving between the first try and the retry does not change the key; max_credits is the price last shown", async () => {
    estimateAnswer = (url) => json(priced(url.includes("duration=300") ? 140 : 120));
    show();
    await priceShown(120);
    type("Ancient Khiva");
    runAnswer = () => Promise.reject(new TypeError("network"));
    await press();
    // The card is asked again (another length and back) and now says 140 for the same video.
    fireEvent.click(screen.getByRole("button", { name: new RegExp(f.lengthLabel) }));
    fireEvent.click(screen.getByRole("radio", { name: t.agents.runDur5m }));
    await priceShown(140);
    estimateAnswer = () => json(priced(140));
    fireEvent.click(screen.getByRole("radio", { name: f.lengthDefault }));
    await priceShown(140);
    runAnswer = () => json({ ok: true });
    await press();
    expect(runs()).toHaveLength(2);
    expect(body(1).max_credits).toBe(140);
    expect(body(0).max_credits).toBe(120);
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
  });

  it("a failure that held nothing keeps the key for the retry", async () => {
    show();
    await priceShown(120);
    runAnswer = () => json({ error: "credit_reserve_failed" }, 502);
    await press();
    runAnswer = () => json({ ok: true });
    await press();
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
  });

  it("changing the brief is a different video, so a new key", async () => {
    show();
    await priceShown(120);
    type("Ancient Khiva");
    runAnswer = () => json({ error: "credit_reserve_failed" }, 502);
    await press();
    type("The Aral Sea");
    runAnswer = () => json({ ok: true });
    await press();
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
    expect(body(1).topic).toBe("The Aral Sea");
  });

  it("changing the length is a different video, so a new key (and the new price is the ceiling)", async () => {
    estimateAnswer = (url) => json(priced(url.includes("duration=300") ? 200 : 120));
    show();
    await priceShown(120);
    type("Ancient Khiva");
    runAnswer = () => json({ error: "credit_reserve_failed" }, 502);
    await press();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(f.lengthLabel) }));
    fireEvent.click(screen.getByRole("radio", { name: t.agents.runDur5m }));
    await priceShown(200);
    runAnswer = () => json({ ok: true });
    await press();
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
    expect(body(1).max_credits).toBe(200);
  });

  it("a confirmed start settles the intent: the next deliberate create gets a new key", async () => {
    show();
    await priceShown(120);
    type("Ancient Khiva");
    await press();
    expect(status()).toContain(t.create.queued);
    fireEvent.keyDown(topic(), { key: "Enter" });
    await confirm();
    await act(async () => {});
    expect(runs()).toHaveLength(2);
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("one channel's key never reaches another channel, and nothing is stored that could carry it", async () => {
    const view = show("chan-a");
    await priceShown(120);
    type("Ancient Khiva");
    runAnswer = () => json({ error: "credit_reserve_failed" }, 502);
    await press();
    view.rerender(studio("chan-b"));
    await priceShown(120);
    await press();
    expect(body(1).channel_id).toBe("chan-b");
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
    view.rerender(studio("chan-a"));
    await priceShown(120);
    await press();
    expect(body(2).channel_id).toBe("chan-a");
    expect(body(2).idempotency_key).not.toBe(body(1).idempotency_key);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });
});

describe("what the server answered, in words", () => {
  it("409 price_changed with no earlier unanswered try: says the new price and that nothing was taken or held, re-reads the card, needs a new confirm, and keeps the key", async () => {
    show();
    await priceShown(120);
    type("Ancient Khiva");
    runAnswer = () => json({ error: "price_changed", credits: 150 }, 409);
    estimateAnswer = () => json(priced(150));
    await press();
    expect(runs()).toHaveLength(1);
    expect(status()).toContain("150");
    expect(status()).toContain(f.notTaken);
    expect(screen.getByRole("button", { name: t.create.create })).toBeTruthy();
    await priceShown(150);
    runAnswer = () => json({ ok: true });
    await press();
    expect(runs()).toHaveLength(2);
    expect(body(1).max_credits).toBe(150);
    // Nothing was held under that key, and the same video: the same key.
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
  });

  it("409 price_changed on a retry after a LOST answer does not claim nothing was held (the route compares the price before it looks for the hold); confirming again is answered 'already started'", async () => {
    show();
    await priceShown(120);
    type("Ancient Khiva");
    runAnswer = () => Promise.reject(new TypeError("network"));
    await press();
    expect(status()).toContain(f.startUnsure);
    // The first try may have held; the price has since gone up.
    runAnswer = () => json({ error: "price_changed", credits: 150 }, 409);
    estimateAnswer = () => json(priced(150));
    await press();
    expect(status()).toContain("150");
    expect(status()).not.toContain(f.notTaken);
    expect(status()).toContain(f.priceChangedUnsure.replace("{n}", "150"));
    // Still needs a fresh confirm at the new price, and still the same key.
    await priceShown(150);
    runAnswer = () => json({ error: "run_already_started" }, 409);
    await press();
    expect(runs()).toHaveLength(3);
    expect(body(2).max_credits).toBe(150);
    expect(new Set([0, 1, 2].map((i) => body(i).idempotency_key)).size).toBe(1);
    expect(status()).toContain(f.alreadySent);
    expect(status()).not.toContain(t.agents.runFailed);
  });

  it("409 price_changed whose body proves a hold (credits_held) gets the held sentence, not 'nothing was taken'", async () => {
    show();
    await priceShown(120);
    runAnswer = () => json({ error: "price_changed", credits: 150, credits_held: 120 }, 409);
    await press();
    expect(status()).toContain("120");
    expect(status()).toContain("3 hours");
    expect(status()).not.toContain(f.notTaken);
  });

  it("409 price_changed where the price on the card turns out the same keeps the key (nothing was held)", async () => {
    show();
    await priceShown(120);
    runAnswer = () => json({ error: "price_changed", credits: 120 }, 409);
    await press();
    expect(status()).toContain(f.notTaken);
    runAnswer = () => json({ ok: true });
    await press();
    expect(body(1).max_credits).toBe(120);
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
  });

  it("409 run_already_started is a start, not a failure: it says so, held nothing new, and the next create is a new intent", async () => {
    show();
    await priceShown(120);
    type("Ancient Khiva");
    runAnswer = () => json({ error: "run_already_started" }, 409);
    await press();
    expect(status()).toContain(f.alreadySent);
    expect(status()).not.toContain(t.agents.runFailed);
    // The progress panel of the existing run is what is shown.
    expect(screen.getByText(f.watchTitle)).toBeTruthy();
    fireEvent.keyDown(topic(), { key: "Enter" });
    runAnswer = () => json({ ok: true });
    await confirm();
    await act(async () => {});
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("429 run_limit: says the plan's runs are all in use and that nothing was taken or held; the retry keeps the key", async () => {
    show();
    await priceShown(120);
    runAnswer = () => json({ error: "run_limit", active: 2, limit: 2 }, 429);
    await press();
    expect(status()).toContain(t.credits.runLimit.replace("{n}", "2"));
    expect(status()).toContain(f.notTaken);
    runAnswer = () => json({ ok: true });
    await press();
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
  });

  it("402 insufficient credits: says how many were needed and available, and that nothing was taken or held", async () => {
    show();
    await priceShown(120);
    runAnswer = () => json({ error: "insufficient_credits", needed: 120, available: 20 }, 402);
    await press();
    expect(status()).toContain("120");
    expect(status()).toContain("20");
    expect(status()).toContain(f.notTaken);
    expect(screen.getByRole("button", { name: t.create.create })).toBeTruthy();
  });

  it("a hold was taken but the run did not start: says how many credits are held and that they come back within 3 hours; the next try is a NEW intent", async () => {
    show();
    await priceShown(120);
    runAnswer = () => json({ error: "github_dispatch_failed", credits_held: 120 }, 502);
    await press();
    expect(status()).toContain("120");
    expect(status()).toContain("3 hours");
    expect(status()).not.toContain(f.notTaken);
    runAnswer = () => json({ ok: true });
    await press();
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("a generic failure says nothing was taken or held; a gateway error with no body says it cannot tell", async () => {
    show();
    await priceShown(120);
    runAnswer = () => json({ error: "github_dispatch_failed" }, 502);
    await press();
    expect(status()).toContain(t.agents.runFailed);
    expect(status()).toContain(f.notTaken);
    runAnswer = () => Promise.resolve(new Response("<html>Bad gateway</html>", { status: 504 }));
    await press();
    expect(status()).toContain(f.startUnsure);
    expect(status()).not.toContain(f.notTaken);
    // Both were the same intent.
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
  });
});
