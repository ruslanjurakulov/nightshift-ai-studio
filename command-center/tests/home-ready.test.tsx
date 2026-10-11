// @vitest-environment jsdom
/**
 * Home's "ready for your decision" card: finished videos held for approval and
 * storyboards waiting for approval, counted once, from the rows /videos lists.
 * Absent when nothing waits (no zero, no green tick); a failed read adds
 * nothing instead of a guess; the link goes where those rows really are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/home",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
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
import { HomeHub } from "@/components/home/HomeHub";
import { WAITING_STORYBOARDS_READ, buildReady, type HomeChannel } from "@/lib/home";

const t = dictionaries.en;
const ch = (over: Partial<HomeChannel> = {}): HomeChannel => ({
  id: "c1",
  slug: "chronos",
  name: "Chronos",
  avatar: null,
  language: "",
  standing: "live",
  autoPublish: false,
  lastVideo: null,
  nextRun: null,
  waiting: 0,
  ...over,
});
const boards = (n: number, channelSlug = "chronos") => Array.from({ length: n }, () => ({ channelSlug }));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 404 }))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("buildReady", () => {
  it("adds held videos and waiting storyboards into one count", () => {
    expect(buildReady({ channels: [ch({ waiting: 2 })], storyboards: boards(3) })).toMatchObject({ total: 5, held: 2, storyboards: 3, atLeast: false, slug: "chronos" });
  });

  it("is null when nothing waits: no zero, no green tick", () => {
    expect(buildReady({ channels: [ch({ waiting: 0 })], storyboards: [] })).toBeNull();
    expect(buildReady({ channels: [], storyboards: null })).toBeNull();
  });

  it("a failed read adds nothing: held alone counts without a guess about storyboards, and the other way round", () => {
    expect(buildReady({ channels: [ch({ waiting: 2 })], storyboards: null })).toMatchObject({ total: 2, storyboards: 0, atLeast: true });
    expect(buildReady({ channels: [ch({ waiting: null })], storyboards: boards(1) })).toMatchObject({ total: 1, held: 0, atLeast: true });
    expect(buildReady({ channels: [ch({ waiting: null })], storyboards: null })).toBeNull();
  });

  it("when both reads worked the count is exact", () => {
    expect(buildReady({ channels: [ch({ waiting: 1 })], storyboards: boards(1) })?.atLeast).toBe(false);
  });

  it("a full page of storyboards is a lower bound, not a count", () => {
    expect(buildReady({ channels: [ch()], storyboards: boards(WAITING_STORYBOARDS_READ) })?.atLeast).toBe(true);
    expect(buildReady({ channels: [ch()], storyboards: boards(WAITING_STORYBOARDS_READ - 1) })?.atLeast).toBe(false);
  });

  it("names the one channel whose /videos shows it all, and none when it spans channels", () => {
    const two = [ch({ slug: "a", id: "a", waiting: 1 }), ch({ slug: "b", id: "b", waiting: 0 })];
    expect(buildReady({ channels: two, storyboards: boards(1, "a") })?.slug).toBe("a");
    expect(buildReady({ channels: two, storyboards: boards(1, "b") })?.slug).toBeNull();
  });
});

describe("the card on Home", () => {
  const show = (props: Partial<Parameters<typeof HomeHub>[0]>) =>
    render(
      <I18nProvider locale="en">
        <HomeHub channels={[ch()]} currentSlug="chronos" orgId={null} allPrivate {...props} />
      </I18nProvider>,
    );

  it("counts waiting storyboards beside held videos and links to the page that lists both", () => {
    show({ channels: [ch({ waiting: 1 })], storyboards: boards(2) });
    const card = screen.getByTestId("home-status");
    expect(card.textContent).toContain("3 things are ready for your decision");
    expect(within(card).getByRole("link", { name: t.home.reviewNow }).getAttribute("href")).toBe("/chronos/videos");
  });

  it("a storyboard on its own is enough to show it, and one item reads in the singular", () => {
    show({ storyboards: boards(1) });
    expect(screen.getByTestId("home-status").textContent).toContain(t.home.readyOne);
  });

  it("is absent with nothing waiting and when the storyboard read failed with nothing held", () => {
    show({ storyboards: [] });
    expect(screen.queryByTestId("home-status")).toBeNull();
    cleanup();
    show({ storyboards: null });
    expect(screen.queryByTestId("home-status")).toBeNull();
  });

  it("does not promise more than the code does: it says what waits, and that nothing is uploaded or rendered before the decision", () => {
    show({ storyboards: boards(1) });
    expect(screen.getByTestId("home-status").textContent).toContain(t.home.readyBody);
    expect(screen.getByTestId("home-status").textContent).not.toMatch(/come back|resume|continue/i);
  });

  it("a full page says 20+, with the link to the channel that holds them", () => {
    show({ channels: [ch({ slug: "a b" })], storyboards: boards(WAITING_STORYBOARDS_READ, "a b") });
    const card = screen.getByTestId("home-status");
    expect(card.textContent).toContain(`${WAITING_STORYBOARDS_READ}+ things are ready`);
    expect(within(card).getByRole("link", { name: t.home.reviewNow }).getAttribute("href")).toBe("/a%20b/videos");
  });

  it("items in more than one channel link to the every-channel list, so the list matches the count", () => {
    const two = [ch({ slug: "a", id: "a", waiting: 1 }), ch({ slug: "b", id: "b", waiting: 0 })];
    show({ channels: two, storyboards: boards(1, "b") });
    const card = screen.getByTestId("home-status");
    expect(card.textContent).toContain("2 things are ready");
    expect(within(card).getByRole("link", { name: t.home.reviewNow }).getAttribute("href")).toBe("/all-channels/videos");
  });

  it("a failed read shows a lower bound, never an exact number", () => {
    show({ channels: [ch({ waiting: 2 })], storyboards: null });
    expect(screen.getByTestId("home-status").textContent).toContain("2+ things are ready");
    cleanup();
    show({ channels: [ch({ waiting: null })], storyboards: boards(1) });
    expect(screen.getByTestId("home-status").textContent).toContain("1+ things are ready");
  });

  it("says nothing is uploaded or published before the decision (no claim about rendering)", () => {
    expect(t.home.readyBody).toContain("Nothing is uploaded or published until you decide");
  });

  it("is worded in all three languages", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const d = dictionaries[loc].home;
      expect(d.readyMany).toContain("{n}");
      for (const s of [d.readyOne, d.readyMany, d.readyBody]) expect(s.trim().length).toBeGreaterThan(0);
    }
  });
});
