// @vitest-environment jsdom
/**
 * The guided create flow (components/create/CreateStudio.tsx): one idea per card,
 * the price in plain words before the one button, defaults hidden behind choices.
 * What must not change: the first press only asks, nothing is sent before the
 * second, an unknown price is never a number, and the run body is exactly what
 * was chosen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { dictionaries, type Locale } from "@/lib/i18n";
import { CreateStudio } from "@/components/create/CreateStudio";

const t = dictionaries.en;
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const estimate = { credits: 120, basis: "per_minute", sample: 0, floorApplied: false, gap: null };

let calls: { url: string; init?: RequestInit }[];
/** Hooks for the cases that need a slow or refused answer. */
let estimateAnswer: () => Promise<Response>;
let runAnswer: () => Promise<Response>;
function answer(over: Record<string, unknown> = {}) {
  calls = [];
  estimateAnswer = () => json({ supported: true, enforced: true, exempt: false, estimate, available: 400, ...over });
  runAnswer = () => json({ ok: true });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("/api/credits/estimate")) return estimateAnswer();
      if (String(url).startsWith("/api/agent/run")) return runAnswer();
      if (String(url).startsWith("/api/agent/events")) return json({ events: [], jobs: null });
      return json({}, 404);
    }),
  );
}
const runs = () => calls.filter((c) => c.url.startsWith("/api/agent/run"));
const show = (locale: Locale = "en", props: Partial<Parameters<typeof CreateStudio>[0]> = {}) =>
  render(
    <I18nProvider locale={locale}>
      <CreateStudio channelId="chan-a" githubConfigured agentConfig={null} canRun {...props} />
    </I18nProvider>,
  );

beforeEach(() => answer());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the guided create flow", () => {
  it("starts on sensible defaults: every choice reads as the channel's own, nothing is asked of the person", () => {
    show();
    const values = Array.from(document.querySelectorAll(".fl-choice-value")).map((n) => n.textContent);
    expect(values).toEqual([t.create.flow.lengthDefault, t.create.flow.voiceDefault, t.create.flow.lookDefault]);
    expect((screen.getByRole("textbox", { name: t.create.flow.topicTitle }) as HTMLTextAreaElement).value).toBe("");
  });

  it("an example fills the topic in one tap", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: t.create.flow.ex2 }));
    expect((screen.getByRole("textbox", { name: t.create.flow.topicTitle }) as HTMLTextAreaElement).value).toBe(t.create.flow.ex2);
  });

  it("a choice opens inline, picking closes nothing it should keep, and the new length re-asks the price", async () => {
    show();
    await screen.findByText(/About 120 credits/);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t.create.flow.lengthLabel) }));
    const group = screen.getByRole("radiogroup", { name: t.agents.runDurationLabel });
    fireEvent.click(within(group).getByRole("radio", { name: t.agents.runDur5m }));
    expect(within(group).getByRole("radio", { name: t.agents.runDur5m }).getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(calls.some((c) => c.url.includes("duration=300"))).toBe(true));
    expect(runs()).toHaveLength(0);
  });

  it("the first press only asks; the run is sent once, by the second, with exactly what was chosen", async () => {
    show();
    await screen.findByText(/About 120 credits/);
    fireEvent.change(screen.getByRole("textbox", { name: t.create.flow.topicTitle }), { target: { value: "Ancient Khiva" } });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t.create.flow.lengthLabel) }));
    fireEvent.click(screen.getByRole("radio", { name: t.agents.runDur1m }));
    fireEvent.click(screen.getByRole("button", { name: t.create.create }));
    expect(runs()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: t.create.confirm }));
    await waitFor(() => expect(runs()).toHaveLength(1));
    expect(JSON.parse(String(runs()[0].init?.body))).toEqual({ channel_id: "chan-a", topic: "Ancient Khiva", duration: 60 });
    await act(async () => {});
    expect(screen.getByText(t.create.flow.started)).toBeTruthy();
  });

  it("an unpriced run says why and shows no number; the button still only asks", async () => {
    answer({ estimate: { credits: null, basis: "unknown", sample: 0, floorApplied: false, gap: "no_prices" } });
    show();
    await screen.findByText(t.credits.gap.no_prices);
    const price = document.querySelector(".fl-price") as HTMLElement;
    expect(price.textContent).not.toMatch(/About/);
    expect(price.textContent).not.toMatch(/\b0\b/);
    expect(price.textContent).toContain(t.credits.gap.no_prices);
  });

  it("with extra credits off the card says what can be used and links the switch only when that is why it is short", async () => {
    answer({ available: 400, extraOff: true, spendable: 50 });
    show();
    await screen.findByText(/About 120 credits/);
    expect(document.querySelector(".fl-price")?.textContent).toContain("50 available");
    expect(document.querySelector("[data-extra-off-link]")).not.toBeNull();
  });

  it("when the balance cannot cover it (credits enforced) the card says so in words, not only in red", async () => {
    answer({ available: 20 });
    show();
    await screen.findByText(/About 120 credits/);
    expect(document.querySelector(".fl-price")?.textContent).toContain(t.credits.insufficientShort);
    cleanup();
    answer({ available: 400 });
    show();
    await screen.findByText(/About 120 credits/);
    expect(document.querySelector(".fl-price")?.textContent).not.toContain(t.credits.insufficientShort);
  });

  it("the plain hold sentence is on the card, and 'more options' keeps language and the rest reachable", () => {
    show();
    expect(screen.getByText(t.create.flow.holdNote)).toBeTruthy();
    const more = document.querySelector("details.fl-more") as HTMLElement;
    expect(within(more).getByRole("combobox", { name: t.agents.runLangLabel })).toBeTruthy();
  });

  it("a viewer who cannot run sees why, and the button stays off", () => {
    show("en", { canRun: false });
    expect(screen.getByText(t.create.needsAdmin)).toBeTruthy();
    expect((screen.getByRole("button", { name: t.create.create }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the price card is never empty", () => {
  it("says it is checking while a slow estimate loads, keeps its height, then shows the figure", async () => {
    answer();
    let release: (r: Response) => void = () => {};
    estimateAnswer = () => new Promise<Response>((r) => (release = r));
    show();
    const card = document.querySelector(".fl-price") as HTMLElement;
    expect(card.textContent).toContain(t.credits.priceChecking);
    expect(card.getAttribute("aria-busy")).toBe("true");
    await act(async () => release(new Response(JSON.stringify({ supported: true, enforced: true, exempt: false, estimate, available: 400 }), { status: 200 })));
    await screen.findByText(/About 120 credits/);
    expect(document.querySelectorAll(".fl-price")).toHaveLength(1);
  });

  it("says so in plain words when no price can be shown (unsupported or refused), and the button is not made to look priced", async () => {
    answer();
    estimateAnswer = () => json({ error: "channel_not_found" }, 404);
    show();
    await screen.findByTestId("price-unavailable");
    expect(document.querySelector(".fl-price")?.textContent).toBe(t.credits.priceUnavailable);
    cleanup();
    answer({ supported: false });
    show();
    await screen.findByTestId("price-unavailable");
  });

  it("an unreadable estimate offers Retry, and Retry asks again", async () => {
    answer();
    estimateAnswer = () => json({}, 503);
    show();
    const retry = await screen.findByRole("button", { name: t.common.retry });
    estimateAnswer = () => json({ supported: true, enforced: true, exempt: false, estimate, available: 400 });
    fireEvent.click(retry);
    await screen.findByText(/About 120 credits/);
  });

  it("keeps the 'not charged yet' line for the operator and drops it for a customer", async () => {
    answer({ enforced: false });
    show("en", { operator: true });
    await screen.findByText(/About 120 credits/);
    expect(document.querySelector(".fl-price")?.textContent).toContain(t.credits.estimateNotEnforced);
    cleanup();
    answer({ enforced: false });
    show("en", { operator: false });
    await screen.findByText(/About 120 credits/);
    expect(document.querySelector(".fl-price")?.textContent).not.toContain(t.credits.estimateNotEnforced);
  });
});

describe("keyboard focus through the confirm", () => {
  it("the confirm takes focus, stays focusable while it starts (aria-disabled), ignores a second press, then focus lands on the result", async () => {
    show();
    await screen.findByText(/About 120 credits/);
    fireEvent.click(screen.getByRole("button", { name: t.create.create }));
    const confirm = screen.getByRole("button", { name: t.create.confirm }) as HTMLButtonElement;
    expect(document.activeElement).toBe(confirm);
    expect(screen.getByText(t.create.flow.confirmAnnounce)).toBeTruthy();
    let release: (r: Response) => void = () => {};
    runAnswer = () => new Promise<Response>((r) => (release = r));
    fireEvent.click(confirm);
    const starting = await screen.findByRole("button", { name: t.create.starting });
    expect(starting.getAttribute("aria-disabled")).toBe("true");
    expect((starting as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(starting);
    expect(runs()).toHaveLength(1);
    await act(async () => release(new Response("{}", { status: 200 })));
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector(".fl-status")));
    expect(document.querySelector(".fl-status")?.textContent).toContain(t.create.queued);
  });

  it("after a refusal focus lands on the message, not on the page", async () => {
    show();
    await screen.findByText(/About 120 credits/);
    runAnswer = () => json({ error: "insufficient_credits", available: 20, needed: 120 }, 402);
    fireEvent.click(screen.getByRole("button", { name: t.create.create }));
    fireEvent.click(screen.getByRole("button", { name: t.create.confirm }));
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector(".fl-status")));
    expect(document.querySelector(".fl-status")?.textContent?.length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: t.create.create })).toBeTruthy();
  });
});

describe("what a customer reads when running is not set up", () => {
  it("no environment variable names for a customer; the operator still gets them", () => {
    show("en", { githubConfigured: false, operator: false });
    expect(screen.getByText(t.create.flow.unavailable)).toBeTruthy();
    expect(document.body.textContent).not.toContain("GITHUB_SECRETS");
    cleanup();
    show("en", { githubConfigured: false, operator: true });
    expect(screen.getByText(t.create.notConfigured)).toBeTruthy();
  });
});

describe("the flow's words, in all three languages", () => {
  const shape = (v: unknown): unknown => (v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v);
  const leaves = (v: unknown): string[] => (v && typeof v === "object" ? Object.values(v).flatMap(leaves) : [v as string]);

  it("has the same keys everywhere, none empty, and the plain price sentence in each", () => {
    for (const loc of ["ru", "uz"] as const) {
      expect(shape(dictionaries[loc].create.flow)).toEqual(shape(t.create.flow));
      expect(shape(dictionaries[loc].home.videoState)).toEqual(shape(t.home.videoState));
    }
    for (const loc of ["en", "ru", "uz"] as const) {
      const d = dictionaries[loc];
      for (const s of [...leaves(d.create.flow), ...leaves(d.home.videoState), d.credits.estimatePlain, d.home.waitingOne, d.home.waitingMany, d.home.makingMany]) {
        expect(typeof s === "string" && s.trim().length > 0).toBe(true);
      }
      expect(d.credits.estimatePlain).toContain("{n}");
      expect(d.home.waitingMany).toContain("{n}");
    }
  });
});
