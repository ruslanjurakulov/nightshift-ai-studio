// @vitest-environment jsdom
/**
 * The storyboard screen in a browser-like DOM (migration 0057).
 *
 * What would break without these: an Approve that spends without showing its
 * price, or sends a different price than the one on the button; a changed
 * price re-pressed for the person; a Discard with no confirmation; a person
 * who may not start runs offered a button the server would refuse; a page
 * that renders no price as "0 credits"; any provider name on the screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/x/videos/storyboard/1",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { fmt } from "@/lib/i18n";
import { StoryboardReview } from "@/components/storyboard/StoryboardReview";
import type { StoryboardQuote, StoryboardView } from "@/lib/storyboardReview";
import { PROVIDER_BRANDS } from "./helpers/brands";

const ts = en.storyboardReview;
const ID = "0b8f7a52-3f9c-4d1e-9b7a-1c2d3e4f5a6b";

const SB: StoryboardView = {
  id: ID,
  channelId: "chan-a",
  slug: "the-lighthouse",
  topic: "The Lighthouse",
  title: "The Last Lighthouse",
  scenes: [
    { n: 1, name: "Open", type: "hook", narration: "A light in the storm.", visual: "storm waves at night", durationS: 20 },
    { n: 2, name: "Keeper", type: "story", narration: "He kept it lit.", visual: "", durationS: 250 },
  ],
  durationS: 270,
  status: "ready",
  createdAt: "2026-10-01T10:00:00Z",
  decidedAt: null,
  creditsHeld: null,
  renderJobId: null,
};

function mount(over: { quote?: StoryboardQuote; canRun?: boolean; storyboard?: Partial<StoryboardView> } = {}) {
  const ui: ReactNode = (
    <I18nProvider locale="en">
      <StoryboardReview
        storyboard={{ ...SB, ...over.storyboard }}
        quote={over.quote ?? { kind: "paid", credits: 54 }}
        canRun={over.canRun ?? true}
        backHref="/x/videos"
      />
    </I18nProvider>
  );
  return render(ui);
}

type Call = { url: string; body: unknown };
let calls: Call[] = [];
let answers: { status: number; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  answers = [];
  refresh.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const a = answers.shift() ?? { status: 200, body: { ok: true } };
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("storyboard screen", () => {
  it("shows every scene card with its narration, visual and length, in order", () => {
    mount();
    const cards = screen.getAllByTestId("storyboard-scene");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText(fmt(ts.scene, { n: 1 }))).toBeTruthy();
    expect(within(cards[0]).getByText("A light in the storm.")).toBeTruthy();
    expect(within(cards[0]).getByText("storm waves at night")).toBeTruthy();
    expect(within(cards[1]).getByText(ts.noVisual)).toBeTruthy();
    expect(within(cards[1]).getByText(fmt(ts.seconds, { n: 250 }))).toBeTruthy();
    expect(screen.getByText(fmt(ts.total, { n: 2, m: "4.5" }))).toBeTruthy();
  });

  it("the one priced press sends exactly the price on the button", async () => {
    mount();
    const approve = screen.getByRole("button", { name: fmt(ts.approve, { credits: 54 }) });
    fireEvent.click(approve);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: `/api/storyboards/${ID}/approve`, body: { max_credits: 54 } });
    await waitFor(() => expect(screen.getAllByText(ts.approvedNote).length).toBeGreaterThan(0));
    // Decided: no more buttons that could press again.
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("a changed price is shown, never pressed for the person", async () => {
    answers = [{ status: 409, body: { error: "price_changed", credits: 61 } }];
    mount();
    fireEvent.click(screen.getByRole("button", { name: fmt(ts.approve, { credits: 54 }) }));
    await screen.findByText(fmt(ts.errPriceChanged, { credits: 61 }));
    expect(calls).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: fmt(ts.approve, { credits: 61 }) }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body).toEqual({ max_credits: 61 });
  });

  it("not enough credits is said with the numbers, and nothing reads as approved", async () => {
    answers = [{ status: 402, body: { error: "insufficient_credits", needed: 54, available: 10 } }];
    mount();
    fireEvent.click(screen.getByRole("button", { name: fmt(ts.approve, { credits: 54 }) }));
    expect((await screen.findByRole("alert")).textContent).toBe(fmt(ts.errInsufficient, { needed: 54, available: 10 }));
    expect(screen.queryByText(ts.approvedNote)).toBeNull();
  });

  it("discard asks first, and Keep it spends and changes nothing", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: ts.discard }));
    expect(screen.getByText(ts.discardConfirm)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: ts.discardNo }));
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: ts.discard }));
    fireEvent.click(screen.getByRole("button", { name: ts.discardYes }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe(`/api/storyboards/${ID}/discard`);
    await waitFor(() => expect(screen.getAllByText(ts.discardedNote).length).toBeGreaterThan(0));
  });

  it("someone who may not start runs reads it, but has no live button", () => {
    mount({ canRun: false });
    expect(screen.getByText(ts.notAllowed, { exact: false })).toBeTruthy();
    expect((screen.getByRole("button", { name: fmt(ts.approve, { credits: 54 }) }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: ts.discard }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("no price means no approve — never a zero", () => {
    mount({ quote: { kind: "unavailable", reason: "no_prices" } });
    const btn = screen.getByRole("button", { name: ts.approveIncluded }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(ts.noPrice, { exact: false })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\b0 credits\b/);
  });

  it("an operator channel's render is approved without a price", async () => {
    mount({ quote: { kind: "included" } });
    fireEvent.click(screen.getByRole("button", { name: ts.approveIncluded }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({});
  });

  it("a decided storyboard has no footer at all", () => {
    mount({ storyboard: { status: "discarded" } });
    expect(screen.queryByTestId("storyboard-dock")).toBeNull();
    expect(screen.getByText(ts.discardedNote)).toBeTruthy();
  });

  it("names no provider anywhere on the screen", () => {
    const { container } = mount();
    expect(container.textContent).not.toMatch(PROVIDER_BRANDS);
  });
});
