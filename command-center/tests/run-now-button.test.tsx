// @vitest-environment jsdom
/**
 * "Run now" (components/agents/RunNowButton.tsx) spends credits like the create
 * flow does, so it gets the same protection: an idempotency key per intent (the
 * same key for a double click, a retry or a reload of the same inputs), the
 * price on screen as `max_credits`, no confirm while that price is loading or
 * unreadable, and every answer said with whether credits were taken or held.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/chronos/agents" }));
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
import { RunNowButton } from "@/components/agents/RunNowButton";

const t = dictionaries.en;
const f = t.create.flow;
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const priced = (credits: number) => ({ supported: true, enforced: true, exempt: false, estimate: { credits, basis: "per_minute", sample: 0, floorApplied: false, gap: null }, available: 900 });

let calls: { url: string; init?: RequestInit }[];
let estimateAnswer: () => Promise<Response>;
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
      if (String(url).startsWith("/api/credits/estimate")) return estimateAnswer();
      if (String(url).startsWith("/api/agent/run")) return runAnswer();
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view = (channelId = "chan-a") => (
  <I18nProvider locale="en">
    <RunNowButton channelId={channelId} githubConfigured variant="inline" />
  </I18nProvider>
);
const show = (channelId = "chan-a") => render(view(channelId));
const arm = () => fireEvent.click(screen.getByRole("button", { name: t.agents.runBtn }));
// Held ("Checking the price…") until the estimate line has reported; wait for the real confirm.
const confirm = async () => fireEvent.click(await screen.findByRole("button", { name: t.agents.runConfirm }));
const priceShown = () => screen.findByText(/120 credits/);
async function press() {
  arm();
  await priceShown();
  await confirm();
  await act(async () => {});
}
const said = () => document.querySelector("span[aria-live=polite]")?.textContent ?? "";

describe("Run now", () => {
  it("sends a key and the price on screen as max_credits", async () => {
    show();
    await press();
    expect(runs()).toHaveLength(1);
    expect(body(0).max_credits).toBe(120);
    expect(String(body(0).idempotency_key)).toMatch(/^[A-Za-z0-9_:.-]{1,255}$/);
  });

  it("while the estimate is pending the confirm is disabled and named 'Checking the price…', then it is the real confirm", async () => {
    let release: (r: Response) => void = () => {};
    estimateAnswer = () => new Promise<Response>((r) => (release = r));
    show();
    arm();
    const held = await screen.findByRole("button", { name: t.credits.priceChecking });
    expect(held.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(held);
    await act(async () => {});
    expect(runs()).toHaveLength(0);
    await act(async () => release(new Response(JSON.stringify(priced(120)), { status: 200 })));
    await priceShown();
    await confirm();
    await act(async () => {});
    expect(runs()).toHaveLength(1);
    expect(body(0).max_credits).toBe(120);
  });

  it("an unreadable estimate turns the confirm into Retry and nothing is sent", async () => {
    estimateAnswer = () => json({}, 503);
    show();
    arm();
    await waitFor(() => expect(document.querySelector("button[data-price-hold=failed]")).not.toBeNull());
    estimateAnswer = () => json(priced(120));
    fireEvent.click(document.querySelector("button[data-price-hold=failed]") as HTMLElement);
    await priceShown();
    expect(runs()).toHaveLength(0);
    await confirm();
    await act(async () => {});
    expect(body(0).max_credits).toBe(120);
  });

  it("a double click on the confirm posts once", async () => {
    show();
    arm();
    await priceShown();
    const go = await screen.findByRole("button", { name: t.agents.runConfirm });
    let release: (r: Response) => void = () => {};
    runAnswer = () => new Promise<Response>((r) => (release = r));
    await act(async () => {
      fireEvent.click(go);
      fireEvent.click(go);
    });
    expect(runs()).toHaveLength(1);
    await act(async () => release(new Response("{}", { status: 200 })));
    expect(runs()).toHaveLength(1);
  });

  it("a retry after a dropped connection reuses the key; a started run settles it so the next one is new", async () => {
    show();
    runAnswer = () => Promise.reject(new TypeError("network"));
    await press();
    expect(said()).toContain(f.startUnsure);
    runAnswer = () => json({ ok: true });
    await press();
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
    expect(said()).toContain(t.agents.runQueued);
    await press();
    expect(body(2).idempotency_key).not.toBe(body(1).idempotency_key);
  });

  it("one channel's key is not used for another channel", async () => {
    const r = show("chan-a");
    runAnswer = () => json({ error: "credit_reserve_failed" }, 502);
    await press();
    r.rerender(view("chan-b"));
    await press();
    expect(body(1).channel_id).toBe("chan-b");
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("price_changed says the new price and that nothing was taken or held; the next confirm shows and sends the new price under the same key (nothing was held)", async () => {
    show();
    runAnswer = () => json({ error: "price_changed", credits: 150 }, 409);
    await press();
    expect(said()).toContain("150");
    expect(said()).toContain(f.notTaken);
    estimateAnswer = () => json(priced(150));
    runAnswer = () => json({ ok: true });
    arm();
    await screen.findByText(/150 credits/);
    await confirm();
    await act(async () => {});
    expect(body(1).max_credits).toBe(150);
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
  });

  it("price_changed on a retry after a lost answer does not claim nothing was held, and the key is kept", async () => {
    show();
    runAnswer = () => Promise.reject(new TypeError("network"));
    await press();
    runAnswer = () => json({ error: "price_changed", credits: 150 }, 409);
    await press();
    expect(said()).toContain(f.priceChangedUnsure.replace("{n}", "150"));
    expect(said()).not.toContain(f.notTaken);
    estimateAnswer = () => json(priced(150));
    runAnswer = () => json({ error: "run_already_started" }, 409);
    arm();
    await screen.findByText(/150 credits/);
    await confirm();
    await act(async () => {});
    expect(said()).toContain(f.alreadySent);
    expect(new Set([0, 1, 2].map((i) => body(i).idempotency_key)).size).toBe(1);
  });

  it("run_already_started is shown as started, not as a failure", async () => {
    show();
    runAnswer = () => json({ error: "run_already_started" }, 409);
    await press();
    expect(said()).toContain(f.alreadySent);
    expect(said()).not.toContain(t.agents.runFailed);
  });

  it("run_limit and insufficient credits say nothing was taken or held; a hold that did not start says it is held and comes back", async () => {
    show();
    runAnswer = () => json({ error: "run_limit", active: 1, limit: 1 }, 429);
    await press();
    expect(said()).toContain(f.notTaken);
    runAnswer = () => json({ error: "insufficient_credits", needed: 120, available: 5 }, 402);
    await press();
    expect(said()).toContain(f.notTaken);
    expect(said()).toContain("120");
    runAnswer = () => json({ error: "github_dispatch_failed", credits_held: 120 }, 502);
    await press();
    expect(said()).toContain("120");
    expect(said()).toContain("3 hours");
    expect(said()).not.toContain(f.notTaken);
    // The first two kept the key; the hold settled it.
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
    expect(body(2).idempotency_key).toBe(body(0).idempotency_key);
    runAnswer = () => json({ ok: true });
    await press();
    expect(body(3).idempotency_key).not.toBe(body(2).idempotency_key);
  });
});
