/**
 * The Series Factory's two server pages behind the flag SERIES_FACTORY_ENABLED (slice S3): the plan page /{channel}/series/{id} and the
 * series list that carries the "Plan a series" entry. They are called as functions with their data layer scripted (the way
 * publish-release-gate.test.tsx does), and the tree they return is read.
 *
 * What would break without these:
 *  - the flag off and the plan page still asking the database (or answering anything but 404);
 *  - the flag off and a "Plan a series" form (or a recent-plans read) on the series page;
 *  - a path that is not a plan id reaching the database;
 *  - another organization's plan shown;
 *  - a chip linking anywhere but the storyboard or video page of the same channel;
 *  - a read that failed shown as an empty or short series.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: () => null }));

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  calls: [] as string[],
  plan: null as Record<string, unknown> | null,
  planError: null as { code?: string; message?: string } | null,
  episodes: [] as Record<string, unknown>[],
  episodesError: null as { code?: string; message?: string } | null,
  quotes: {} as Record<string, unknown>,
  jobs: [] as Record<string, unknown>[],
  boards: [] as Record<string, unknown>[],
  videos: [] as Record<string, unknown>[],
  recent: [] as Record<string, unknown>[],
  recentError: null as { code?: string; message?: string } | null,
  inScope: true,
  series: [] as Record<string, unknown>[],
}));

/** A PostgREST-ish builder: every method returns it, and awaiting it answers per table. */
function table(name: string) {
  const b: Record<string, unknown> = {};
  h.calls.push(`from:${name}`);
  for (const m of ["eq", "in", "is", "or", "order", "limit", "select"]) b[m] = () => b;
  const answer = () => {
    switch (name) {
      case "series_plans":
        return { data: h.recent, error: h.recentError };
      case "series_episodes":
        return { data: h.episodes, error: h.episodesError };
      case "render_jobs":
        return { data: h.jobs, error: null };
      case "storyboards":
        return { data: h.boards, error: null };
      case "videos":
        return { data: h.videos, error: null };
      case "content_series":
        return { data: h.series, error: null };
      default:
        return { data: [], error: null };
    }
  };
  b.maybeSingle = async () => (name === "series_plans" ? { data: h.plan, error: h.planError } : { data: null, error: null });
  b.then = (res: (v: unknown) => unknown) => Promise.resolve(answer()).then(res);
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    h.createClient();
    return {
      from: (name: string) => ({ select: () => table(name) }),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        h.calls.push(`rpc:${fn}`);
        return { data: h.quotes[String(args.p_episode)] ?? null, error: null };
      },
    };
  },
  getUser: async () => null,
}));
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/channels-server", () => ({
  getChannelScope: async () => ({ selection: "all-channels", orgChannelIds: ["news"], includeGlobal: false }),
  getChannelContext: async () => ({
    channels: [{ channel_id: "news", name: "News" }],
    scope: { selection: "all-channels", orgChannelIds: ["news"], includeGlobal: false },
  }),
}));
vi.mock("@/lib/channels", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels")>()),
  channelInScope: () => h.inScope,
}));
vi.mock("@/lib/auth/org-roles", () => ({ resolveCurrentOrgRole: async () => "owner" }));

import SeriesPlanPage from "@/app/(app)/[channel]/series/[id]/page";
import SeriesPage from "@/app/(app)/[channel]/series/page";

const ID = "11111111-2222-3333-4444-555555555555";
const E1 = "aaaaaaaa-0000-0000-0000-000000000001";
const E2 = "aaaaaaaa-0000-0000-0000-000000000002";
const E3 = "aaaaaaaa-0000-0000-0000-000000000003";
const SB = "99999999-8888-7777-6666-555555555555";

function find(node: ReactNode, name: string, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => find(n, name, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (typeof el.type === "function" && (el.type as { name?: string }).name === name) out.push(el as ReactElement<Record<string, unknown>>);
    find(el.props.children, name, out);
    for (const v of Object.values(el.props)) if (v && typeof v === "object" && !Array.isArray(v) && "props" in (v as object)) find(v as ReactNode, name, out);
  }
  return out;
}

function text(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object" && "props" in node) return text((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

const episodeRow = (id: string, n: number, over: Record<string, unknown> = {}) => ({
  id, plan_id: ID, n, topic: `Topic ${n}`, outline: { topic: `Topic ${n}`, working_title: `Title ${n}` }, usable: true, needs_confirmation: false,
  duration_s: 300, status: "planned", credits_held: null, render_job_id: null, started_at: null, ...over,
});
const quoteOf = (over: Record<string, unknown> = {}) => ({
  price_status: "priced", credits: 15, status: "planned", needs_confirmation: false, blocked_by: null, may_start: true, startable: true, ...over,
});

function arrange(over: { status?: string } = {}) {
  h.createClient.mockReset();
  h.calls.length = 0;
  h.inScope = true;
  h.planError = null;
  h.episodesError = null;
  h.recentError = null;
  h.plan = {
    id: ID, channel_id: "news", series_id: null, topic: "Rome", niche: "history", language: "English", n_episodes: 3, duration_s: 300,
    status: over.status ?? "ready", title: "A series", report: { status: "ready", fact_checked: false, held_topics_checked: null },
    error_code: null, created_at: new Date(Date.now() - 120_000).toISOString(), finished_at: null,
  };
  h.episodes = [episodeRow(E1, 1), episodeRow(E2, 2), episodeRow(E3, 3)];
  h.quotes = { [E1]: quoteOf(), [E2]: quoteOf({ blocked_by: "earlier_episode_not_finished", startable: false }), [E3]: quoteOf({ blocked_by: "earlier_episode_not_finished", startable: false }) };
  h.jobs = [];
  h.boards = [];
  h.videos = [];
  h.recent = [];
  h.series = [];
}

beforeEach(arrange);
afterEach(() => {
  vi.unstubAllEnvs();
});

async function planPage(id = ID) {
  return (await SeriesPlanPage({ params: Promise.resolve({ id }) })) as ReactElement;
}

describe("flag off (the default)", () => {
  it("the plan page is a 404 and makes no database call, whatever the id", async () => {
    for (const value of [undefined, "", "off", "0", "false", "maybe"]) {
      if (value === undefined) vi.stubEnv("SERIES_FACTORY_ENABLED", "");
      else vi.stubEnv("SERIES_FACTORY_ENABLED", value);
      await expect(planPage()).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  it("a build-time public variable does not switch it on", async () => {
    vi.stubEnv("SERIES_FACTORY_ENABLED", "");
    vi.stubEnv("NEXT_PUBLIC_SERIES_FACTORY_ENABLED", "on");
    await expect(planPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(h.createClient).not.toHaveBeenCalled();
  });

  it("the series page has no Plan a series form and reads no plans", async () => {
    vi.stubEnv("SERIES_FACTORY_ENABLED", "");
    const tree = (await SeriesPage()) as ReactElement;
    expect(find(tree, "PlanSeriesPanel")).toHaveLength(0);
    expect(find(tree, "SeriesBoard")).toHaveLength(1);
    expect(h.calls).not.toContain("from:series_plans");
    expect(h.calls.filter((c) => c.startsWith("rpc:"))).toEqual([]);
  });
});

describe("flag on", () => {
  beforeEach(() => vi.stubEnv("SERIES_FACTORY_ENABLED", "on"));

  it("a path that is not a plan id is a 404 before the database is asked", async () => {
    for (const id of ["my-series", "../x", "1234", `${ID}x`, "content-series-slug"]) {
      await expect(planPage(id)).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(h.createClient).not.toHaveBeenCalled();
  });

  it("a ready plan reads the plan, its episodes and the database's quote of each, and hands them to the view", async () => {
    const tree = await planPage();
    const [view] = find(tree, "SeriesPlanView");
    expect(view).toBeDefined();
    const rows = view.props.rows as { episode: { n: number }; quote: { credits: number } | null; chip: string; href: string | null }[];
    expect(rows.map((r) => r.episode.n)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.quote?.credits)).toEqual([15, 15, 15]);
    expect(rows.map((r) => r.chip)).toEqual(["ready", "blocked", "blocked"]);
    expect(h.calls.filter((c) => c === "rpc:quote_series_episode")).toHaveLength(3);
    expect(view.props.backHref).toBe("/chronos/series");
    expect(view.props.plan).toMatchObject({ id: ID, status: "ready", nEpisodes: 3 });
  });

  it("a plan still being made reads no episodes and no quotes", async () => {
    arrange({ status: "requested" });
    const [view] = find(await planPage(), "SeriesPlanView");
    expect((view.props.plan as { status: string }).status).toBe("requested");
    expect(view.props.rows).toEqual([]);
    expect(h.calls).not.toContain("from:series_episodes");
    expect(h.calls).not.toContain("rpc:quote_series_episode");
    expect(typeof view.props.ageMinutes).toBe("number");
  });

  it("a started episode's chip links to its storyboard or its video, under this channel", async () => {
    h.episodes = [
      episodeRow(E1, 1, { status: "started", render_job_id: 41, started_at: "2026-10-24T10:00:00Z", credits_held: 15 }),
      episodeRow(E2, 2, { status: "started", render_job_id: 42, started_at: "2026-10-24T10:30:00Z", credits_held: 15 }),
      episodeRow(E3, 3),
    ];
    h.quotes = { [E1]: quoteOf({ status: "started" }), [E2]: quoteOf({ status: "started" }), [E3]: quoteOf({ blocked_by: "earlier_episode_not_finished", startable: false }) };
    h.jobs = [{ id: 41, status: "succeeded" }, { id: 42, status: "succeeded" }];
    h.boards = [{ id: SB, topic: "Topic 2", status: "ready", created_at: "2026-10-24T10:31:00Z" }];
    h.videos = [{ video_id: "dQw4w9WgXcQ", topic: "Topic 1", published_at: "2026-10-24T10:20:00Z" }];
    const [view] = find(await planPage(), "SeriesPlanView");
    const rows = view.props.rows as { chip: string; href: string | null }[];
    expect(rows.map((r) => [r.chip, r.href])).toEqual([
      ["video", "/chronos/videos/dQw4w9WgXcQ"],
      ["storyboard", `/chronos/videos/storyboard/${SB}`],
      ["blocked", null],
    ]);
  });

  it("a storyboard of another topic is not attached to an episode", async () => {
    h.episodes = [episodeRow(E1, 1, { status: "started", render_job_id: 41, started_at: "x" }), episodeRow(E2, 2), episodeRow(E3, 3)];
    h.jobs = [{ id: 41, status: "succeeded" }];
    h.boards = [{ id: SB, topic: "Some other topic", status: "ready", created_at: "2026-10-24T10:31:00Z" }];
    const [view] = find(await planPage(), "SeriesPlanView");
    expect((view.props.rows as { chip: string }[])[0].chip).toBe("finished");
  });

  it("a quote that cannot be read is null for that episode (price unavailable), not a missing episode and not zero", async () => {
    h.quotes = { [E1]: quoteOf(), [E2]: { price_status: "priced", credits: "abc" }, [E3]: null };
    const [view] = find(await planPage(), "SeriesPlanView");
    const rows = view.props.rows as { quote: unknown; chip: string }[];
    expect(rows.map((r) => r.quote === null)).toEqual([false, true, true]);
    expect(rows.slice(1).map((r) => r.chip)).toEqual(["unavailable", "unavailable"]);
  });

  it("a ready plan with fewer episodes than it was asked for is a failed read, never a short series", async () => {
    h.episodes = [episodeRow(E1, 1), episodeRow(E2, 2)];
    const tree = await planPage();
    expect(find(tree, "SeriesPlanView")).toHaveLength(0);
    expect(find(tree, "ErrorState")).toHaveLength(1);
  });

  it("a failed read says so with a retry; a missing migration says that; a missing plan says not found", async () => {
    h.planError = { code: "XX000", message: "boom" };
    let tree = await planPage();
    expect(find(tree, "ErrorState")).toHaveLength(1);
    expect(find(tree, "SeriesPlanView")).toHaveLength(0);

    h.planError = { code: "42P01", message: 'relation "series_plans" does not exist' };
    tree = await planPage();
    expect(find(tree, "ErrorState")).toHaveLength(0);
    expect(text(tree)).toContain("migration 0120");

    h.planError = null;
    h.plan = null;
    tree = await planPage();
    expect(text(tree)).toContain("This plan wasn't found.");
    expect(find(tree, "SeriesPlanView")).toHaveLength(0);
  });

  it("another organization's plan reads like a missing one", async () => {
    h.inScope = false;
    const tree = await planPage();
    expect(find(tree, "SeriesPlanView")).toHaveLength(0);
    expect(text(tree)).toContain("This plan wasn't found.");
    expect(h.calls).not.toContain("rpc:quote_series_episode");
  });
});

describe("the series page with the flag on", () => {
  beforeEach(() => vi.stubEnv("SERIES_FACTORY_ENABLED", "1"));

  it("shows the Plan a series form with the channels, the active series only, the plan base and the recent plans", async () => {
    h.series = [
      { series_id: "alpha", channel_id: "news", name: "Alpha", status: "ACTIVE" },
      { series_id: "beta", channel_id: "news", name: "Beta", status: "PAUSED" },
    ];
    h.recent = [{ ...h.plan, id: ID, status: "ready" }];
    const tree = (await SeriesPage()) as ReactElement;
    const [panel] = find(tree, "PlanSeriesPanel");
    expect(panel).toBeDefined();
    expect(panel.props.series).toEqual([{ series_id: "alpha", channel_id: "news", name: "Alpha" }]);
    expect(panel.props.channels).toEqual([{ channel_id: "news", name: "News" }]);
    expect(panel.props.planBase).toBe("/chronos/series");
    expect(panel.props.canEdit).toBe(true);
    expect(panel.props.recent).toEqual({
      state: "ok",
      plans: [{ id: ID, href: `/chronos/series/${ID}`, title: "A series", topic: "Rome", status: "ready", nEpisodes: 3 }],
    });
    expect(find(tree, "SeriesBoard")).toHaveLength(1);
  });

  it("a recent-plans read that fails, or whose table is missing, is said, never an empty list", async () => {
    h.recentError = { code: "XX000", message: "boom" };
    let [panel] = find((await SeriesPage()) as ReactElement, "PlanSeriesPanel");
    expect(panel.props.recent).toEqual({ state: "failed" });
    h.recentError = { code: "42P01", message: "does not exist" };
    [panel] = find((await SeriesPage()) as ReactElement, "PlanSeriesPanel");
    expect(panel.props.recent).toEqual({ state: "unsupported" });
  });
});
