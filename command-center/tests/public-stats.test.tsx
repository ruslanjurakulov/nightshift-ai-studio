// @vitest-environment jsdom
/**
 * The site's live counters (migration 0164, docs/PUBLIC_STATS.md): built, wired into the landing and /solutions, and hidden
 * until the owner turns the switch on. What would break without these: a box of zeros on the landing the day the migration
 * merges; "0 videos approved" printed for a number the database never sent; a strip that stays up for an hour after the owner
 * hid it, or that hammers the database for every visitor; an English sentence on the Uzbek page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";

const rpc = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: (name: string) => ({ abortSignal: () => rpc(name) }) }),
}));
vi.mock("@/lib/config", async (orig) => ({
  ...(await orig<typeof import("@/lib/config")>()),
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  isSupabaseConfigured: true,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, replace: _r, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; replace?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, type Locale } from "@/lib/i18n";
import { publicStatsEn } from "@/lib/i18n/public-stats/en";
import { publicStatsRu } from "@/lib/i18n/public-stats/ru";
import { publicStatsUz } from "@/lib/i18n/public-stats/uz";
import { PUBLIC_STAT_COUNTS, parsePublicStats, shownPublicStats, type PublicStats } from "@/lib/public-stats";
import { PUBLIC_STATS_TTL_MS, readPublicSiteStats } from "@/lib/server/public-stats";
import { FAIL_TTL_MS, resetPublicReads } from "@/lib/server/public-read";
import { LiveStats, statsHour, statsTime } from "@/components/site/LiveStats";
import { Landing } from "@/components/landing/Landing";
import type { MoneyAnchor } from "@/lib/landing";

const VISIBLE = {
  visible: true,
  as_of: "2026-11-14T05:10:00+00:00",
  videos_rendered: 1204,
  videos_uploaded_private: 0,
  videos_approved: 37,
  studio_generations: 5120,
  last_run_at: "2026-11-14T04:00:00+00:00",
};
const NO_MONEY: MoneyAnchor = { pack: { kind: "none" }, api: null, site: null };

afterEach(cleanup);

describe("parsePublicStats: rule 5 at the edge of the database", () => {
  it("is hidden for anything but visible === true", () => {
    for (const v of [{ visible: false }, { visible: "true" }, { visible: 1 }, {}, { ...VISIBLE, visible: null }]) {
      expect(parsePublicStats(v)).toEqual({ visible: false });
    }
    for (const v of [null, undefined, "x", 3, []]) expect(parsePublicStats(v)).toBeNull();
  });

  it("hides a visible answer that cannot say when it was measured: 'as of' belongs to every number", () => {
    expect(parsePublicStats({ ...VISIBLE, as_of: null })).toEqual({ visible: false });
    expect(parsePublicStats({ ...VISIBLE, as_of: "yesterday" })).toEqual({ visible: false });
  });

  it("keeps a measured zero and turns anything that is not a whole count into null, never 0", () => {
    const got = parsePublicStats({ ...VISIBLE, videos_rendered: null, videos_approved: -1, studio_generations: 1.5, last_run_at: null });
    expect(got).toMatchObject({ visible: true, asOf: VISIBLE.as_of, lastRunAt: null });
    const counts = (got as PublicStats).counts;
    expect(counts.videos_uploaded_private).toBe(0);
    expect(counts.videos_rendered).toBeNull();
    expect(counts.videos_approved).toBeNull();
    expect(counts.studio_generations).toBeNull();
    // A key the database left out is not measured either.
    const { videos_rendered: _gone, ...missing } = VISIBLE;
    expect((parsePublicStats(missing) as PublicStats).counts.videos_rendered).toBeNull();
    expect((parsePublicStats({ ...VISIBLE, videos_rendered: "12" }) as PublicStats).counts.videos_rendered).toBeNull();
  });

  it("copies nothing it was not asked for into what the page sees", () => {
    const got = shownPublicStats(parsePublicStats({ ...VISIBLE, org_id: "o-1", title: "secret" }));
    expect(Object.keys(got!).sort()).toEqual(["asOf", "counts", "lastRunAt"]);
    expect(Object.keys(got!.counts).sort()).toEqual([...PUBLIC_STAT_COUNTS].sort());
    expect(JSON.stringify(got)).not.toMatch(/o-1|secret/);
  });
});

describe("readPublicSiteStats: the anon read, kept five minutes", () => {
  beforeEach(() => {
    resetPublicReads();
    rpc.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("is null (show nothing) while the switch is off, and asks again only after five minutes", async () => {
    rpc.mockResolvedValue({ data: { visible: false }, error: null });
    expect(await readPublicSiteStats()).toBeNull();
    expect(await readPublicSiteStats()).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("public_site_stats");
    // The owner turns it on: the site shows it within the window, with no redeploy.
    rpc.mockResolvedValue({ data: VISIBLE, error: null });
    await vi.advanceTimersByTimeAsync(PUBLIC_STATS_TTL_MS - 1000);
    expect(await readPublicSiteStats()).toBeNull();
    await vi.advanceTimersByTimeAsync(1001);
    expect((await readPublicSiteStats())?.counts.videos_rendered).toBe(1204);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("is null when 0164 is not applied yet (the function is missing), and retries soon", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.public_site_stats" } });
    expect(await readPublicSiteStats()).toBeNull();
    await vi.advanceTimersByTimeAsync(FAIL_TTL_MS + 1);
    rpc.mockResolvedValue({ data: VISIBLE, error: null });
    expect(await readPublicSiteStats()).not.toBeNull();
  });

  it("keeps a visible answer five minutes: visitors cost no database call", async () => {
    rpc.mockResolvedValue({ data: VISIBLE, error: null });
    for (let i = 0; i < 5; i++) await readPublicSiteStats();
    expect(rpc).toHaveBeenCalledTimes(1);
    // The owner hides it again: gone within the window.
    rpc.mockResolvedValue({ data: { visible: false }, error: null });
    await vi.advanceTimersByTimeAsync(PUBLIC_STATS_TTL_MS + 1);
    expect(await readPublicSiteStats()).toBeNull();
  });
});

function stats(over: Partial<PublicStats["counts"]> = {}, lastRunAt: string | null = VISIBLE.last_run_at): PublicStats {
  return {
    asOf: VISIBLE.as_of,
    counts: { videos_rendered: 1204, videos_uploaded_private: 0, videos_approved: 37, studio_generations: 5120, ...over },
    lastRunAt,
  };
}

describe("LiveStats: the strip", () => {
  it("draws nothing at all while hidden: no box, no heading, no zeros", () => {
    const { container } = render(<LiveStats t={dictionaries.en} locale="en" stats={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("labels every number with what it counts and says when it was measured", () => {
    const { container, getByRole } = render(<LiveStats t={dictionaries.en} locale="en" stats={stats()} />);
    expect(getByRole("heading", { name: "Live from our pipeline" })).toBeTruthy();
    const time = container.querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe(VISIBLE.as_of);
    expect(time.textContent).toBe("As of Nov 14, 2026, 05:10 UTC");
    const row = (id: string) => container.querySelector(`[data-stat="${id}"]`)!;
    expect(row("videos_rendered").querySelector("dt")!.textContent).toBe("Videos rendered (at least)");
    expect(row("videos_rendered").querySelector("dd")!.textContent).toBe("1,204");
    expect(row("studio_generations").querySelector("dd")!.textContent).toBe("5,120");
    expect(row("last_run_at").querySelector("dd")!.textContent).toBe("Nov 14, 2026, between 04:00 and 05:00 UTC");
    // A measured zero is a measurement.
    expect(row("videos_uploaded_private").querySelector("dd")!.textContent).toBe("0");
  });

  it("gives the last run only as the hour it fell in, never a minute, even if an answer carried one", () => {
    const { container } = render(<LiveStats t={dictionaries.en} locale="en" stats={stats({}, "2026-11-14T23:58:41+00:00")} />);
    const text = container.querySelector('[data-stat="last_run_at"] dd')!.textContent;
    expect(text).toBe("Nov 14, 2026, between 23:00 and 24:00 UTC");
    expect(text).not.toMatch(/:58|:41/);
    for (const locale of ["ru", "uz"] as const) {
      expect(statsHour("2026-11-14T04:00:00+00:00", locale, dictionaries[locale].site.liveStats.hourRange)).toMatch(/04:00.*05:00/);
    }
  });

  it("never copies the number of counted workspaces (the database's preview-only key) into the page", () => {
    const got = shownPublicStats(parsePublicStats({ ...VISIBLE, counted_orgs: 7, min_counted_orgs: 5 }));
    expect(JSON.stringify(got)).not.toMatch(/counted|"7"|:7\b/);
  });

  it("shows 'not measured yet' for a null, never 0, and never a rate or a percentage", () => {
    const { container } = render(
      <LiveStats t={dictionaries.en} locale="en" stats={stats({ videos_rendered: null, videos_uploaded_private: null, videos_approved: null, studio_generations: null }, null)} />,
    );
    const values = [...container.querySelectorAll("dd")].map((d) => d.textContent);
    expect(values).toEqual(Array(5).fill("not measured yet"));
    expect(container.textContent).not.toMatch(/\d\s*%|\b0\b/);
    for (const row of container.querySelectorAll("[data-stat]")) expect(row.getAttribute("data-measured")).toBe("no");
  });

  it.each(["ru", "uz"] as const)("speaks %s: the label, the time and the digits are the page's language", (locale: Locale) => {
    const { container } = render(<LiveStats t={dictionaries[locale]} locale={locale} stats={stats({ videos_rendered: null })} />);
    const s = dictionaries[locale].site.liveStats;
    expect(container.textContent).toContain(s.label);
    expect(container.textContent).toContain(s.notMeasured);
    // CLDR groups ru and uz with a no-break space (lib/number-format.ts).
    expect(container.querySelector('[data-stat="studio_generations"] dd')!.textContent).toBe("5 120");
    expect(container.querySelector("time")!.textContent).toBe(s.asOf.replace("{time}", statsTime(VISIBLE.as_of, locale)));
    expect(container.textContent).not.toContain("not measured yet");
  });

  it("is wired into the landing under the facts, and absent from it while hidden", () => {
    const hidden = render(<Landing t={dictionaries.en} locale="en" pricing={{ kind: "announced" }} anchor={NO_MONEY} showcase={[]} />);
    expect(hidden.container.querySelector("[data-live-stats]")).toBeNull();
    expect(hidden.container.textContent).not.toContain("Live from our pipeline");
    cleanup();
    const shown = render(
      <Landing t={dictionaries.en} locale="en" pricing={{ kind: "announced" }} anchor={NO_MONEY} showcase={[]} liveStats={stats()} />,
    );
    const strip = shown.container.querySelector("[data-live-stats]");
    expect(strip).not.toBeNull();
    expect(strip!.previousElementSibling?.classList.contains("nx-facts")).toBe(true);
  });
});

describe("the strip's words", () => {
  const leaves = (node: unknown, path = ""): [string, string][] =>
    typeof node === "string"
      ? [[path, node]]
      : node && typeof node === "object"
        ? Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k))
        : [];
  const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const en = new Map(leaves(publicStatsEn));

  it.each([
    ["ru", publicStatsRu],
    ["uz", publicStatsUz],
  ] as const)("%s has exactly the keys of en, none empty, none left in English, with the same {fillers}", (_, dict) => {
    const got = new Map(leaves(dict));
    expect([...got.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [k, text] of en) {
      expect(got.get(k)?.trim(), k).toBeTruthy();
      expect(got.get(k), k).not.toBe(text);
      expect(fillers(got.get(k)!), k).toEqual(fillers(text));
    }
  });

  it("every count the database sends has a label in every language, and the site dictionaries carry these words", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      const s = dictionaries[locale].site.liveStats;
      for (const id of PUBLIC_STAT_COUNTS) expect(s.counts[id], `${locale}.${id}`).toBeTruthy();
    }
    expect(dictionaries.ru.site.liveStats).toBe(publicStatsRu);
    expect(dictionaries.uz.site.liveStats).toBe(publicStatsUz);
  });

  it("no sentence states a figure: the figures come from the database only", () => {
    for (const dict of [publicStatsEn, publicStatsRu, publicStatsUz]) {
      for (const [, text] of leaves(dict)) expect(text).not.toMatch(/\d/);
    }
  });
});
