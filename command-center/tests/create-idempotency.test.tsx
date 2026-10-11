// @vitest-environment jsdom
/**
 * Money safety of the guided create flow (components/create/CreateStudio.tsx).
 *
 * POST /api/agent/run takes an `idempotency_key` (the hold's reference is then
 * stable for user + channel + key, so a replay is refused as
 * `run_already_started` and nothing is held twice) and `max_credits` (a dearer
 * estimate is refused as `price_changed`, nothing held). Both are honoured by
 * the route and pinned server-side in tests/reserveRunCredits.test.ts; these
 * tests pin that the BROWSER sends them the way that contract needs:
 *   - one key per attempt, the same key on a retry of the same inputs;
 *   - a new key after a confirmed start, after a failure that kept a hold,
 *     and when the inputs change;
 *   - the ceiling is exactly the price the card is showing, never a stale one;
 *   - a second click cannot post a second time.
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

function show() {
  return render(
    <I18nProvider locale="en">
      <CreateStudio channelId="chan-a" githubConfigured agentConfig={null} canRun />
    </I18nProvider>,
  );
}
const topic = () => screen.getByRole("textbox", { name: t.create.flow.topicTitle }) as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(topic(), { target: { value: v } });
const make = () => fireEvent.click(screen.getByRole("button", { name: t.create.create }));
const confirm = () => fireEvent.click(screen.getByRole("button", { name: t.create.confirm }));
/** Make, then confirm, then let the answer land. */
async function press() {
  make();
  confirm();
  await act(async () => {});
}
const priceShown = (n: number) => screen.findByText(new RegExp(`About ${n} credits`));

describe("the run carries an idempotency key and the price that was shown", () => {
  it("sends max_credits equal to the figure on the price card, and a key the route accepts", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t.create.flow.lengthLabel) }));
    fireEvent.click(screen.getByRole("radio", { name: t.agents.runDur5m }));
    await priceShown(200);
    await press();
    expect(body(0).max_credits).toBe(200);
  });

  it("while the price is being asked (a length change) the card shows no figure and the confirm waits", async () => {
    show();
    await priceShown(120);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t.create.flow.lengthLabel) }));
    let release: (r: Response) => void = () => {};
    estimateAnswer = () => new Promise<Response>((r) => (release = r));
    fireEvent.click(screen.getByRole("radio", { name: t.agents.runDur5m }));
    await screen.findByTestId("price-checking");
    make();
    const held = screen.getByRole("button", { name: t.credits.priceChecking });
    expect(held.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(held);
    await act(async () => {});
    expect(runs()).toHaveLength(0);
    await act(async () => release(new Response(JSON.stringify(priced(200)), { status: 200 })));
    await priceShown(200);
    const go = screen.getByRole("button", { name: t.create.confirm });
    expect(go.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(go);
    await act(async () => {});
    expect(runs()).toHaveLength(1);
    expect(body(0).max_credits).toBe(200);
  });
});

describe("an unknown price is never confirmed unseen", () => {
  it("before the first answer the confirm waits, says it is checking, and sends nothing", async () => {
    let release: (r: Response) => void = () => {};
    estimateAnswer = () => new Promise<Response>((r) => (release = r));
    show();
    make();
    const held = screen.getByRole("button", { name: t.credits.priceChecking });
    expect(held.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(held);
    fireEvent.keyDown(topic(), { key: "Enter" });
    await act(async () => {});
    expect(runs()).toHaveLength(0);
    await act(async () => release(new Response(JSON.stringify(priced(120)), { status: 200 })));
    await priceShown(120);
    fireEvent.click(screen.getByRole("button", { name: t.create.confirm }));
    await act(async () => {});
    expect(runs()).toHaveLength(1);
    expect(body(0).max_credits).toBe(120);
  });

  it("an unreadable estimate turns the confirm into Retry; nothing is sent until a price is on screen", async () => {
    estimateAnswer = () => json({}, 503);
    show();
    await screen.findByRole("button", { name: t.common.retry });
    make();
    const retry = screen.getAllByRole("button", { name: t.common.retry }).find((b) => b.classList.contains("fl-go")) as HTMLElement;
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    estimateAnswer = () => json(priced(120));
    fireEvent.click(retry);
    await priceShown(120);
    expect(runs()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: t.create.confirm }));
    await act(async () => {});
    expect(runs()).toHaveLength(1);
    expect(body(0).max_credits).toBe(120);
  });

  it("an organization that is not charged (exempt) is not held back, and sends no ceiling", async () => {
    estimateAnswer = () => json({ ...priced(120), exempt: true });
    show();
    await screen.findByText(t.credits.estimateExempt);
    await press();
    expect(runs()).toHaveLength(1);
    expect("max_credits" in body(0)).toBe(false);
  });

  it("a workspace where running is not priced at all (no price list) is not held back either", async () => {
    estimateAnswer = () => json({ supported: false, enforced: false });
    show();
    await screen.findByTestId("price-unavailable");
    await press();
    expect(runs()).toHaveLength(1);
    expect("max_credits" in body(0)).toBe(false);
  });
});

describe("an unpriced run (a pricing gap) sends no ceiling and no number is shown", () => {
  it("the server refuses it when it must; the browser does not invent a ceiling", async () => {
    estimateAnswer = () => json(priced(null));
    show();
    await screen.findByText(t.credits.gap.no_prices);
    await press();
    expect(runs()).toHaveLength(1);
    expect("max_credits" in body(0)).toBe(false);
    expect(String(body(0).idempotency_key).length).toBeGreaterThan(0);
  });
});

describe("a retry of the same attempt is the same attempt", () => {
  it("after a dropped connection the retry reuses the key (the first may have been held)", async () => {
    show();
    await priceShown(120);
    type("Ancient Khiva");
    runAnswer = () => Promise.reject(new TypeError("network"));
    await press();
    await waitFor(() => expect(screen.getByText(t.agents.runFailed)).toBeTruthy());
    runAnswer = () => json({ ok: true });
    await press();
    expect(runs()).toHaveLength(2);
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
    expect(body(1)).toEqual(body(0));
  });

  it("after a server error that held nothing known, the retry reuses the key too", async () => {
    show();
    await priceShown(120);
    runAnswer = () => json({ error: "credit_reserve_failed" }, 502);
    await press();
    runAnswer = () => json({ ok: true });
    await press();
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
  });

  it("when the server says this attempt was already started it says so, held nothing new, and the next create is a new attempt", async () => {
    show();
    await priceShown(120);
    type("Ancient Khiva");
    runAnswer = () => json({ error: "run_already_started" }, 409);
    await press();
    expect(document.querySelector(".fl-status")?.textContent).toContain(t.create.flow.alreadySent);
    expect(document.querySelector(".fl-status")?.textContent).not.toContain(t.agents.runFailed);
    // Enter in the box asks again; the confirm is the second press.
    fireEvent.keyDown(topic(), { key: "Enter" });
    runAnswer = () => json({ ok: true });
    confirm();
    await act(async () => {});
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("when a hold was taken but the run did not start, the next try is a NEW attempt (the old key could only answer 'already started')", async () => {
    show();
    await priceShown(120);
    runAnswer = () => json({ error: "github_dispatch_failed", credits_held: 120 }, 502);
    await press();
    expect(document.querySelector(".fl-status")?.textContent).toContain(t.credits.heldNote);
    runAnswer = () => json({ ok: true });
    await press();
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("changing the brief after a failure is a different video, so a new key", async () => {
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

  it("a confirmed start settles the attempt: the next deliberate create gets a new key", async () => {
    show();
    await priceShown(120);
    type("Ancient Khiva");
    await press();
    expect(document.querySelector(".fl-status")?.textContent).toContain(t.create.queued);
    fireEvent.keyDown(topic(), { key: "Enter" });
    confirm();
    await act(async () => {});
    expect(runs()).toHaveLength(2);
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("a price that moved is asked again and said in words; the retry keeps the key (nothing was held)", async () => {
    show();
    await priceShown(120);
    runAnswer = () => json({ error: "price_changed", credits: 150 }, 409);
    estimateAnswer = () => json(priced(150));
    await press();
    expect(document.querySelector(".fl-status")?.textContent).toContain(t.creative.errors.price_changed);
    await priceShown(150);
    runAnswer = () => json({ ok: true });
    await press();
    expect(body(1).max_credits).toBe(150);
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
  });
});

describe("a double press posts once", () => {
  it("two clicks on the confirm in the same tick send one request", async () => {
    show();
    await priceShown(120);
    make();
    const go = screen.getByRole("button", { name: t.create.confirm });
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
    confirm();
    fireEvent.keyDown(topic(), { key: "Enter" });
    expect(screen.queryByRole("button", { name: t.create.cancel })).toBeNull();
    await act(async () => release(new Response("{}", { status: 200 })));
    expect(runs()).toHaveLength(1);
  });
});
