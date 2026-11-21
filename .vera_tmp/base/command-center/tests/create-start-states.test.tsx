// @vitest-environment jsdom
/**
 * A keyed run that took a hold and then failed to START (draft #436, lib/server/run-start.ts):
 *  - `start_unsure` (may have started): the SAME key is kept, nothing is retried, and the
 *    `run_already_started` that a second press gets is NOT shown as a start;
 *  - `start_failed` (nothing started) while the credits are still held: the same intent cannot be
 *    sent again (the same key would answer a false "started", a new key would hold twice) until the
 *    hold returns; changing an input is a new intent. Only `retry_with_new_key` with `credits_held:
 *    false` (released) rotates to a new key.
 * Through the real forms (CreateStudio, RunNowButton), with the state surviving a reload of the tab.
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
import { RunNowButton } from "@/components/agents/RunNowButton";
import { ATTEMPT_PREFIX, clearAllCreateAttempts } from "@/lib/create-attempt-store";
import { MAX_PROTECTED_PER_SCOPE, HOLD_MAX_AGE_MS, createAttempt } from "@/lib/create-attempt";

const t = dictionaries.en;
const f = t.create.flow;
const USER = "5b0c2f6e-1d44-4c2e-9b1f-0a7e2d9c3e11";
const TOPIC = "Ancient Khiva";
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const priced = (credits: number) => ({ supported: true, enforced: true, exempt: false, estimate: { credits, basis: "per_minute", sample: 0, floorApplied: false, gap: null }, available: 900 });
const START_UNSURE = { error: "start_unsure", reason: "github_dispatch_failed", credits_held: 120 };
const START_FAILED_HELD = { error: "start_failed", reason: "github_unauthorized", credits_held: 120, retry_with_new_key: true };
const START_FAILED_RELEASED = { error: "start_failed", reason: "github_unauthorized", credits_held: false, retry_with_new_key: true };

let calls: { url: string; init?: RequestInit }[];
let runAnswer: () => Promise<Response>;
const runs = () => calls.filter((c) => c.url.startsWith("/api/agent/run"));
const body = (i: number) => JSON.parse(String(runs()[i].init?.body)) as Record<string, unknown>;
const storedNames = () => Array.from({ length: window.sessionStorage.length }, (_, i) => window.sessionStorage.key(i) as string).filter((k) => k.startsWith(ATTEMPT_PREFIX));

beforeEach(() => {
  calls = [];
  window.sessionStorage.clear();
  runAnswer = () => json({ ok: true });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("/api/credits/estimate")) return json(priced(120));
      if (String(url).startsWith("/api/agent/run")) return runAnswer();
      if (String(url).startsWith("/api/agent/events")) return json({ events: [], jobs: null });
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearAllCreateAttempts();
});

describe("Create", () => {
  type Who = { channelId?: string; userId?: string; orgId?: string | null };
  const studio = (o: Who = {}) => (
    <I18nProvider locale="en">
      <CreateStudio channelId={o.channelId ?? "chan-a"} githubConfigured agentConfig={null} canRun userId={o.userId ?? USER} orgId={o.orgId === undefined ? "org-1" : o.orgId} />
    </I18nProvider>
  );
  const show = (o: Who = {}) => render(studio(o));
  const topic = () => screen.getByRole("textbox", { name: f.topicTitle }) as HTMLTextAreaElement;
  const type = (v: string) => fireEvent.change(topic(), { target: { value: v } });
  const makeBtn = () => screen.getByRole("button", { name: t.create.create }) as HTMLButtonElement;
  const make = () => fireEvent.click(makeBtn());
  const confirm = async () => fireEvent.click(await screen.findByRole("button", { name: t.create.confirm }));
  const priceShown = () => screen.findByText(/About 120 credits/);
  const status = () => document.querySelector(".fl-status")?.textContent ?? "";
  async function press() {
    make();
    await confirm();
    await act(async () => {});
  }
  /** Opens the form on an intent and presses once with this answer. */
  async function first(answer: () => Promise<Response>, who: Who = {}, text = TOPIC) {
    const view = show(who);
    await priceShown();
    type(text);
    runAnswer = answer;
    await press();
    return view;
  }

  it("start_unsure: says it may have started with the amount held; the second press sends the SAME key, and its run_already_started is not shown as a start", async () => {
    await first(() => json(START_UNSURE, 502));
    expect(status()).toBe(f.startUnsureHeld.replace("{n}", "120"));
    expect(makeBtn().disabled).toBe(false);
    // No automatic retry: one request so far.
    expect(runs()).toHaveLength(1);
    runAnswer = () => json({ error: "run_already_started" }, 409);
    await press();
    expect(runs()).toHaveLength(2);
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
    expect(status()).toBe(f.startUnsureReplay);
    expect(status()).not.toContain(f.alreadySent);
    expect(status()).not.toContain(t.create.queued);
    expect(screen.queryByText(f.watchTitle)).toBeNull();
    // And again: the same key, the same honest sentence, never a new hold.
    await press();
    expect(runs()).toHaveLength(3);
    expect(body(2).idempotency_key).toBe(body(0).idempotency_key);
  });

  it("start_failed with credits held: the intent is blocked (button disabled, no request on press or Enter), and the notice says what is held", async () => {
    await first(() => json(START_FAILED_HELD, 502));
    expect(status()).toBe(f.startFailedHeld.replace("{n}", "120"));
    expect(makeBtn().disabled).toBe(true);
    fireEvent.click(makeBtn());
    fireEvent.keyDown(topic(), { key: "Enter" });
    await act(async () => {});
    expect(screen.queryByRole("button", { name: t.create.confirm })).toBeNull();
    expect(runs()).toHaveLength(1);
  });

  it("changing the topic is a new intent: not blocked, the old notice is gone, and it gets a new key; typing the old topic back (before sending) is blocked again", async () => {
    await first(() => json(START_FAILED_HELD, 502));
    type("The Aral Sea");
    expect(makeBtn().disabled).toBe(false);
    expect(status()).toBe("");
    type(TOPIC);
    expect(makeBtn().disabled).toBe(true);
    expect(status()).toBe(f.startFailedHeld.replace("{n}", "120"));
    type("The Aral Sea");
    runAnswer = () => json({ ok: true });
    await press();
    expect(runs()).toHaveLength(2);
    expect(body(1).topic).toBe("The Aral Sea");
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("changing an option (length) is a new intent as well", async () => {
    await first(() => json(START_FAILED_HELD, 502));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(f.lengthLabel) }));
    fireEvent.click(screen.getByRole("radio", { name: t.agents.runDur5m }));
    await waitFor(() => expect(makeBtn().disabled).toBe(false));
    runAnswer = () => json({ ok: true });
    await press();
    expect(body(1).duration).toBe(300);
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  it("a new intent that meets the plan's run limit or a short balance gets the existing messages", async () => {
    await first(() => json(START_FAILED_HELD, 502));
    type("The Aral Sea");
    runAnswer = () => json({ error: "run_limit", active: 1, limit: 1 }, 429);
    await press();
    expect(status()).toContain(f.notTaken);
    expect(status()).toContain(t.credits.runLimit.replace("{n}", "1"));
    runAnswer = () => json({ error: "insufficient_credits", needed: 120, available: 5 }, 402);
    await press();
    expect(status()).toContain(f.notTaken);
    expect(status()).toContain("120");
  });

  it("start_failed with the hold released and retry_with_new_key: not blocked, and the next press is a NEW key", async () => {
    await first(() => json(START_FAILED_RELEASED, 502));
    expect(status()).toBe(f.startFailedReleased);
    expect(makeBtn().disabled).toBe(false);
    runAnswer = () => json({ ok: true });
    await press();
    expect(runs()).toHaveLength(2);
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
    expect(status()).toContain(t.create.queued);
  });

  describe("after a reload of the tab", () => {
    it("start_unsure comes back: the same key, and a replay is still the honest sentence", async () => {
      const view = await first(() => json(START_UNSURE, 502));
      view.unmount();
      show();
      await priceShown();
      type(TOPIC);
      runAnswer = () => json({ error: "run_already_started" }, 409);
      await press();
      expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
      expect(status()).toBe(f.startUnsureReplay);
    });

    it("start_failed with credits held comes back blocked: the notice is there before any press and nothing is sent", async () => {
      const view = await first(() => json(START_FAILED_HELD, 502));
      view.unmount();
      show();
      await priceShown();
      type(TOPIC);
      expect(makeBtn().disabled).toBe(true);
      expect(status()).toBe(f.startFailedHeld.replace("{n}", "120"));
      fireEvent.click(makeBtn());
      await act(async () => {});
      expect(runs()).toHaveLength(1);
      // What is stored is the amount and a hash, not the topic.
      const raw = String(window.sessionStorage.getItem(storedNames()[0]));
      expect(JSON.parse(raw)).toMatchObject({ v: 1, b: 120 });
      expect(raw).not.toContain("Khiva");
    });

    it("another user, organization or channel is not blocked and gets its own key", async () => {
      const view = await first(() => json(START_FAILED_HELD, 502));
      view.unmount();
      for (const who of [{ userId: "second-user" }, { orgId: "org-2" }, { channelId: "chan-b" }] satisfies Who[]) {
        const v = show(who);
        await priceShown();
        type(TOPIC);
        expect(makeBtn().disabled, JSON.stringify(who)).toBe(false);
        expect(status()).toBe("");
        v.unmount();
      }
      show({ channelId: "chan-b" });
      await priceShown();
      type(TOPIC);
      runAnswer = () => json({ ok: true });
      await press();
      expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
    });

    it("a blocked intent is free again once its hold has returned (three hours)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
        const view = await first(() => json(START_FAILED_HELD, 502));
        view.unmount();
        vi.setSystemTime(new Date("2026-10-13T12:30:00Z"));
        show();
        await priceShown();
        type(TOPIC);
        expect(makeBtn().disabled).toBe(true);
        cleanup();
        vi.setSystemTime(new Date("2026-10-13T13:01:00Z"));
        show();
        await priceShown();
        type(TOPIC);
        expect(makeBtn().disabled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("a late answer of an earlier attempt, arriving after the intent changed, says nothing about the new one and cannot block or settle it", async () => {
    show();
    await priceShown();
    type(TOPIC);
    let release: (r: Response) => void = () => {};
    runAnswer = () => new Promise<Response>((r) => (release = r));
    make();
    await confirm();
    // While it is on its way the person changes the request.
    type("The Aral Sea");
    await act(async () => release(new Response(JSON.stringify(START_FAILED_HELD), { status: 502 })));
    // Nothing is said about the new intent, and it is not blocked.
    expect(status()).toBe("");
    expect(makeBtn().disabled).toBe(false);
    // The late answer was recorded against the old intent: typing it back finds it waiting for its hold.
    type(TOPIC);
    expect(makeBtn().disabled).toBe(true);
    type("The Aral Sea");
    runAnswer = () => json({ ok: true });
    await press();
    expect(runs()).toHaveLength(2);
    expect(body(1).topic).toBe("The Aral Sea");
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
    expect(status()).toContain(t.create.queued);
  });

  it("a late refusal of an earlier attempt does not put its message on the new intent", async () => {
    show();
    await priceShown();
    type(TOPIC);
    let release: (r: Response) => void = () => {};
    runAnswer = () => new Promise<Response>((r) => (release = r));
    make();
    await confirm();
    type("The Aral Sea");
    await act(async () => release(new Response(JSON.stringify({ error: "insufficient_credits", needed: 120, available: 5 }), { status: 402 })));
    expect(status()).toBe("");
    expect(makeBtn().disabled).toBe(false);
  });

  it("a late answer that is a dropped connection marks the OLD intent unsure, not the new one", async () => {
    show();
    await priceShown();
    type(TOPIC);
    let fail: (e: unknown) => void = () => {};
    runAnswer = () => new Promise<Response>((_, rej) => (fail = rej));
    make();
    await confirm();
    type("The Aral Sea");
    await act(async () => fail(new TypeError("network")));
    expect(status()).toBe("");
    runAnswer = () => json({ error: "run_already_started" }, 409);
    await press();
    // The new intent was not unsure, so a replay there is the plain start it always was.
    expect(status()).toContain(f.alreadySent);
  });

  describe("each intent is remembered on its own (sending another one does not forget the first)", () => {
    it("block topic A -> edit to B and send it (refused, or started and reloaded) -> back to A: A is still blocked, nothing is sent", async () => {
      await first(() => json(START_FAILED_HELD, 502));
      type("The Aral Sea");
      runAnswer = () => json({ error: "insufficient_credits", needed: 120, available: 5 }, 402);
      await press();
      expect(runs()).toHaveLength(2);
      expect(body(1).topic).toBe("The Aral Sea");
      // Edit back to A: still waiting for its hold.
      type(TOPIC);
      expect(makeBtn().disabled).toBe(true);
      expect(status()).toBe(f.startFailedHeld.replace("{n}", "120"));
      fireEvent.click(makeBtn());
      fireEvent.keyDown(topic(), { key: "Enter" });
      await act(async () => {});
      expect(runs()).toHaveLength(2);
      // B starts; the tab is reloaded and A typed again: still blocked.
      type("The Aral Sea");
      runAnswer = () => json({ ok: true });
      await press();
      expect(runs()).toHaveLength(3);
      cleanup();
      show();
      await priceShown();
      type(TOPIC);
      expect(makeBtn().disabled).toBe(true);
      expect(status()).toBe(f.startFailedHeld.replace("{n}", "120"));
      fireEvent.click(makeBtn());
      await act(async () => {});
      expect(runs()).toHaveLength(3);
      // B started and is settled: it is free to be made again, with a new key.
      type("The Aral Sea");
      expect(makeBtn().disabled).toBe(false);
    });

    it("unsure A -> send B -> back to A: the SAME key goes out, and its replay is still the honest sentence (also after a reload)", async () => {
      await first(() => json(START_UNSURE, 502));
      type("The Aral Sea");
      runAnswer = () => json({ error: "insufficient_credits", needed: 120, available: 5 }, 402);
      await press();
      type(TOPIC);
      runAnswer = () => json({ error: "run_already_started" }, 409);
      await press();
      expect(runs()).toHaveLength(3);
      expect(body(2).idempotency_key).toBe(body(0).idempotency_key);
      expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
      expect(status()).toBe(f.startUnsureReplay);
      // B starts, the tab is reloaded, A again.
      type("The Aral Sea");
      runAnswer = () => json({ ok: true });
      await press();
      cleanup();
      show();
      await priceShown();
      type(TOPIC);
      runAnswer = () => json({ error: "run_already_started" }, 409);
      await press();
      expect(body(4).idempotency_key).toBe(body(0).idempotency_key);
      expect(status()).toBe(f.startUnsureReplay);
    });
  });

  describe("a late success after the form was edited", () => {
    async function pendingThenEdit() {
      show();
      await priceShown();
      type(TOPIC);
      let release: (r: Response) => void = () => {};
      runAnswer = () => new Promise<Response>((r) => (release = r));
      make();
      await confirm();
      type("The Aral Sea");
      return (r: Response) => act(async () => release(r));
    }

    it("a late 200 says nothing about the edited form and does not disable Make; the edited form sends with its own key", async () => {
      const answer = await pendingThenEdit();
      await answer(new Response("{}", { status: 200 }));
      expect(status()).toBe("");
      expect(screen.queryByText(f.watchTitle)).toBeNull();
      expect(makeBtn().disabled).toBe(false);
      runAnswer = () => json({ ok: true });
      await press();
      expect(runs()).toHaveLength(2);
      expect(body(1).topic).toBe("The Aral Sea");
      expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
      expect(status()).toContain(t.create.queued);
    });

    it("a late run_already_started is the same: no message, Make stays enabled", async () => {
      const answer = await pendingThenEdit();
      await answer(new Response(JSON.stringify({ error: "run_already_started" }), { status: 409 }));
      expect(status()).toBe("");
      expect(makeBtn().disabled).toBe(false);
    });

    it("the key of the intent that started is settled: sending it again is a new key", async () => {
      const answer = await pendingThenEdit();
      await answer(new Response("{}", { status: 200 }));
      type(TOPIC);
      runAnswer = () => json({ ok: true });
      await press();
      expect(body(1).topic).toBe(TOPIC);
      expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
    });

    it("without an edit the start is shown as always", async () => {
      show();
      await priceShown();
      type(TOPIC);
      await press();
      expect(status()).toContain(t.create.queued);
    });
  });

  describe("storage denied", () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    const deny = () =>
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        get: () => {
          throw new Error("denied");
        },
      });
    afterEach(() => {
      if (original) Object.defineProperty(window, "sessionStorage", original);
    });

    it("behaves in memory: unsure keeps the key and blocked blocks within the page, and a reload forgets both", async () => {
      deny();
      const view = await first(() => json(START_UNSURE, 502));
      runAnswer = () => json({ error: "run_already_started" }, 409);
      await press();
      expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
      expect(status()).toBe(f.startUnsureReplay);
      type("The Aral Sea");
      runAnswer = () => json(START_FAILED_HELD, 502);
      await press();
      expect(makeBtn().disabled).toBe(true);
      expect(status()).toBe(f.startFailedHeld.replace("{n}", "120"));
      view.unmount();
      show();
      await priceShown();
      type("The Aral Sea");
      expect(makeBtn().disabled).toBe(false);
    });
  });
});

describe("Run now", () => {
  const view = (o: { userId?: string; channelId?: string } = {}) => (
    <I18nProvider locale="en">
      <RunNowButton channelId={o.channelId ?? "chan-a"} githubConfigured variant="inline" userId={o.userId ?? USER} orgId="org-1" />
    </I18nProvider>
  );
  const arm = () => fireEvent.click(screen.getByRole("button", { name: t.agents.runBtn }));
  const confirm = async () => fireEvent.click(await screen.findByRole("button", { name: t.agents.runConfirm }));
  async function press() {
    arm();
    await screen.findByText(/120 credits/);
    await confirm();
    await act(async () => {});
  }
  const said = () => document.querySelector("span[aria-live=polite]")?.textContent ?? "";
  const runBtn = () => screen.getByRole("button", { name: t.agents.runBtn }) as HTMLButtonElement;

  it("start_unsure keeps the key; the replay after it is the honest sentence, not a start", async () => {
    render(view());
    runAnswer = () => json(START_UNSURE, 502);
    await press();
    expect(said()).toBe(f.startUnsureHeld.replace("{n}", "120"));
    runAnswer = () => json({ error: "run_already_started" }, 409);
    await press();
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
    expect(said()).toBe(f.startUnsureReplay);
    expect(said()).not.toContain(t.agents.runQueued);
  });

  it("start_failed with credits held blocks the button and survives a reload; another user is not blocked", async () => {
    const first = render(view());
    runAnswer = () => json(START_FAILED_HELD, 502);
    await press();
    expect(said()).toBe(f.startFailedHeld.replace("{n}", "120"));
    expect(runBtn().disabled).toBe(true);
    first.unmount();
    const again = render(view());
    expect(runBtn().disabled).toBe(true);
    expect(said()).toBe(f.startFailedHeld.replace("{n}", "120"));
    fireEvent.click(runBtn());
    await act(async () => {});
    expect(runs()).toHaveLength(1);
    again.unmount();
    render(view({ userId: "second-user" }));
    expect(runBtn().disabled).toBe(false);
    expect(said()).toBe("");
  });

  it("start_failed released with retry_with_new_key lets the next press use a new key", async () => {
    render(view());
    runAnswer = () => json(START_FAILED_RELEASED, 502);
    await press();
    expect(said()).toBe(f.startFailedReleased);
    expect(runBtn().disabled).toBe(false);
    runAnswer = () => json({ ok: true });
    await press();
    expect(body(1).idempotency_key).not.toBe(body(0).idempotency_key);
  });

  describe("the panel, with a topic that can be edited while a run is on its way", () => {
    const panel = () => (
      <I18nProvider locale="en">
        <RunNowButton channelId="chan-a" githubConfigured userId={USER} orgId="org-1" />
      </I18nProvider>
    );
    const topicInput = () => screen.getByLabelText(t.agents.runTopicLabel) as HTMLInputElement;
    const setTopic = (v: string) => fireEvent.change(topicInput(), { target: { value: v } });

    async function pending() {
      render(panel());
      setTopic(TOPIC);
      let release: (r: Response) => void = () => {};
      runAnswer = () => new Promise<Response>((r) => (release = r));
      arm();
      await screen.findByText(/120 credits/);
      await confirm();
      setTopic("The Aral Sea");
      return (r: Response) => act(async () => release(r));
    }

    it("block A, send B, back to A in the panel: still blocked", async () => {
      render(panel());
      setTopic(TOPIC);
      runAnswer = () => json(START_FAILED_HELD, 502);
      await press();
      expect(runBtn().disabled).toBe(true);
      setTopic("The Aral Sea");
      expect(runBtn().disabled).toBe(false);
      runAnswer = () => json({ ok: true });
      await press();
      // B started (the panel says so); A, typed back, is still waiting for its hold and sends nothing.
      setTopic(TOPIC);
      expect(runBtn().disabled).toBe(true);
      fireEvent.click(runBtn());
      await act(async () => {});
      expect(runs()).toHaveLength(2);
      cleanup();
      render(panel());
      setTopic(TOPIC);
      expect(runBtn().disabled).toBe(true);
      expect(said()).toBe(f.startFailedHeld.replace("{n}", "120"));
    });

    it("a late 200 or run_already_started after an edit says nothing about the edited form", async () => {
      let answer = await pending();
      await answer(new Response("{}", { status: 200 }));
      expect(said()).toBe("");
      expect(runBtn().disabled).toBe(false);
      cleanup();
      answer = await pending();
      await answer(new Response(JSON.stringify({ error: "run_already_started" }), { status: 409 }));
      expect(said()).toBe("");
    });
  });
});

describe("too many earlier requests are still waiting (fail-closed)", () => {
  const seedKeys: string[] = [];
  /** 32 unsure intents of this user/org/channel, as an earlier visit to the page would have left them. */
  function seed() {
    seedKeys.length = 0;
    const a = createAttempt();
    for (let i = 0; i < MAX_PROTECTED_PER_SCOPE; i++) {
      const k = a.keyFor(JSON.stringify({ channel_id: "chan-a", topic: `seed ${i}` }), { userId: USER, orgId: "org-1", channelId: "chan-a" });
      a.markUnsure(k);
      seedKeys.push(k);
    }
  }
  const studio = (locale: "en" | "ru" | "uz" = "en") => (
    <I18nProvider locale={locale}>
      <CreateStudio channelId="chan-a" githubConfigured agentConfig={null} canRun userId={USER} orgId="org-1" />
    </I18nProvider>
  );
  const topic = () => screen.getByRole("textbox", { name: f.topicTitle }) as HTMLTextAreaElement;
  const type = (v: string) => fireEvent.change(topic(), { target: { value: v } });
  const makeBtn = () => screen.getByRole("button", { name: t.create.create }) as HTMLButtonElement;
  const status = () => document.querySelector(".fl-status")?.textContent ?? "";

  it("a new request is refused with the message and no request; earlier ones stay replayable with their own key, also after a reload", async () => {
    seed();
    const view = render(studio());
    await screen.findByText(/About 120 credits/);
    type("a brand new video");
    expect(makeBtn().disabled).toBe(true);
    expect(status()).toBe(f.startTooMany);
    fireEvent.click(makeBtn());
    fireEvent.keyDown(topic(), { key: "Enter" });
    await act(async () => {});
    expect(runs()).toHaveLength(0);
    // An earlier, still-unsure request is not refused: its own key goes out and the replay is the honest sentence.
    type("seed 3");
    expect(makeBtn().disabled).toBe(false);
    expect(status()).toBe("");
    runAnswer = () => json({ error: "run_already_started" }, 409);
    fireEvent.click(makeBtn());
    fireEvent.click(await screen.findByRole("button", { name: t.create.confirm }));
    await act(async () => {});
    expect(runs()).toHaveLength(1);
    expect(body(0).idempotency_key).toBe(seedKeys[3]);
    expect(status()).toBe(f.startUnsureReplay);
    // Nothing was evicted: all 32 are still stored.
    expect(storedNames()).toHaveLength(MAX_PROTECTED_PER_SCOPE);
    // After a reload the same.
    view.unmount();
    render(studio());
    await screen.findByText(/About 120 credits/);
    type("a brand new video");
    expect(makeBtn().disabled).toBe(true);
    expect(status()).toBe(f.startTooMany);
    type("seed 31");
    expect(makeBtn().disabled).toBe(false);
  });

  it("the message reads in Russian and Uzbek too", async () => {
    for (const locale of ["ru", "uz"] as const) {
      seed();
      const view = render(studio(locale));
      await screen.findByRole("textbox", { name: dictionaries[locale].create.flow.topicTitle });
      fireEvent.change(screen.getByRole("textbox", { name: dictionaries[locale].create.flow.topicTitle }), { target: { value: "new" } });
      expect(document.querySelector(".fl-status")?.textContent).toBe(dictionaries[locale].create.flow.startTooMany);
      expect(dictionaries[locale].create.flow.startTooMany).not.toBe(f.startTooMany);
      view.unmount();
      window.sessionStorage.clear();
    }
  });

  it("when a protected request ages out (three hours) the form accepts a new one again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
      seed();
      vi.setSystemTime(new Date(Date.now() + HOLD_MAX_AGE_MS + 60 * 1000));
      render(studio());
      await screen.findByText(/About 120 credits/);
      type("a brand new video");
      expect(makeBtn().disabled).toBe(false);
      expect(status()).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Run now refuses a new request the same way", async () => {
    seed();
    render(
      <I18nProvider locale="en">
        <RunNowButton channelId="chan-a" githubConfigured variant="inline" userId={USER} orgId="org-1" />
      </I18nProvider>,
    );
    const btn = screen.getByRole("button", { name: t.agents.runBtn }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(document.querySelector("span[aria-live=polite]")?.textContent).toBe(f.startTooMany);
    fireEvent.click(btn);
    await act(async () => {});
    expect(runs()).toHaveLength(0);
  });
});
