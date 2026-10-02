// @vitest-environment jsdom
/**
 * The storyboard's Render step card (LENS-2 L2-06): the figure it shows is
 * the render's price only when that price is for what would render.
 *
 * What would break without these: the saved scenes' quote shown next to
 * edited, unsaved scenes (a price for something else); after approval, the
 * current quote shown instead of what was held for the render; an unknown
 * hold drawn as 0 or as "can't be priced"; a "Total" in credits under the same
 * label the scene cards use for a running length in seconds.
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
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { fmt } from "@/lib/i18n";
import { StoryboardReview } from "@/components/storyboard/StoryboardReview";
import type { StoryboardQuote, StoryboardView } from "@/lib/storyboardReview";

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
  revision: 2,
};

function mount(over: { quote?: StoryboardQuote; storyboard?: Partial<StoryboardView> } = {}) {
  const ui: ReactNode = (
    <I18nProvider locale="en">
      <StoryboardReview
        storyboard={{ ...SB, ...over.storyboard }}
        quote={over.quote ?? { kind: "paid", credits: 60 }}
        canRun
        backHref="/x/videos"
      />
    </I18nProvider>
  );
  return render(ui);
}

let answers: { status: number; body: unknown }[] = [];
beforeEach(() => {
  answers = [];
  refresh.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const a = answers.shift() ?? { status: 200, body: { ok: true } };
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card = () => screen.getByTestId("storyboard-render-step");
const figures = () => card().querySelector(".ns-step-price")?.textContent ?? "";

describe("the Render step's price", () => {
  it("is the saved scenes' quote while nothing is edited", () => {
    mount();
    expect(figures()).toContain("60");
    expect(figures()).toContain(ts.stepPrice);
  });

  it("is not shown next to unsaved edits: it says it is priced after saving", () => {
    mount();
    fireEvent.change(screen.getAllByLabelText(ts.narration)[1], { target: { value: "He kept it lit, every night." } });
    expect(figures()).not.toContain("60");
    expect(within(card()).getAllByText(ts.renderOnSave).length).toBeGreaterThan(0);
    // Undo the edit: the saved quote is the price again.
    fireEvent.change(screen.getAllByLabelText(ts.narration)[1], { target: { value: "He kept it lit." } });
    expect(figures()).toContain("60");
  });

  it("after the press, is what was held, not the quote on screen", async () => {
    answers = [{ status: 200, body: { ok: true, status: "approved", backend: "queue", credits_reserved: 55, job_id: 7 } }];
    mount();
    fireEvent.click(screen.getByRole("button", { name: fmt(ts.approve, { credits: 60 }) }));
    await waitFor(() => expect(figures()).toContain("55"));
    expect(figures()).not.toContain("60");
    expect(figures()).toContain(ts.stepHeld);
  });

  it("after the press with no hold on record, says so — never the quote and never 0", async () => {
    answers = [{ status: 200, body: { ok: true, status: "approved", backend: "queue", credits_reserved: null, job_id: 7 } }];
    mount();
    fireEvent.click(screen.getByRole("button", { name: fmt(ts.approve, { credits: 60 }) }));
    await waitFor(() => expect(within(card()).getAllByText(ts.heldUnknown).length).toBeGreaterThan(0));
    expect(figures()).not.toContain("60");
    expect(figures()).not.toMatch(/\b0\b/);
  });

  it("for an approved or rendered storyboard, is the stored hold", () => {
    const unavailable: StoryboardQuote = { kind: "unavailable", reason: "read_failed" };
    for (const status of ["approved", "rendered"] as const) {
      const { unmount } = mount({ quote: unavailable, storyboard: { status, creditsHeld: 48, renderJobId: 7 } });
      expect(figures(), status).toContain("48");
      expect(figures(), status).toContain(ts.stepHeld);
      expect(figures(), status).not.toContain(ts.priceUnknown);
      unmount();
    }
    mount({ quote: unavailable, storyboard: { status: "rendered", creditsHeld: null } });
    expect(within(card()).getAllByText(ts.heldUnknown).length).toBeGreaterThan(0);
    expect(figures()).not.toMatch(/\b0\b/);
  });

  it("its total is labelled as credits, apart from the scenes' running length", () => {
    mount();
    const scene = screen.getAllByTestId("storyboard-scene")[0].querySelector(".ns-step-price")?.textContent ?? "";
    expect(figures()).toContain(ts.stepCreditsTotal);
    expect(scene).toContain(ts.stepLengthTotal);
    expect(ts.stepCreditsTotal).not.toBe(ts.stepLengthTotal);
    expect(figures()).not.toContain(ts.stepLengthTotal);
  });

  it("has its words in all three languages", () => {
    for (const d of [en, ru, uz]) {
      const s = d.storyboardReview;
      for (const k of ["renderOnSave", "stepHeld", "heldUnknown", "stepCreditsTotal", "stepLengthTotal"] as const) {
        expect(typeof s[k], k).toBe("string");
        expect((s[k] as string).length, k).toBeGreaterThan(0);
      }
    }
    expect(ru.storyboardReview.stepHeld).not.toBe(en.storyboardReview.stepHeld);
    expect(uz.storyboardReview.stepHeld).not.toBe(en.storyboardReview.stepHeld);
  });
});
