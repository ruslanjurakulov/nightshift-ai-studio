/**
 * The Series Factory page's pure logic (lib/seriesPlan.ts, slice S3).
 *
 * What would break without these:
 *  - model text shown with a hidden or reordering character, unbounded, or as anything but a bounded plain string;
 *  - a series total that is a partial sum (or 0) because one episode had no price;
 *  - a refusal of the database shown as a vague failure, or "not available yet" shown as "forbidden" (or the other way round);
 *  - a link built from text that is not an id;
 *  - the three languages drifting apart, or the server flag turning on for a value nobody meant.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { SERIES_FACTORY_FLAG, seriesFactoryEnabled } from "../lib/server/series-factory";
import {
  BLOCKED_WORDS,
  EPISODE_LENGTHS_S,
  PLANNER_ERROR_CODES,
  WORKER_ERROR_CODES,
  blockedKey,
  chipHref,
  cleanText,
  confirmReason,
  episodeChip,
  isSeriesId,
  isVideoLinkId,
  nextPollDelay,
  startedSummary,
  newPlanKey,
  parseEpisode,
  parseOutline,
  parsePlan,
  parseQuote,
  planErrorKey,
  planLanguageFor,
  reasonKey,
  requestError,
  seriesTotal,
  startError,
  startKey,
  type EpisodeLinks,
  type QuoteView,
} from "../lib/seriesPlan";

const ID = "11111111-2222-3333-4444-555555555555";
const EP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

function quote(over: Partial<QuoteView> = {}): QuoteView {
  return { status: "planned", priceStatus: "priced", credits: 15, needsConfirmation: false, blockedBy: null, mayStart: true, startable: true, ...over };
}

describe("untrusted text", () => {
  it("is cut to a bounded plain string with hidden, bidi and zero-width characters turned into spaces", () => {
    const hostile = `Ro${cp(0x202e)}me${cp(0x200b)}fell${cp(0x2028)}now${cp(0)}${cp(0x7f)}  here`;
    const out = cleanText(hostile, 200);
    expect(out).toBe("Ro me fell now here");
    expect(out).not.toMatch(new RegExp(`[${cp(0x202e)}${cp(0x200b)}${cp(0x2028)}${cp(0)}]`));
  });

  it("is limited in length, with an ellipsis, and a non-string is empty", () => {
    expect(cleanText("x".repeat(500), 20)).toHaveLength(20);
    expect(cleanText("x".repeat(500), 20).endsWith("…")).toBe(true);
    for (const v of [undefined, null, 5, {}, [], true]) expect(cleanText(v, 20)).toBe("");
  });

  it("keeps markup as characters (it is escaped where it is drawn) and never throws on odd input", () => {
    expect(cleanText("<img src=x onerror=alert(1)>", 100)).toBe("<img src=x onerror=alert(1)>");
    expect(cleanText("   ", 10)).toBe("");
  });

  it("an outline keeps at most the list sizes the planner promises, each item bounded", () => {
    const o = parseOutline({
      topic: "T", working_title: "W", angle: "A", hook_sentence: "H",
      hook_variants: ["a", "b", "c", "d", "e"], cta_variants: ["x".repeat(900), "ok", 7, null],
      open_loop: "O", cliffhanger: "C", key_facts: Array.from({ length: 12 }, (_, i) => `fact ${i}`),
      reasons: ["off_niche"], vet: { detail: "unchecked" }, repeat_of: "Old topic", niche_confirmed: false,
    });
    expect(o.hookVariants).toHaveLength(3);
    expect(o.ctaVariants).toEqual(["x".repeat(179) + "…", "ok"]);
    expect(o.keyFacts).toHaveLength(6);
    expect(o.repeatOf).toBe("Old topic");
    expect(o.nicheConfirmed).toBe(false);
  });

  it("a missing or wrong-typed outline is an empty one, not an error", () => {
    for (const raw of [null, undefined, "text", 5, [], { vet: "x", hook_variants: "no" }]) {
      const o = parseOutline(raw);
      expect(o.hookVariants).toEqual([]);
      expect(o.keyFacts).toEqual([]);
      expect(o.nicheConfirmed).toBe(false);
    }
  });
});

describe("rows", () => {
  const planRow = {
    id: ID, channel_id: "news", series_id: null, topic: "Rome", niche: "history", language: "English", n_episodes: 3, duration_s: 300,
    status: "ready", title: "A series", report: { status: "ready_unconfirmed", fact_checked: false, unconfirmed_count: 1, held_topics_checked: null, gemini_calls_made: 1 },
    error_code: null, created_at: "2026-10-24T10:00:00Z", finished_at: "2026-10-24T10:01:00Z",
  };

  it("a plan row parses, and one that is not a plan does not", () => {
    const p = parsePlan(planRow);
    expect(p).toMatchObject({ id: ID, nEpisodes: 3, durationS: 300, status: "ready", title: "A series" });
    expect(p?.report).toEqual({ verdict: "ready_unconfirmed", factChecked: false, unconfirmedCount: 1, heldTopicsChecked: null, geminiCallsMade: 1 });
    for (const bad of [null, {}, { ...planRow, id: "x" }, { ...planRow, status: "weird" }, { ...planRow, n_episodes: "3" }, { ...planRow, channel_id: 5 }]) {
      expect(parsePlan(bad)).toBeNull();
    }
  });

  it("only the literal true reads as fact-checked, and 'held topics checked' is never a claim of 'none held'", () => {
    for (const v of [false, undefined, null, "true", 1, "yes"]) {
      expect(parsePlan({ ...planRow, report: { ...planRow.report, fact_checked: v } })?.report?.factChecked, String(v)).toBe(false);
    }
    expect(parsePlan({ ...planRow, report: { ...planRow.report, fact_checked: true } })?.report?.factChecked).toBe(true);
    for (const v of [false, null, undefined, 0, "true"]) {
      expect(parsePlan({ ...planRow, report: { ...planRow.report, held_topics_checked: v } })?.report?.heldTopicsChecked, String(v)).toBeNull();
    }
    expect(parsePlan({ ...planRow, report: null })?.report).toBeNull();
  });

  it("an unknown verdict word is null, never ready", () => {
    expect(parsePlan({ ...planRow, report: { status: "super_ready" } })?.report?.verdict).toBeNull();
  });

  const epRow = { id: EP, plan_id: ID, n: 2, topic: "Pyramids", outline: { topic: "Pyramids" }, usable: true, needs_confirmation: true, duration_s: 300, status: "planned", credits_held: null, render_job_id: null, started_at: null };

  it("an episode row parses; a held amount may come as a string (numeric)", () => {
    expect(parseEpisode(epRow)).toMatchObject({ id: EP, n: 2, usable: true, needsConfirmation: true, status: "planned", creditsHeld: null });
    expect(parseEpisode({ ...epRow, status: "started", credits_held: "15.00", render_job_id: 9 })).toMatchObject({ status: "started", creditsHeld: 15, renderJobId: 9 });
    for (const bad of [null, { ...epRow, n: 0 }, { ...epRow, n: 5 }, { ...epRow, usable: "yes" }, { ...epRow, plan_id: "x" }]) expect(parseEpisode(bad)).toBeNull();
  });

  it("a quote parses; a priced quote with no usable number is no quote at all (shown as unavailable, never 0)", () => {
    expect(parseQuote({ price_status: "priced", credits: "15.00", status: "planned", needs_confirmation: true, blocked_by: null, may_start: true, startable: true }))
      .toMatchObject({ priceStatus: "priced", credits: 15, mayStart: true, startable: true, needsConfirmation: true });
    expect(parseQuote({ price_status: "included", credits: null })).toMatchObject({ priceStatus: "included", credits: null });
    expect(parseQuote({ price_status: "unpriced", credits: null })).toMatchObject({ priceStatus: "unpriced", credits: null });
    for (const bad of [null, {}, { price_status: "priced" }, { price_status: "priced", credits: -1 }, { price_status: "priced", credits: "abc" }, { price_status: "free" }]) {
      expect(parseQuote(bad)).toBeNull();
    }
  });

  it("every ready/unconfirmed reason has a dictionary key, and the confirmation reason defaults to 'unconfirmed'", () => {
    expect(reasonKey("off_niche")).toBe("off_niche");
    expect(reasonKey("something_new")).toBe("other");
    expect(confirmReason(parseOutline({ vet: { detail: "unchecked" } }))).toBe("unchecked");
    expect(confirmReason(parseOutline({ vet: { detail: "gate_off" } }))).toBe("gate_off");
    expect(confirmReason(parseOutline({ vet: { detail: "model" } }))).toBe("unconfirmed");
    expect(confirmReason(parseOutline({}))).toBe("unconfirmed");
  });
});

describe("the price of the series (the database's, never a partial sum)", () => {
  const eps = (qs: (QuoteView | null)[], usable: boolean[] = qs.map(() => true)) => qs.map((q, i) => ({ n: i + 1, usable: usable[i], quote: q }));

  it("is the sum of the episodes' prices, rounded up to the cent", () => {
    expect(seriesTotal(eps([quote({ credits: 15 }), quote({ credits: 15.004 }), quote({ credits: 0.1 })]))).toEqual({ kind: "priced", credits: 30.11, episodes: 3 });
  });

  it("is incomplete, with no number, when ANY usable episode has no price or no readable quote", () => {
    for (const bad of [quote({ priceStatus: "unpriced", credits: null }), null]) {
      const t = seriesTotal(eps([quote(), bad, quote()]));
      expect(t).toEqual({ kind: "incomplete", unknownEpisodes: [2] });
    }
    // every unknown is named, not only the first
    expect(seriesTotal(eps([quote(), null, quote({ priceStatus: "unpriced", credits: null })]))).toEqual({ kind: "incomplete", unknownEpisodes: [2, 3] });
  });

  it("leaves a refused episode out (it never starts), and says 'none' when nothing can be made", () => {
    expect(seriesTotal(eps([quote({ credits: 10 }), null, quote({ credits: 5 })], [true, false, true]))).toEqual({ kind: "priced", credits: 15, episodes: 2 });
    expect(seriesTotal(eps([null, null], [false, false]))).toEqual({ kind: "none" });
    expect(seriesTotal([])).toEqual({ kind: "none" });
  });

  it("is 'included' (not 0 credits) for the operator's own organization", () => {
    expect(seriesTotal(eps([quote({ priceStatus: "included", credits: null }), quote({ priceStatus: "included", credits: null })]))).toEqual({ kind: "included" });
  });

  it("never returns 0 for an unknown", () => {
    const t = seriesTotal(eps([quote({ credits: 0 }), null]));
    expect(t.kind).toBe("incomplete");
    expect("credits" in t).toBe(false);
  });
});

describe("the poll schedule", () => {
  it("is fast at first, slow after 2 minutes, and gone after 10", () => {
    expect(nextPollDelay(0)).toBe(5000);
    expect(nextPollDelay(119_999)).toBe(5000);
    expect(nextPollDelay(120_000)).toBe(30_000);
    expect(nextPollDelay(599_999)).toBe(30_000);
    expect(nextPollDelay(600_000)).toBeNull();
    expect(nextPollDelay(3_600_000)).toBeNull();
    expect(nextPollDelay(-5)).toBe(5000);
    expect(nextPollDelay(Number.NaN)).toBe(5000);
  });
});

describe("what the total counts", () => {
  it("counts the usable started episodes and sums what is held, or says it cannot", () => {
    const e = (usable: boolean, status: "planned" | "started", creditsHeld: number | null) => ({ usable, status, creditsHeld });
    expect(startedSummary([])).toEqual({ count: 0, held: null });
    expect(startedSummary([e(true, "planned", null)])).toEqual({ count: 0, held: null });
    expect(startedSummary([e(true, "started", 15), e(true, "started", 15.004), e(true, "planned", null)])).toEqual({ count: 2, held: 30.01 });
    expect(startedSummary([e(true, "started", 15), e(true, "started", null)])).toEqual({ count: 2, held: null });
    expect(startedSummary([e(false, "started", 15)])).toEqual({ count: 0, held: null });
  });
});

describe("the chip", () => {
  const planned = { usable: true, needsConfirmation: false, status: "planned" as const };
  const started = { usable: true, needsConfirmation: false, status: "started" as const };
  const links = (over: Partial<EpisodeLinks> = {}): EpisodeLinks => ({ jobStatus: "succeeded", storyboard: null, video: null, ...over });
  const SB = "99999999-8888-7777-6666-555555555555";

  it("a planned episode wears its state from the database's quote", () => {
    expect(episodeChip({ ...planned, usable: false }, quote(), null).key).toBe("refused");
    expect(episodeChip(planned, null, null).key).toBe("unavailable");
    expect(episodeChip(planned, quote({ blockedBy: "earlier_episode_not_finished", startable: false }), null).key).toBe("blocked");
    expect(episodeChip(planned, quote({ priceStatus: "unpriced", credits: null, startable: false }), null).key).toBe("unpriced");
    expect(episodeChip(planned, quote(), null).key).toBe("ready");
    expect(episodeChip({ ...planned, needsConfirmation: true }, quote(), null).key).toBe("needs_confirm");
  });

  it("a started episode wears its run, then its storyboard or video, with a link only for those", () => {
    expect(episodeChip(started, null, links({ jobStatus: "queued" })).key).toBe("queued");
    expect(episodeChip(started, null, links({ jobStatus: "running" })).key).toBe("running");
    expect(episodeChip(started, null, links({ jobStatus: "failed" })).key).toBe("failed");
    expect(episodeChip(started, null, links({ jobStatus: "cancelled" })).key).toBe("cancelled");
    expect(episodeChip(started, null, links({ jobStatus: "succeeded" })).key).toBe("finished");
    expect(episodeChip(started, null, null).key).toBe("started");
    const sb = episodeChip(started, null, links({ storyboard: { id: SB, status: "ready" } }));
    expect(sb).toEqual({ key: "storyboard", link: { section: "storyboard", id: SB } });
    const video = episodeChip(started, null, links({ video: { id: "dQw4w9WgXcQ" }, storyboard: { id: SB, status: "approved" } }));
    expect(video).toEqual({ key: "video", link: { section: "video", id: "dQw4w9WgXcQ" } });
  });

  it("a storyboard waiting for approval outranks an older video of the same topic", () => {
    const c = episodeChip(started, null, links({ video: { id: "dQw4w9WgXcQ" }, storyboard: { id: SB, status: "ready" } }));
    expect(c.key).toBe("storyboard");
  });

  it("links point at the storyboard and video pages under the channel, and only for real ids", () => {
    const path = (s: string) => `/news${s}`;
    expect(chipHref(path, { key: "storyboard", link: { section: "storyboard", id: SB } })).toBe(`/news/videos/storyboard/${SB}`);
    expect(chipHref(path, { key: "video", link: { section: "video", id: "dQw4w9WgXcQ" } })).toBe("/news/videos/dQw4w9WgXcQ");
    expect(chipHref(path, { key: "ready", link: null })).toBeNull();
    for (const id of ["../etc", "a/b", "x?y", "javascript:alert(1)", "", "a b", "short"]) {
      expect(chipHref(path, { key: "video", link: { section: "video", id } }), id).toBeNull();
      expect(chipHref(path, { key: "storyboard", link: { section: "storyboard", id } }), id).toBeNull();
    }
  });

  it("a chip never links from a hostile id even if the data layer let one through", () => {
    const c = episodeChip(started, null, links({ video: { id: "x/../y" } }));
    expect(c.link).toBeNull();
    expect(c.key).toBe("finished");
  });
});

describe("what a refusal of start_series_episode means", () => {
  const e = (code: string, message: string, details: string | null = null) => startError({ code, message, details });

  it("reads the database's fixed word", () => {
    expect(e("NS409", "price_changed", "credits=15.00")).toEqual({ key: "price_changed", credits: 15 });
    expect(e("NS409", "price_changed")).toEqual({ key: "price_changed" });
    expect(e("NS400", "unpriced").key).toBe("unpriced");
    expect(e("NS409", "earlier_episode_not_finished").key).toBe("earlier_episode_not_finished");
    expect(e("NS400", "confirmation_required").key).toBe("confirmation_required");
    expect(e("22023", "price_required", "credits=15.00").key).toBe("price_required");
    expect(e("NS409", "already_started").key).toBe("already_started");
    expect(e("NS409", "plan_not_ready").key).toBe("plan_not_ready");
    expect(e("NS409", "episode_not_usable").key).toBe("episode_not_usable");
    expect(e("NS409", "series_not_runnable").key).toBe("series_not_runnable");
    expect(e("NS409", "idempotency_conflict").key).toBe("idempotency_conflict");
    expect(e("42501", "forbidden").key).toBe("forbidden");
    expect(e("P0002", "not_found").key).toBe("not_found");
  });

  it("separates insufficient credits (with its numbers), the run limit and the press cap", () => {
    expect(e("NS402", "insufficient credits", "available=5.00 needed=15.00")).toEqual({ key: "insufficient", available: 5, needed: 15 });
    expect(e("NS402", "insufficient credits")).toEqual({ key: "insufficient", available: null, needed: null });
    expect(e("NS429", "parallel run limit reached", "active=2 limit=2")).toEqual({ key: "run_limit", limit: 2 });
    expect(e("NS429", "rate_limited", "limit=5 per 24 hours")).toEqual({ key: "rate_limited" });
  });

  it("anything it does not know is a generic failure, never the raw message", () => {
    for (const err of [null, undefined, {}, { code: "XX000", message: "internal: password=hunter2" }, { message: "select * from secrets" }]) {
      expect(startError(err as never)).toEqual({ key: "failed" });
    }
  });

  it("a forbidden code with an unknown word is still forbidden", () => {
    expect(e("42501", "permission denied for function start_series_episode").key).toBe("forbidden");
  });
});

describe("what a refusal of request_series_plan means", () => {
  const r = (code: string | null, message: string, details: string | null = null, status?: number) => requestError({ code, message, details, status });

  it("'not available yet' is the function not being granted or not being there, never 'forbidden'", () => {
    expect(r("42501", "permission denied for function request_series_plan").key).toBe("not_available");
    expect(r("PGRST202", "Could not find the function public.request_series_plan(p_channel) in the schema cache").key).toBe("not_available");
    expect(r("42883", "function public.request_series_plan(text) does not exist").key).toBe("not_available");
    expect(r(null, "Not Found", null, 404).key).toBe("not_available");
  });

  it("the function's OWN forbidden (a viewer) is forbidden", () => {
    expect(r("42501", "forbidden").key).toBe("forbidden");
  });

  it("reads the function's words", () => {
    expect(r("NS409", "plan_in_progress").key).toBe("plan_in_progress");
    expect(r("NS429", "rate_limited", "limit=5 per 24 hours")).toEqual({ key: "rate_limited", limit: 5 });
    expect(r("NS429", "rate_limited")).toEqual({ key: "rate_limited", limit: null });
    expect(r("22023", "invalid_topic").key).toBe("invalid_topic");
    expect(r("22023", "invalid_episode_count").key).toBe("invalid_count");
    expect(r("22023", "invalid_duration").key).toBe("invalid_duration");
    expect(r("22023", "invalid_language").key).toBe("invalid_language");
    expect(r("22023", "no_niche").key).toBe("no_niche");
    expect(r("P0002", "not_found").key).toBe("not_found");
    expect(r("NS409", "idempotency_conflict").key).toBe("idempotency_conflict");
  });

  it("a voice the channel can no longer use says so (0117's guard fires on the planning job's insert)", () => {
    expect(r("42501", "voice_not_allowed: this voice belongs to someone else or is not available").key).toBe("voice");
  });

  it("unknown is generic and never repeats the message", () => {
    expect(requestError({ code: "XX000", message: "boom password=hunter2" })).toEqual({ key: "failed" });
    expect(requestError(null)).toEqual({ key: "failed" });
  });
});

describe("closed words", () => {
  it("every worker and planner error code has a sentence, and an unknown code gets the generic one", () => {
    const sentences = en.seriesPlan.failed.codes as Record<string, string>;
    for (const code of [...WORKER_ERROR_CODES, ...PLANNER_ERROR_CODES, "nonsense", null, 5]) {
      const key = planErrorKey(code);
      expect(sentences[key], String(code)).toBeTruthy();
    }
    expect(planErrorKey("not_json")).toBe("unusable_answer");
    expect(planErrorKey("gemini_quota")).toBe("gemini_quota");
    expect(planErrorKey("totally_new")).toBe("unknown");
  });

  it("a bad request is its own sentence, not 'the answer could not be used'", () => {
    for (const code of ["bad_input", "bad_language", "bad_count"]) expect(planErrorKey(code), code).toBe("bad_input");
    expect(en.seriesPlan.failed.codes.bad_input).not.toBe(en.seriesPlan.failed.codes.unusable_answer);
  });

  it("the blocked words the database uses all have a sentence", () => {
    for (const w of BLOCKED_WORDS) expect(blockedKey(w)).toBe(w);
    expect(blockedKey("something")).toBe("other");
    expect(blockedKey(null)).toBeNull();
  });
});

describe("keys and languages", () => {
  it("an episode start's key is exactly what the database requires", () => {
    expect(startKey(EP)).toBe(`se:${EP}`);
    expect(startKey(EP)).toMatch(/^se:[0-9a-f-]{36}$/);
  });

  it("a plan press's key fits the database's rule and never carries a character outside it", () => {
    expect(newPlanKey(() => EP)).toMatch(/^[A-Za-z0-9_:.-]{8,128}$/);
    expect(newPlanKey(() => "../a b<c>" + "x".repeat(400))).toMatch(/^[A-Za-z0-9_:.-]{8,128}$/);
  });

  it("the language sent is the English name the database accepts, whatever the interface language is", () => {
    expect(planLanguageFor("en")).toBe("English");
    expect(planLanguageFor("ru")).toBe("Russian");
    expect(planLanguageFor("uz")).toBe("Uzbek");
    expect(planLanguageFor("xx")).toBe("English");
    for (const l of ["en", "ru", "uz"]) expect(planLanguageFor(l)).toMatch(/^[A-Za-z][A-Za-z -]{0,39}$/);
  });

  it("the lengths on offer are inside what the database accepts", () => {
    for (const s of EPISODE_LENGTHS_S) {
      expect(s).toBeGreaterThanOrEqual(30);
      expect(s).toBeLessThanOrEqual(3600);
    }
  });

  it("ids", () => {
    expect(isSeriesId(ID)).toBe(true);
    for (const v of ["", "x", "../x", `${ID}x`, 5, null, "11111111-2222-3333-4444-55555555555g"]) expect(isSeriesId(v), String(v)).toBe(false);
    expect(isVideoLinkId("dQw4w9WgXcQ")).toBe(true);
    for (const v of ["a/b", "a?b", "ab", "x".repeat(65), "a b", "é1234567"]) expect(isVideoLinkId(v), v).toBe(false);
  });
});

describe("the server flag", () => {
  it("is off unless it is on / 1 / true / yes, whatever else is set", () => {
    expect(seriesFactoryEnabled(undefined)).toBe(false);
    for (const v of ["", "off", "0", "false", "no", "maybe", "onn", " ", "enabled"]) expect(seriesFactoryEnabled(v), v).toBe(false);
    for (const v of ["on", "ON", " on ", "1", "true", "Yes"]) expect(seriesFactoryEnabled(v), v).toBe(true);
    expect(SERIES_FACTORY_FLAG).toBe("SERIES_FACTORY_ENABLED");
  });

  it("with no argument it reads the server's environment when it is called, and a browser-bundled name counts for nothing", () => {
    vi.stubEnv("SERIES_FACTORY_ENABLED", "");
    vi.stubEnv("NEXT_PUBLIC_SERIES_FACTORY_ENABLED", "on");
    expect(seriesFactoryEnabled()).toBe(false);
    vi.stubEnv("SERIES_FACTORY_ENABLED", "on");
    expect(seriesFactoryEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });

  it("is a server-only module read from the server's environment, never a NEXT_PUBLIC_ name", () => {
    const src = readFileSync(join(__dirname, "..", "lib", "server", "series-factory.ts"), "utf8");
    expect(src).toContain('import "server-only"');
    expect(src).not.toMatch(/NEXT_PUBLIC_SERIES/);
  });

  it("is documented where the owner will look, and mapped by the deploy", () => {
    const root = join(__dirname, "..", "..");
    expect(readFileSync(join(root, "deploy", ".env.web.example"), "utf8")).toMatch(/^SERIES_FACTORY_ENABLED=$/m);
    expect(readFileSync(join(root, ".github", "workflows", "deploy_web.yml"), "utf8")).toContain("WEBENV_SERIES_FACTORY_ENABLED: ${{ vars.SERIES_FACTORY_ENABLED }}");
  });
});

describe("the three languages", () => {
  function shape(v: unknown, path = ""): Record<string, string> {
    if (typeof v === "string") return { [path]: (v.match(/\{\w+\}/g) ?? []).sort().join(",") };
    return Object.entries(v as Record<string, unknown>).reduce((acc, [k, x]) => ({ ...acc, ...shape(x, path ? `${path}.${k}` : k) }), {});
  }

  it("have the same keys, the same {fillers} and no empty string", () => {
    const base = shape(en.seriesPlan);
    expect(Object.keys(base).length).toBeGreaterThan(150);
    for (const [name, dict] of [["ru", ru], ["uz", uz]] as const) {
      const other = shape(dict.seriesPlan);
      expect(Object.keys(other).sort(), name).toEqual(Object.keys(base).sort());
      for (const k of Object.keys(base)) expect(other[k], `${name}.${k} fillers`).toBe(base[k]);
      const strings: string[] = [];
      JSON.stringify(dict.seriesPlan, (_k, v) => (typeof v === "string" ? (strings.push(v), v) : v));
      expect(strings.every((x) => x.trim() !== "")).toBe(true);
    }
  });

  it("really are translated (a copy of the English is a missing translation)", () => {
    const flat = (o: unknown): string[] => (typeof o === "string" ? [o] : Object.values(o as object).flatMap(flat));
    const english = flat(en.seriesPlan);
    for (const dict of [ru, uz]) {
      const other = flat(dict.seriesPlan);
      const same = other.filter((s, i) => s === english[i] && /[a-z]{4}/.test(s));
      expect(same).toEqual([]);
    }
  });

  it("the not-fact-checked label is in all three", () => {
    expect(en.seriesPlan.notFactChecked.label).toBe("Not fact-checked");
    expect(ru.seriesPlan.notFactChecked.label).toMatch(/не проверен/i);
    expect(uz.seriesPlan.notFactChecked.label).toMatch(/tekshirilmagan/i);
  });
});
