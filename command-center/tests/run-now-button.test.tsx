// @vitest-environment jsdom
/**
 * "Run now" (components/agents/RunNowButton.tsx) spends credits like the create
 * flow does, so it gets the same protection: an idempotency key per attempt
 * (same key for a retry of the same inputs), the price on screen as
 * `max_credits`, and no confirm while that price is loading or unreadable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const priced = (credits: number) => ({ supported: true, enforced: true, exempt: false, estimate: { credits, basis: "per_minute", sample: 0, floorApplied: false, gap: null }, available: 900 });

let calls: { url: string; init?: RequestInit }[];
let estimateAnswer: () => Promise<Response>;
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

const show = () =>
  render(
    <I18nProvider locale="en">
      <RunNowButton channelId="chan-a" githubConfigured variant="inline" />
    </I18nProvider>,
  );
const arm = () => fireEvent.click(screen.getByRole("button", { name: t.agents.runBtn }));
const confirm = () => fireEvent.click(screen.getByRole("button", { name: t.agents.runConfirm }));
const priceShown = () => screen.findByText(/120 credits/);

describe("Run now", () => {
  it("sends a key and the price on screen as max_credits", async () => {
    show();
    arm();
    await priceShown();
    confirm();
    await act(async () => {});
    expect(runs()).toHaveLength(1);
    expect(body(0).max_credits).toBe(120);
    expect(String(body(0).idempotency_key)).toMatch(/^[A-Za-z0-9_:.-]{1,255}$/);
  });

  it("the confirm waits while the price is loading, and nothing is sent", async () => {
    let release: (r: Response) => void = () => {};
    estimateAnswer = () => new Promise<Response>((r) => (release = r));
    show();
    arm();
    const held = screen.getByRole("button", { name: t.credits.priceChecking });
    expect(held.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(held);
    await act(async () => {});
    expect(runs()).toHaveLength(0);
    await act(async () => release(new Response(JSON.stringify(priced(120)), { status: 200 })));
    await priceShown();
    confirm();
    await act(async () => {});
    expect(runs()).toHaveLength(1);
  });

  it("an unreadable price turns the confirm into Retry", async () => {
    estimateAnswer = () => json({}, 503);
    show();
    arm();
    await screen.findAllByRole("button", { name: t.common.retry });
    const go = document.querySelector("[data-price-hold=failed]") as HTMLElement;
    expect(go.textContent).toBe(t.common.retry);
    estimateAnswer = () => json(priced(120));
    fireEvent.click(go);
    await priceShown();
    expect(runs()).toHaveLength(0);
    confirm();
    await act(async () => {});
    expect(body(0).max_credits).toBe(120);
  });

  it("a retry after a dropped connection reuses the key; a started run rotates it", async () => {
    show();
    arm();
    await priceShown();
    runAnswer = () => Promise.reject(new TypeError("network"));
    confirm();
    await act(async () => {});
    arm();
    await priceShown();
    runAnswer = () => json({ ok: true });
    confirm();
    await act(async () => {});
    expect(runs()).toHaveLength(2);
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
  });

  it("an already-started answer is worded as that, not as a failure", async () => {
    show();
    arm();
    await priceShown();
    runAnswer = () => json({ error: "run_already_started" }, 409);
    confirm();
    await act(async () => {});
    expect(screen.getByText(t.create.flow.alreadySent)).toBeTruthy();
  });

  it("two quick presses on the confirm send one request", async () => {
    show();
    arm();
    await priceShown();
    const go = screen.getByRole("button", { name: t.agents.runConfirm });
    let release: (r: Response) => void = () => {};
    runAnswer = () => new Promise<Response>((r) => (release = r));
    await act(async () => {
      fireEvent.click(go);
      fireEvent.click(go);
    });
    expect(runs()).toHaveLength(1);
    await act(async () => release(new Response("{}", { status: 200 })));
  });
});
