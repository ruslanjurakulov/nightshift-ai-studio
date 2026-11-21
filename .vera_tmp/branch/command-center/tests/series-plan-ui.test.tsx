// @vitest-environment jsdom
/**
 * The Series Factory's screens (slice S3): the plan page's view and the "Plan a series" form.
 *
 * What would break without these:
 *  - model text drawn as anything but text (an `<img onerror>` in a hook becoming an element), or a link built from it;
 *  - an outline that does not say "Not fact-checked", in any of the three languages;
 *  - a price the database did not compute, a partial total, or "0" standing in for an unknown;
 *  - a Start key that works for someone the database would refuse, an unconfirmed episode started without the tick, a price sent that
 *    is not the one shown, or a second tap that starts twice;
 *  - a refusal of the database shown as nothing, as a raw message, or without saying nothing was charged;
 *  - the form's refusal ("not available yet") shown as a failure, or a plan form that spends;
 *  - a state with no way out (loading, empty, error, retry, disabled), and a page that scrolls sideways at 320px.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: h.push }), usePathname: () => "/chronos/series" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: h.rpc }) }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { SeriesPlanView, PLANNING_POLL_MS, type EpisodeRow, type SeriesPlanViewProps } from "@/components/series/SeriesPlanView";
import { PlanSeriesPanel, type RecentPlansView } from "@/components/series/PlanSeriesPanel";
import { parseEpisode, parsePlan, type ChipKey, type QuoteView } from "@/lib/seriesPlan";

const en = dictionaries.en;
const s = en.seriesPlan;
const ID = "11111111-2222-3333-4444-555555555555";
const E = (n: number) => `aaaaaaaa-0000-0000-0000-00000000000${n}`;

function wrap(node: ReactNode, locale: Locale = "en") {
  return render(<I18nProvider locale={locale}>{node}</I18nProvider>);
}

function plan(over: Record<string, unknown> = {}) {
  return parsePlan({
    id: ID, channel_id: "news", series_id: null, topic: "The fall of Rome", niche: "history", language: "English", n_episodes: 3,
    duration_s: 300, status: "ready", title: "Rome in three parts",
    report: { status: "ready", fact_checked: false, unconfirmed_count: 0, held_topics_checked: null, gemini_calls_made: 1 },
    error_code: null, created_at: "2026-10-24T10:00:00Z", finished_at: "2026-10-24T10:01:00Z", ...over,
  })!;
}

function quote(over: Partial<QuoteView> = {}): QuoteView {
  return { status: "planned", priceStatus: "priced", credits: 15, needsConfirmation: false, blockedBy: null, mayStart: true, startable: true, ...over };
}

function row(n: number, over: { outline?: Record<string, unknown>; episode?: Record<string, unknown>; quote?: QuoteView | null; chip?: ChipKey; href?: string | null } = {}): EpisodeRow {
  const episode = parseEpisode({
    id: E(n), plan_id: ID, n, topic: `Topic ${n}`,
    outline: {
      topic: `Topic ${n}`, working_title: `Title ${n}`, angle: `Angle ${n}`, hook_sentence: `Hook ${n}`,
      hook_variants: [`Hook ${n} A`, `Hook ${n} B`], cta_variants: [`CTA ${n} A`, `CTA ${n} B`], open_loop: `Loop ${n}`, cliffhanger: `Cliff ${n}`,
      key_facts: [`Fact ${n}`], reasons: [], vet: { detail: "words" }, niche_confirmed: true, ...(over.outline ?? {}),
    },
    usable: true, needs_confirmation: false, duration_s: 300, status: "planned", credits_held: null, render_job_id: null, started_at: null,
    ...(over.episode ?? {}),
  })!;
  return { episode, quote: over.quote === undefined ? quote() : over.quote, chip: over.chip ?? "ready", href: over.href ?? null };
}

function view(over: Partial<SeriesPlanViewProps> = {}, locale: Locale = "en") {
  return wrap(
    <SeriesPlanView
      plan={plan()}
      rows={[row(1), row(2, { quote: quote({ blockedBy: "earlier_episode_not_finished", startable: false }), chip: "blocked" }), row(3, { quote: quote({ blockedBy: "earlier_episode_not_finished", startable: false }), chip: "blocked" })]}
      linksFailed={false}
      backHref="/chronos/series"
      againHref="/chronos/series"
      ageMinutes={1}
      {...over}
    />,
    locale,
  );
}

beforeEach(() => {
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: { id: E(1), status: "started" }, error: null });
  h.refresh.mockReset();
  h.push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("the outline cards", () => {
  it("show every part of the outline, the variants and the facts, with the not-fact-checked label on the page and on each outline", () => {
    view();
    expect(screen.getByText(s.notFactChecked.label, { selector: "p" })).toBeTruthy();
    const card = document.querySelector('[data-episode="1"]') as HTMLElement;
    for (const t of ["Title 1", "Angle 1", "Hook 1", "Hook 1 A", "Hook 1 B", "CTA 1 A", "CTA 1 B", "Loop 1", "Cliff 1", "Fact 1", "Topic 1"]) {
      expect(card.textContent, t).toContain(t);
    }
    expect(card.textContent).toContain(s.episode.keyFacts);
    expect(card.querySelectorAll("[data-not-fact-checked]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-not-fact-checked]").length).toBe(1 + 3);
  });

  it("the label cannot be switched off by the report: not by a missing, a wrong-typed or even a true fact_checked", () => {
    for (const report of [{ status: "ready", fact_checked: "yes" }, null, { status: "ready", fact_checked: true }, { status: "ready" }]) {
      cleanup();
      view({ plan: plan({ report }) });
      // the page-level note AND the chip on each of the three outlines
      expect(document.querySelectorAll("[data-not-fact-checked]").length, JSON.stringify(report)).toBe(4);
      expect(document.querySelector('[role="note"][data-not-fact-checked]')).not.toBeNull();
    }
  });

  it("the label is in Russian and Uzbek", () => {
    view({}, "ru");
    expect(document.body.textContent).toContain(dictionaries.ru.seriesPlan.notFactChecked.label);
    cleanup();
    view({}, "uz");
    expect(document.body.textContent).toContain(dictionaries.uz.seriesPlan.notFactChecked.label);
  });

  it("draw model text as text: markup stays characters, no element, no handler, no link", () => {
    const evil = `<img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script>`;
    view({
      rows: [
        row(1, {
          outline: { working_title: evil, angle: evil, hook_sentence: evil, hook_variants: [evil, "<b>bold</b>"], cta_variants: ["javascript:alert(1)", evil], open_loop: evil, cliffhanger: evil, key_facts: [evil, "[link](javascript:alert(1))"] },
          episode: { topic: evil },
        }),
        row(2, { chip: "blocked", quote: null }),
        row(3, { chip: "blocked", quote: null }),
      ],
    });
    const body = document.body;
    expect(body.querySelector("img")).toBeNull();
    expect(body.querySelector("script")).toBeNull();
    expect(body.querySelector("b")).toBeNull();
    expect(body.querySelector("[onerror]")).toBeNull();
    expect(body.textContent).toContain("<b>bold</b>");
    expect(body.textContent).toContain('<img src=x onerror="window.__pwned=1">');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // the only links are ours (back), never one built from a hook
    for (const a of Array.from(body.querySelectorAll("a"))) expect(a.getAttribute("href")).toMatch(/^\/chronos\//);
    expect(body.innerHTML).not.toMatch(/href="javascript:/i);
  });

  it("hide nothing behind a hostile length: a 5000-character field is cut", () => {
    const long = "x".repeat(5000);
    view({ rows: [row(1, { outline: { angle: long } }), row(2, { chip: "blocked", quote: null }), row(3, { chip: "blocked", quote: null })] });
    const card = document.querySelector('[data-episode="1"]') as HTMLElement;
    expect(card.textContent!.length).toBeLessThan(2000);
  });

  it("mark a refused episode with its reasons in words and offer no Start", () => {
    view({
      rows: [
        row(1, { episode: { usable: false }, outline: { reasons: ["off_niche", "repeat"], repeat_of: "Rome again", vet: { detail: "words" } }, chip: "refused", quote: null }),
        row(2, { chip: "blocked", quote: null }),
        row(3, { chip: "blocked", quote: null }),
      ],
    });
    const card = document.querySelector('[data-episode="1"]') as HTMLElement;
    expect(within(card).getByText(s.episode.refusedTitle)).toBeTruthy();
    expect(card.textContent).toContain(s.episode.reasons.off_niche);
    expect(card.textContent).toContain("Rome again");
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("say why a usable episode is unconfirmed, in the gate's words", () => {
    for (const detail of ["unchecked", "unverified", "gate_off"] as const) {
      cleanup();
      view({ rows: [row(1, { episode: { needs_confirmation: true }, outline: { vet: { detail }, niche_confirmed: false }, chip: "needs_confirm" }), row(2), row(3)] });
      const card = document.querySelector('[data-episode="1"]') as HTMLElement;
      expect(within(card).getByText(s.episode.confirm.title)).toBeTruthy();
      expect(card.textContent).toContain(s.episode.confirm[detail]);
      expect(card.querySelector('[data-chip="needs_confirm"]')).not.toBeNull();
    }
  });
});

describe("the prices", () => {
  it("each episode shows the database's price and the series total is their sum", () => {
    view({ rows: [row(1, { quote: quote({ credits: 15 }) }), row(2, { quote: quote({ credits: 15.5, blockedBy: "earlier_episode_not_finished", startable: false }) }), row(3, { quote: quote({ credits: 15 }) })] });
    expect((document.querySelector('[data-episode="1"] [data-price]') as HTMLElement).textContent).toBe("15 credits");
    expect((document.querySelector('[data-episode="2"] [data-price]') as HTMLElement).textContent).toBe("15.5 credits");
    expect((document.querySelector("[data-total]") as HTMLElement).textContent).toBe("45.5 credits for 3 usable episodes (any already started are included)");
  });

  it("an episode with no price blocks the total (never a partial sum) and cannot be started", () => {
    view({ rows: [row(1), row(2, { quote: quote({ priceStatus: "unpriced", credits: null, startable: false }), chip: "unpriced" }), row(3, { quote: null, chip: "unavailable" })] });
    expect((document.querySelector("[data-total]") as HTMLElement).dataset.total).toBe("incomplete");
    expect(document.querySelector("[data-total]")!.textContent).toBe(s.total.incomplete);
    expect(document.querySelector("[data-total]")!.textContent).not.toMatch(/\d/);
    expect((document.querySelector('[data-episode="2"] [data-price]') as HTMLElement).textContent).toBe(s.price.unpriced);
    expect((document.querySelector('[data-episode="3"] [data-price]') as HTMLElement).textContent).toBe(s.price.unavailable);
    expect(within(document.querySelector('[data-episode="2"]') as HTMLElement).queryByRole("button")).toBeNull();
    expect(within(document.querySelector('[data-episode="3"]') as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("the operator's own organization sees 'included', not 0 credits", () => {
    const inc = quote({ priceStatus: "included", credits: null });
    view({ rows: [row(1, { quote: inc }), row(2, { quote: inc, chip: "blocked" }), row(3, { quote: inc, chip: "blocked" })] });
    expect(document.querySelector("[data-total]")!.textContent).toBe(s.total.included);
    expect((document.querySelector('[data-episode="1"] [data-price]') as HTMLElement).textContent).toBe(s.price.included);
    expect(document.body.textContent).not.toMatch(/\b0 credits\b/);
  });

  it("a started episode shows what is held for it", () => {
    view({ rows: [row(1, { episode: { status: "started", credits_held: "15.00", render_job_id: 4, started_at: "x" }, chip: "running", quote: quote({ status: "started", startable: false, blockedBy: "already_started" }) }), row(2), row(3)] });
    expect((document.querySelector('[data-episode="1"] [data-price]') as HTMLElement).textContent).toBe("15 credits held");
  });
});

describe("the status chips", () => {
  it("a chip with a link goes to the storyboard or the video; the others are not links", () => {
    view({
      rows: [
        row(1, { chip: "video", href: "/chronos/videos/dQw4w9WgXcQ", episode: { status: "started", render_job_id: 4, started_at: "x" }, quote: null }),
        row(2, { chip: "storyboard", href: "/chronos/videos/storyboard/99999999-8888-7777-6666-555555555555", episode: { status: "started", render_job_id: 5, started_at: "x" }, quote: null }),
        row(3, { chip: "blocked", quote: quote({ blockedBy: "earlier_episode_not_finished", startable: false }) }),
      ],
    });
    const v = document.querySelector('[data-chip="video"]') as HTMLAnchorElement;
    expect(v.tagName).toBe("A");
    expect(v.getAttribute("href")).toBe("/chronos/videos/dQw4w9WgXcQ");
    expect(v.getAttribute("aria-label")).toContain(s.chip.openVideo);
    const sb = document.querySelector('[data-chip="storyboard"]') as HTMLAnchorElement;
    expect(sb.getAttribute("href")).toBe("/chronos/videos/storyboard/99999999-8888-7777-6666-555555555555");
    expect(document.querySelector('[data-chip="blocked"]')!.tagName).toBe("SPAN");
    expect(document.querySelector('[data-episode="3"]')!.textContent).toContain(s.blocked.earlier_episode_not_finished);
  });

  it("every chip has a label in all three languages", () => {
    for (const d of Object.values(dictionaries)) {
      for (const k of ["refused", "needs_confirm", "ready", "blocked", "unpriced", "unavailable", "started", "queued", "running", "storyboard", "video", "finished", "failed", "cancelled"]) {
        expect((d.seriesPlan.chip as Record<string, string>)[k], k).toBeTruthy();
      }
    }
  });
});

describe("Start episode", () => {
  const startKey = () => screen.getByRole("button", { name: "Start episode 1" }) as HTMLButtonElement;
  const sheetKey = () => within(screen.getByRole("alertdialog")).getByRole("button", { name: "Start episode 1" }) as HTMLButtonElement;

  it("is offered only for the episode the database says can start, to someone who may start it", () => {
    view();
    expect(screen.getAllByRole("button", { name: /Start episode/ })).toHaveLength(1);
    cleanup();
    view({ rows: [row(1, { quote: quote({ mayStart: false }) }), row(2, { chip: "blocked", quote: null }), row(3, { chip: "blocked", quote: null })] });
    expect(screen.queryByRole("button", { name: /Start episode/ })).toBeNull();
    expect(screen.getByText(s.start.adminOnly)).toBeTruthy();
  });

  it("opens a sheet first that names the episode, the price held and the length, and sends nothing on the first tap", () => {
    view();
    fireEvent.click(startKey());
    const text = screen.getByRole("alertdialog").textContent ?? "";
    expect(text).toContain("Title 1");
    expect(text).toContain("15 credits");
    expect(text).toContain("5 min");
    expect(text).toContain(s.start.message);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("calls the function once with the price that was shown, the episode's fixed key, and no confirmation for a confirmed episode", async () => {
    view();
    fireEvent.click(startKey());
    const key = sheetKey();
    fireEvent.click(key);
    fireEvent.click(key);
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    await settle();
    expect(h.rpc).toHaveBeenCalledWith("start_series_episode", { p_episode: E(1), p_max_credits: 15, p_idem: `se:${E(1)}`, p_confirmed: false });
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });

  it("an unconfirmed episode cannot be started without the tick, and the call then says it was confirmed", async () => {
    view({ rows: [row(1, { episode: { needs_confirmation: true }, outline: { vet: { detail: "unchecked" }, niche_confirmed: false }, chip: "needs_confirm" }), row(2, { chip: "blocked", quote: null }), row(3, { chip: "blocked", quote: null })] });
    fireEvent.click(startKey());
    expect(sheetKey().disabled).toBe(true);
    fireEvent.click(sheetKey());
    await settle();
    expect(h.rpc).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("checkbox", { name: s.start.acknowledge }));
    expect(sheetKey().disabled).toBe(false);
    fireEvent.click(sheetKey());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_confirmed: true, p_max_credits: 15 });
  });

  it("an included episode sends no price (the database ignores it for the operator's organization)", async () => {
    const inc = quote({ priceStatus: "included", credits: null });
    view({ rows: [row(1, { quote: inc }), row(2, { chip: "blocked", quote: null }), row(3, { chip: "blocked", quote: null })] });
    fireEvent.click(startKey());
    expect(screen.getByRole("alertdialog").textContent).toContain(s.start.messageIncluded);
    fireEvent.click(sheetKey());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_max_credits: null });
  });

  it("Cancel and Escape send nothing", async () => {
    view();
    fireEvent.click(startKey());
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.ux.confirmCancel }));
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(startKey());
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await settle();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  const refusals: [string, { code: string; message: string; details?: string }, string, boolean][] = [
    ["price_changed", { code: "NS409", message: "price_changed", details: "credits=18.50" }, "The price changed to 18.5 credits. Review it and try again.", true],
    ["insufficient credits", { code: "NS402", message: "insufficient credits", details: "available=5.00 needed=15.00" }, "Not enough credits: 5 available, 15 needed.", false],
    ["unpriced", { code: "NS400", message: "unpriced" }, s.start.errors.unpriced, false],
    ["earlier_episode_not_finished", { code: "NS409", message: "earlier_episode_not_finished" }, s.start.errors.earlier_episode_not_finished, true],
    ["rate_limited", { code: "NS429", message: "rate_limited", details: "limit=5 per 24 hours" }, s.start.errors.rate_limited, false],
    ["run limit", { code: "NS429", message: "parallel run limit reached", details: "active=2 limit=2" }, s.start.errors.run_limit, false],
    ["forbidden", { code: "42501", message: "forbidden" }, s.start.errors.forbidden, false],
    ["series_not_runnable", { code: "NS409", message: "series_not_runnable" }, s.start.errors.series_not_runnable, true],
    ["already_started", { code: "NS409", message: "already_started" }, s.start.errors.already_started, true],
  ];
  for (const [name, error, expected, refreshes] of refusals) {
    it(`reads a refusal (${name}) out in the sheet, in words, with the keys live again${refreshes ? " and the page refreshed" : ""}`, async () => {
      h.rpc.mockResolvedValue({ data: null, error });
      view();
      fireEvent.click(startKey());
      fireEvent.click(sheetKey());
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(expected));
      expect(screen.queryByRole("alertdialog")).not.toBeNull();
      expect(sheetKey().disabled).toBe(false);
      expect(h.refresh.mock.calls.length > 0).toBe(refreshes);
    });
  }

  it("an unknown error is a generic failure that says nothing was held, never the raw message", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "internal: password=hunter2" } });
    view();
    fireEvent.click(startKey());
    fireEvent.click(sheetKey());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(s.start.errors.failed));
    expect(document.body.textContent).not.toContain("hunter2");
    expect(s.start.errors.failed).toContain("Nothing was held");
  });

  it("a thrown error is the same generic failure and the person can try again", async () => {
    h.rpc.mockRejectedValueOnce(new Error("network"));
    view();
    fireEvent.click(startKey());
    fireEvent.click(sheetKey());
    await waitFor(() => expect(screen.getByRole("alert").textContent).not.toBe(""));
    h.rpc.mockResolvedValue({ data: {}, error: null });
    fireEvent.click(sheetKey());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(2));
  });

  it("every refusal word has a sentence in all three languages", () => {
    for (const d of Object.values(dictionaries)) {
      for (const k of Object.keys(en.seriesPlan.start.errors)) expect((d.seriesPlan.start.errors as Record<string, string>)[k], k).toBeTruthy();
    }
  });
});

describe("a plan that is not ready", () => {
  it("being made: says so, offers Check now, re-reads itself every 5 s, then every 30 s after 2 minutes, and stops after 10", async () => {
    vi.useFakeTimers();
    const { unmount } = view({ plan: plan({ status: "requested", title: null, report: null }), rows: [], ageMinutes: 0 });
    expect(screen.getByRole("status").textContent).toContain(s.planning.body);
    expect(screen.getByRole("button", { name: s.planning.checkNow })).toBeTruthy();
    expect(h.refresh).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(PLANNING_POLL_MS * 2 + 10);
    });
    expect(h.refresh).toHaveBeenCalledTimes(2);
    // up to the 2 minute mark: 5 s apart (24 refreshes in all); after it: 30 s apart
    h.refresh.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(2 * 60_000 - PLANNING_POLL_MS * 2 - 10);
    });
    expect(h.refresh.mock.calls.length).toBeGreaterThanOrEqual(21);
    expect(h.refresh.mock.calls.length).toBeLessThanOrEqual(23);
    h.refresh.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(h.refresh).toHaveBeenCalledTimes(4);
    h.refresh.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(6 * 60_000);
    });
    expect(h.refresh).toHaveBeenCalledTimes(12);
    // past 10 minutes it has stopped by itself and says so, with a manual key
    h.refresh.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(h.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain(s.planning.stopped);
    fireEvent.click(screen.getByRole("button", { name: s.planning.checkAgain }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
    unmount();
    h.refresh.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(PLANNING_POLL_MS * 3);
    });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("leaving the page while it is still looking cancels the next look", async () => {
    vi.useFakeTimers();
    const { unmount } = view({ plan: plan({ status: "requested", title: null, report: null }), rows: [], ageMinutes: 0 });
    await act(async () => {
      vi.advanceTimersByTime(PLANNING_POLL_MS + 10);
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    unmount();
    h.refresh.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("a plan already past 10 minutes when the page opens does not poll at all and offers Check again", async () => {
    vi.useFakeTimers();
    view({ plan: plan({ status: "requested", title: null, report: null }), rows: [], ageMinutes: 25 });
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(h.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain(s.planning.stopped);
    expect(screen.getByRole("button", { name: s.planning.checkAgain })).toBeTruthy();
  });

  it("a plan 3 minutes old when the page opens is looked at every 30 s, not every 5", async () => {
    vi.useFakeTimers();
    view({ plan: plan({ status: "requested", title: null, report: null }), rows: [], ageMinutes: 3 });
    await act(async () => {
      vi.advanceTimersByTime(29_000);
    });
    expect(h.refresh).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("being made for a long time: says it is taking longer and that nothing is charged", () => {
    view({ plan: plan({ status: "requested", title: null, report: null }), rows: [], ageMinutes: 25 });
    expect(screen.getByRole("status").textContent).toContain(s.planning.slow);
    expect(s.planning.slow).toContain("nothing is charged");
    cleanup();
    view({ plan: plan({ status: "requested", title: null, report: null }), rows: [], ageMinutes: 1 });
    expect(screen.getByRole("status").textContent).not.toContain(s.planning.slow);
  });

  it("Check now re-reads the page", async () => {
    view({ plan: plan({ status: "requested", title: null, report: null }), rows: [] });
    fireEvent.click(screen.getByRole("button", { name: s.planning.checkNow }));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });

  it("failed: a sentence for the code, nothing charged, and a way to plan again", () => {
    view({ plan: plan({ status: "failed", title: null, report: null, error_code: "gemini_quota" }), rows: [] });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(s.failed.codes.gemini_quota);
    expect(alert.textContent).toContain(s.failed.nothingCharged);
    expect(within(alert).getByRole("link", { name: s.failed.again }).getAttribute("href")).toBe("/chronos/series");
    expect(document.querySelector("[data-episode]")).toBeNull();
  });

  it("failed with a word nobody knows: the generic sentence, never the word", () => {
    view({ plan: plan({ status: "failed", title: null, report: null, error_code: "select_star_from_secrets" }), rows: [] });
    expect(screen.getByRole("alert").textContent).toContain(s.failed.codes.unknown);
    expect(document.body.textContent).not.toContain("select_star");
  });

  it("failed in each language", () => {
    for (const loc of ["ru", "uz"] as const) {
      cleanup();
      view({ plan: plan({ status: "failed", title: null, report: null, error_code: "timeout" }), rows: [] }, loc);
      expect(screen.getByRole("alert").textContent).toContain(dictionaries[loc].seriesPlan.failed.codes.timeout);
    }
  });
});

describe("what the total counts, and the wording", () => {
  it("the total says it counts usable episodes, and how many of them are already started and what is held", () => {
    const started = (n: number, held: string | null) =>
      row(n, { episode: { status: "started", credits_held: held, render_job_id: n, started_at: "x" }, chip: "running", quote: quote({ status: "started", startable: false, blockedBy: "already_started" }) });
    view({ rows: [started(1, "15.00"), started(2, "15.50"), row(3)] });
    expect(document.querySelector("[data-total]")!.textContent).toBe("45 credits for 3 usable episodes (any already started are included)");
    expect(document.querySelector("[data-started-total]")!.textContent).toBe("2 already started; 30.5 credits are held for them.");
    cleanup();
    view({ rows: [started(1, null), row(2), row(3)] });
    expect(document.querySelector("[data-started-total]")!.textContent).toBe("1 already started.");
    cleanup();
    view();
    expect(document.querySelector("[data-started-total]")).toBeNull();
  });

  it("a refused episode is not counted as started or in the total", () => {
    view({ rows: [row(1, { episode: { usable: false }, chip: "refused", quote: null }), row(2), row(3, { chip: "blocked" })] });
    expect(document.querySelector("[data-total]")!.textContent).toBe("30 credits for 2 usable episodes (any already started are included)");
  });

  it("no customer sentence names a role or the database, in any language", () => {
    const strings: string[] = [];
    for (const d of Object.values(dictionaries)) {
      const { page, ...rest } = d.seriesPlan;
      JSON.stringify({ ...rest, page: { ...page, unsupported: "", notConfigured: "" } }, (_k, v) => (typeof v === "string" ? (strings.push(v), v) : v));
    }
    const hits = strings.filter((x) => /\beditors?\b|\badmin(istrators?)?\b|\bdatabase\b|редактор|администратор|муҳарр|muharrir|administrator|baza/i.test(x));
    expect(hits.filter((x) => !/migration|migratsiya|миграци/i.test(x))).toEqual([]);
  });

  it("the plan and episode titles and the model's lists carry dir=auto, so a right-to-left title does not reorder our text", () => {
    view();
    expect(document.querySelector("h2")!.getAttribute("dir")).toBe("auto");
    const heading = document.querySelector('[data-episode="1"] h3') as HTMLElement;
    expect(heading.querySelector('[dir="auto"]')!.textContent).toBe("Title 1");
    expect(heading.getAttribute("dir")).toBeNull();
    const card = document.querySelector('[data-episode="1"]') as HTMLElement;
    for (const li of Array.from(card.querySelectorAll("li"))) expect(li.getAttribute("dir")).toBe("auto");
    expect(card.querySelectorAll('p[dir="auto"]').length).toBeGreaterThanOrEqual(5);
  });

  it("a bad request gets its own sentence in the failed state", () => {
    view({ plan: plan({ status: "failed", title: null, report: null, error_code: "bad_input" }), rows: [] });
    expect(screen.getByRole("alert").textContent).toContain(s.failed.codes.bad_input);
    expect(screen.getByRole("alert").textContent).not.toContain(s.failed.codes.unusable_answer);
  });

  it("the read-only notes say what the person can do, in plain words", () => {
    view({ rows: [row(1, { quote: quote({ mayStart: false }) }), row(2, { chip: "blocked", quote: null }), row(3, { chip: "blocked", quote: null })] });
    expect(screen.getByText(s.start.adminOnly)).toBeTruthy();
    expect(s.start.adminOnly).toContain("You can view this plan but not start its episodes");
    expect(s.entry.readOnly).toContain("You can view plans here but not make one");
    expect(s.entry.errors.forbidden).toContain("Ask someone who manages this workspace");
  });

  it("the recent plans block is a labelled section, not a div with a label", () => {
    panel();
    const block = document.getElementById("recent-plans-title")!.parentElement!;
    expect(block.tagName).toBe("SECTION");
    expect(block.getAttribute("aria-labelledby")).toBe("recent-plans-title");
    expect(document.querySelector('div[aria-labelledby]')).toBeNull();
  });
});

describe("small screens", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

  it("no fixed width at or above the narrowest phone in the new components, and every flexible box can shrink", () => {
    for (const file of ["components/series/SeriesPlanView.tsx", "components/series/PlanSeriesPanel.tsx", "app/(app)/[channel]/series/[id]/page.tsx"]) {
      const src = read(file);
      expect(src, file).not.toMatch(/\b(?:min-)?w-\[(?:3[2-9]\d|[4-9]\d\d|\d{4,})px\]/);
      expect(src, file).not.toMatch(/overflow-x-scroll|whitespace-nowrap/);
    }
    const view = read("components/series/SeriesPlanView.tsx");
    expect(view).toContain("min-w-0");
    expect(view).toContain("break-words");
    expect(view).toMatch(/w-full[^"]*sm:w-fit/);
  });

  it("the actions are full-width tap targets on a phone", () => {
    view();
    const button = screen.getByRole("button", { name: "Start episode 1" });
    expect(button.className).toContain("min-h-12");
    expect(button.className).toContain("w-full");
  });
});

// ── the "Plan a series" form ─────────────────────────────────────────────────

const channels = [{ channel_id: "news", name: "News" }, { channel_id: "tech", name: "Tech" }];
const seriesOptions = [{ series_id: "alpha", channel_id: "news", name: "Alpha" }, { series_id: "gamma", channel_id: "tech", name: "Gamma" }];
const recentOk: RecentPlansView = { state: "ok", plans: [{ id: ID, href: `/chronos/series/${ID}`, title: "Rome in three parts", topic: "Rome", status: "ready", nEpisodes: 3 }] };

function panel(over: Partial<Parameters<typeof PlanSeriesPanel>[0]> = {}, locale: Locale = "en") {
  let n = 0;
  return wrap(
    <PlanSeriesPanel channels={channels} series={seriesOptions} canEdit planBase="/chronos/series" recent={recentOk} randomId={() => `uuid-${++n}-aaaaaaaa`} {...over} />,
    locale,
  );
}
const topic = () => screen.getByRole("textbox") as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: s.entry.submit }) as HTMLButtonElement;
function write(text: string) {
  fireEvent.change(topic(), { target: { value: text } });
}

describe("Plan a series", () => {
  it("sends the plan request with the English language name, a key, and goes to the plan", async () => {
    h.rpc.mockResolvedValue({ data: { id: ID, status: "requested", render_job_id: 4, replayed: false }, error: null });
    panel();
    write("  The collapse of the Roman Republic ");
    fireEvent.click(submit());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    const [fn, args] = h.rpc.mock.calls[0];
    expect(fn).toBe("request_series_plan");
    expect(args).toMatchObject({ p_channel: "news", p_topic: "The collapse of the Roman Republic", p_n: 3, p_language: "English", p_duration_s: 300, p_series: null });
    expect(args.p_idem).toMatch(/^[A-Za-z0-9_:.-]{8,128}$/);
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(`/chronos/series/${ID}`));
  });

  it("sends the English NAME of the language in every interface language, never the interface string", async () => {
    h.rpc.mockResolvedValue({ data: { id: ID }, error: null });
    for (const [loc, name] of [["ru", "Russian"], ["uz", "Uzbek"], ["en", "English"]] as const) {
      cleanup();
      h.rpc.mockClear();
      panel({}, loc);
      fireEvent.change(topic(), { target: { value: "Тема" } });
      fireEvent.click(screen.getByRole("button", { name: dictionaries[loc].seriesPlan.entry.submit }));
      await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
      expect(h.rpc.mock.calls[0][1].p_language, loc).toBe(name);
      expect(h.rpc.mock.calls[0][1].p_language).toMatch(/^[A-Za-z][A-Za-z -]{0,39}$/);
    }
  });

  it("sends the chosen episodes, length, language and series", async () => {
    h.rpc.mockResolvedValue({ data: { id: ID }, error: null });
    panel();
    write("Topic");
    fireEvent.change(screen.getByLabelText(s.entry.channel), { target: { value: "tech" } });
    fireEvent.change(screen.getByLabelText(s.entry.episodes), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText(s.entry.length), { target: { value: "600" } });
    fireEvent.change(screen.getByLabelText(s.entry.language), { target: { value: "Uzbek" } });
    fireEvent.change(screen.getByLabelText(s.entry.series), { target: { value: "gamma" } });
    fireEvent.click(submit());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_channel: "tech", p_n: 4, p_duration_s: 600, p_language: "Uzbek", p_series: "gamma" });
  });

  it("offers only the chosen channel's series", () => {
    panel();
    const select = screen.getByLabelText(s.entry.series) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "alpha"]);
    fireEvent.change(screen.getByLabelText(s.entry.channel), { target: { value: "tech" } });
    expect(Array.from((screen.getByLabelText(s.entry.series) as HTMLSelectElement).options).map((o) => o.value)).toEqual(["", "gamma"]);
  });

  it("the same request pressed again replays one key; a changed request gets a new one", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "NS409", message: "plan_in_progress" } });
    panel();
    write("Topic");
    fireEvent.click(submit());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(2));
    expect(h.rpc.mock.calls[1][1].p_idem).toBe(h.rpc.mock.calls[0][1].p_idem);
    await waitFor(() => expect(submit().disabled).toBe(false));
    write("Another topic");
    fireEvent.click(submit());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(3));
    expect(h.rpc.mock.calls[2][1].p_idem).not.toBe(h.rpc.mock.calls[0][1].p_idem);
  });

  it("a double tap sends one request", async () => {
    h.rpc.mockImplementation(() => new Promise(() => undefined));
    panel();
    write("Topic");
    const key = submit();
    fireEvent.click(key);
    fireEvent.click(key);
    await settle();
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: s.entry.submitting }).getAttribute("aria-busy")).toBe("true");
  });

  it("pressing Enter twice in the topic while the request is out sends one request", async () => {
    h.rpc.mockImplementation(() => new Promise(() => undefined));
    panel();
    write("Topic");
    const form = topic().closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await settle();
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it("the database's refusal of a call it does not allow yet is 'not available yet', in every language, and nothing is queued", async () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      cleanup();
      h.rpc.mockReset();
      h.push.mockReset();
      h.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied for function request_series_plan" } });
      panel({}, loc);
      fireEvent.change(topic(), { target: { value: "Topic" } });
      fireEvent.click(screen.getByRole("button", { name: dictionaries[loc].seriesPlan.entry.submit }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(dictionaries[loc].seriesPlan.entry.errors.not_available));
      expect(screen.getByRole("alert").getAttribute("data-plan-error")).toBe("not_available");
      expect(h.push).not.toHaveBeenCalled();
    }
    expect(s.entry.errors.not_available).toContain("nothing was charged");
  });

  const refusals: [string, { code: string; message: string; details?: string }, string][] = [
    ["forbidden", { code: "42501", message: "forbidden" }, s.entry.errors.forbidden],
    ["plan_in_progress", { code: "NS409", message: "plan_in_progress" }, s.entry.errors.plan_in_progress],
    ["rate_limited", { code: "NS429", message: "rate_limited", details: "limit=5 per 24 hours" }, "You have reached today's limit of 5 plans. Try again tomorrow."],
    ["series_user_cap", { code: "NS429", message: "series_user_cap", details: "limit=3 per 24 hours" }, s.entry.errors.series_user_cap],
    ["series_global_cap", { code: "NS429", message: "series_global_cap" }, s.entry.errors.series_global_cap],
    ["no_niche", { code: "22023", message: "no_niche" }, s.entry.errors.no_niche],
    ["voice", { code: "42501", message: "voice_not_allowed: this voice belongs to someone else" }, s.entry.errors.voice],
    ["not_found", { code: "P0002", message: "not_found" }, s.entry.errors.not_found],
    ["unknown", { code: "XX000", message: "boom password=hunter2" }, s.entry.errors.failed],
  ];
  for (const [name, error, expected] of refusals) {
    it(`reads a refusal (${name}) out in words, and the person can press again`, async () => {
      h.rpc.mockResolvedValue({ data: null, error });
      panel();
      write("Topic");
      fireEvent.click(submit());
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(expected));
      expect(submit().disabled).toBe(false);
      expect(document.body.textContent).not.toContain("hunter2");
      expect(h.push).not.toHaveBeenCalled();
    });
  }

  it("a thrown error and an answer with no plan id are generic failures", async () => {
    h.rpc.mockRejectedValueOnce(new Error("offline"));
    panel();
    write("Topic");
    fireEvent.click(submit());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(s.entry.errors.failed));
    h.rpc.mockResolvedValue({ data: { id: "not-an-id" }, error: null });
    fireEvent.click(submit());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(s.entry.errors.failed));
    expect(h.push).not.toHaveBeenCalled();
  });

  it("an empty topic cannot be sent, and a topic over the planner's limit is refused before the database", async () => {
    panel();
    expect(submit().disabled).toBe(true);
    write("   ");
    expect(submit().disabled).toBe(true);
    expect(topic().getAttribute("maxlength")).toBe("200");
    write("x".repeat(250));
    // The input itself refuses past 200 in a browser; a script that sets more is stopped by the check.
    fireEvent.click(submit());
    await settle();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Write a topic of 1 to 200 characters, on one line.");
  });

  it("a viewer sees the form read-only with the reason; no channel says so", () => {
    panel({ canEdit: false });
    expect(screen.getByText(s.entry.readOnly)).toBeTruthy();
    expect(topic().disabled).toBe(true);
    expect(submit().disabled).toBe(true);
    cleanup();
    panel({ channels: [], series: [] });
    expect(screen.getByText(s.entry.noChannels)).toBeTruthy();
    expect(submit().disabled).toBe(true);
  });

  it("says before the press that the outline is not fact-checked and planning is free", () => {
    panel();
    expect(document.body.textContent).toContain(s.entry.notice);
    expect(document.body.textContent).toContain("Planning costs you no credits");
    expect(document.body.textContent).not.toMatch(/\bcredits? per\b/i);
  });

  it("lists the recent plans with a link to each; empty, unsupported and failed are each said", () => {
    panel();
    const link = screen.getByRole("link", { name: s.recent.open });
    expect(link.getAttribute("href")).toBe(`/chronos/series/${ID}`);
    expect(document.body.textContent).toContain("Rome in three parts");
    expect(document.body.textContent).toContain("3 episodes · Ready");
    cleanup();
    panel({ recent: { state: "ok", plans: [] } });
    expect(document.body.textContent).toContain(s.recent.empty);
    cleanup();
    panel({ recent: { state: "unsupported" } });
    expect(document.body.textContent).toContain(s.recent.unsupported);
    cleanup();
    panel({ recent: { state: "failed" } });
    expect(screen.getByRole("button", { name: en.common.retry })).toBeTruthy();
    expect(document.body.textContent).toContain(s.recent.failed);
  });

  it("recent plans draw their text as text", () => {
    panel({ recent: { state: "ok", plans: [{ id: ID, href: `/chronos/series/${ID}`, title: `<img src=x onerror="1">`, topic: "t", status: "ready", nEpisodes: 3 }] } });
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("<img src=x");
  });
});
