/**
 * The Series Factory page's pure logic (slice S3, docs/SERIES_FACTORY.md): what a plan and its episodes look like once read, the price
 * of a series from the DATABASE's per-episode quotes, which chip an episode wears, and what each refusal of the two database functions
 * means to a person. No server import, no network: the page, the form and the tests all use it.
 *
 * Three rules this file exists to keep:
 *
 *  - **Model text is untrusted.** Everything under `outline` (titles, angles, hooks, calls to action, key facts) and the topic of an
 *    episode was written by a model in one call and read by nobody. It is cut to a bounded plain string here (control, bidi and
 *    zero-width characters removed), so a hostile string cannot hide text, reorder it or fill the screen; and it only ever reaches
 *    the page as a React text node (never HTML, a URL, a class or an attribute).
 *  - **"Not fact-checked" is the default, not a finding.** A plan says `fact_checked: false`; anything else, including a missing
 *    field, is read the same way (CLAUDE.md rule 5). Nothing here can turn the label off.
 *  - **The price is the database's.** `quote_series_episode` computes it; the browser sends back the number it saw and the database
 *    refuses unless it still equals the current price (`price_changed`). A price that could not be read is "unavailable", never 0.
 */

import { INSUFFICIENT_CREDITS_CODE, RUN_LIMIT_CODE, parseInsufficient, parseRunLimit, roundUpCredits } from "./credits";

// ── ids and columns ──────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A plan or an episode id (a uuid). Anything else is not a row of ours: the page answers 404 before it asks the database. */
export function isSeriesId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** A storyboard id, as it is used in a link. */
export const isStoryboardLinkId = isSeriesId;

/** A YouTube video id, as it is used in a link: the characters of an id and nothing that could change a path. */
export function isVideoLinkId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(value);
}

export const PLAN_COLUMNS =
  "id,channel_id,series_id,topic,niche,language,n_episodes,duration_s,status,title,report,quote,error_code,render_job_id,created_at,finished_at";
export const EPISODE_COLUMNS =
  "id,plan_id,n,topic,outline,usable,needs_confirmation,duration_s,status,credit_ref,credits_held,render_job_id,started_at";

/** The episode lengths the form offers, in seconds (the database accepts 30 to 3600). */
export const EPISODE_LENGTHS_S = [60, 180, 300, 480, 600] as const;
export const DEFAULT_EPISODE_LENGTH_S = 300;
/** `plan_series` refuses a topic over this many characters (modules/series_planner.MAX_TOPIC_INPUT), so the form does too. */
export const MAX_TOPIC_CHARS = 200;
export const EPISODE_COUNTS = [3, 4] as const;

/** The three languages the page and the planner share, as the ENGLISH names the database accepts (`request_series_plan` refuses
 *  any other alphabet: it must not be sent the interface string "Русский" or "O'zbek"). */
export const PLAN_LANGUAGES = [
  { locale: "en", name: "English" },
  { locale: "ru", name: "Russian" },
  { locale: "uz", name: "Uzbek" },
] as const;

export function planLanguageFor(locale: string): string {
  return PLAN_LANGUAGES.find((l) => l.locale === locale)?.name ?? "English";
}

// ── closed words ─────────────────────────────────────────────────────────────

/** The words the worker adds when it ends a plan (modules/series_plan_worker.WORKER_CODES; tests/test_series_plan_worker.py pins the two equal). */
export const WORKER_ERROR_CODES = [
  "planner_not_enabled",
  "gemini_quota",
  "timeout",
  "no_gemini_key",
  "channel_refused",
  "plan_mismatch",
  "result_too_large",
  "worker_error",
] as const;

/** The words the pure planner raises (modules/series_planner.SeriesPlanError); each one has a sentence below, so no failed plan shows a raw word. */
export const PLANNER_ERROR_CODES = [
  "bad_count",
  "bad_input",
  "bad_language",
  "bad_template",
  "no_niche",
  "generate_failed",
  "empty_response",
  "response_too_large",
  "not_json",
  "bad_shape",
  "wrong_count",
  "bad_field",
  "too_long",
  "markup",
  "cue_tag",
  "hidden_characters",
  "injection",
  "duplicate_topics",
  "expired",
] as const;

export type PlanErrorKey =
  | (typeof WORKER_ERROR_CODES)[number]
  | "no_niche"
  | "generate_failed"
  | "expired"
  | "bad_input"
  | "bad_template"
  | "unusable_answer"
  | "unknown";

/** Which sentence a failed plan's `error_code` gets. A word nobody knows is `unknown`, never shown raw. */
export function planErrorKey(code: unknown): PlanErrorKey {
  if (typeof code !== "string") return "unknown";
  if ((WORKER_ERROR_CODES as readonly string[]).includes(code)) return code as PlanErrorKey;
  if (code === "no_niche" || code === "generate_failed" || code === "expired") return code;
  // The format the person picked does not fit the count or the length they chose (migration 0122): they change one and plan again.
  if (code === "bad_template") return code;
  // The request itself could not be used (topic too long or hidden characters, language, count): the person changes it. Not "the answer".
  if (code === "bad_input" || code === "bad_language" || code === "bad_count") return "bad_input";
  if ((PLANNER_ERROR_CODES as readonly string[]).includes(code)) return "unusable_answer";
  return "unknown";
}

// ── untrusted text ───────────────────────────────────────────────────────────

/** Control characters, line and paragraph separators, bidi overrides and isolates, zero-width and byte-order marks, as code point
 *  ranges (built at load, so the source itself holds no invisible character). */
const INVISIBLE_RANGES: [number, number][] = [
  [0x0, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
];
const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join("")}]`,
  "g",
);

/** One bounded, single-line plain string from anything: not a string is "", whitespace is collapsed, the rest is cut at `max`. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}

function cleanList(value: unknown, max: number, items: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, items).map((v) => cleanText(v, max)).filter((s) => s !== "");
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

// ── a plan ───────────────────────────────────────────────────────────────────

export type PlanStatus = "requested" | "ready" | "failed";
/** The planner's verdict on the whole plan (modules/series_planner.SeriesPlan.status). */
export type PlanVerdict = "ready" | "ready_unconfirmed" | "partial" | "blocked";
const VERDICTS: readonly PlanVerdict[] = ["ready", "ready_unconfirmed", "partial", "blocked"];

export interface ReportView {
  /** Never read as "checked": see `factChecked`. */
  verdict: PlanVerdict | null;
  /** True ONLY for the literal `true`; there is no path in the product that sets it. */
  factChecked: boolean;
  unconfirmedCount: number;
  /** `true`: some held topics were found and used. `null`: not known (the manager cannot tell none from unreadable). Never "checked, none". */
  heldTopicsChecked: boolean | null;
  geminiCallsMade: number | null;
}

export interface PlanView {
  id: string;
  channelId: string;
  seriesId: string | null;
  topic: string;
  language: string;
  nEpisodes: number;
  durationS: number;
  status: PlanStatus;
  title: string;
  errorCode: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  report: ReportView | null;
}

export function parseReport(raw: unknown): ReportView | null {
  const r = obj(raw);
  if (!r) return null;
  const verdict = typeof r.status === "string" && (VERDICTS as readonly string[]).includes(r.status) ? (r.status as PlanVerdict) : null;
  return {
    verdict,
    factChecked: r.fact_checked === true,
    unconfirmedCount: whole(r.unconfirmed_count) ?? 0,
    heldTopicsChecked: r.held_topics_checked === true ? true : null,
    geminiCallsMade: whole(r.gemini_calls_made),
  };
}

export function parsePlan(row: unknown): PlanView | null {
  const r = obj(row);
  if (!r || !isSeriesId(r.id)) return null;
  const status = r.status === "requested" || r.status === "ready" || r.status === "failed" ? r.status : null;
  const nEpisodes = whole(r.n_episodes);
  const durationS = whole(r.duration_s);
  if (!status || typeof r.channel_id !== "string" || nEpisodes === null || durationS === null) return null;
  return {
    id: r.id,
    channelId: r.channel_id,
    seriesId: typeof r.series_id === "string" ? r.series_id : null,
    topic: cleanText(r.topic, 300),
    language: cleanText(r.language, 40),
    nEpisodes,
    durationS,
    status,
    title: cleanText(r.title, 200),
    errorCode: typeof r.error_code === "string" ? r.error_code.slice(0, 48) : null,
    createdAt: typeof r.created_at === "string" ? r.created_at : null,
    finishedAt: typeof r.finished_at === "string" ? r.finished_at : null,
    report: parseReport(r.report),
  };
}

// ── an episode and its outline ───────────────────────────────────────────────

export interface OutlineView {
  topic: string;
  workingTitle: string;
  angle: string;
  hookSentence: string;
  hookVariants: string[];
  ctaVariants: string[];
  openLoop: string;
  cliffhanger: string;
  keyFacts: string[];
  /** The planner's fixed words for why it is not usable (off_niche, needs_human, repeat, ...). */
  reasons: string[];
  /** `unchecked` / `unverified` / `gate_off`: accepted with no model confirming the niche. */
  vetDetail: string;
  /** The channel's own earlier topic this one repeats (data: shown escaped). */
  repeatOf: string | null;
  nicheConfirmed: boolean;
}

export function parseOutline(raw: unknown): OutlineView {
  const o = obj(raw) ?? {};
  const vet = obj(o.vet) ?? {};
  return {
    topic: cleanText(o.topic, 160),
    workingTitle: cleanText(o.working_title, 120),
    angle: cleanText(o.angle, 320),
    hookSentence: cleanText(o.hook_sentence, 220),
    hookVariants: cleanList(o.hook_variants, 220, 3),
    ctaVariants: cleanList(o.cta_variants, 180, 3),
    openLoop: cleanText(o.open_loop, 320),
    cliffhanger: cleanText(o.cliffhanger, 320),
    keyFacts: cleanList(o.key_facts, 320, 6),
    reasons: cleanList(o.reasons, 40, 6),
    vetDetail: cleanText(vet.detail, 40),
    repeatOf: typeof o.repeat_of === "string" && o.repeat_of ? cleanText(o.repeat_of, 160) : null,
    nicheConfirmed: o.niche_confirmed === true,
  };
}

export type EpisodeStatus = "planned" | "started";

export interface EpisodeView {
  id: string;
  planId: string;
  n: number;
  topic: string;
  outline: OutlineView;
  usable: boolean;
  needsConfirmation: boolean;
  durationS: number;
  status: EpisodeStatus;
  creditsHeld: number | null;
  renderJobId: number | null;
  startedAt: string | null;
}

export function parseEpisode(row: unknown): EpisodeView | null {
  const r = obj(row);
  if (!r || !isSeriesId(r.id) || !isSeriesId(r.plan_id)) return null;
  const n = whole(r.n);
  const durationS = whole(r.duration_s);
  if (n === null || n < 1 || n > 4 || durationS === null || typeof r.usable !== "boolean") return null;
  const held = typeof r.credits_held === "number" ? r.credits_held : typeof r.credits_held === "string" ? Number(r.credits_held) : null;
  return {
    id: r.id,
    planId: r.plan_id,
    n,
    topic: cleanText(r.topic, 300),
    outline: parseOutline(r.outline),
    usable: r.usable,
    needsConfirmation: r.needs_confirmation === true,
    durationS,
    status: r.status === "started" ? "started" : "planned",
    creditsHeld: held !== null && Number.isFinite(held) ? held : null,
    renderJobId: whole(r.render_job_id),
    startedAt: typeof r.started_at === "string" ? r.started_at : null,
  };
}

/** Why an accepted episode still needs a person: the gate's words could not place it in the niche and no model was asked. */
export type ConfirmReason = "unchecked" | "unverified" | "gate_off" | "unconfirmed";

export function confirmReason(outline: OutlineView): ConfirmReason {
  return outline.vetDetail === "unchecked" || outline.vetDetail === "unverified" || outline.vetDetail === "gate_off"
    ? outline.vetDetail
    : "unconfirmed";
}

/** The gate's own reasons (modules/topic_gate.REASONS) and the planner's, as keys of the dictionary; anything else is `other`. */
export const REASON_KEYS = ["off_niche", "needs_human", "stale", "unconfirmed", "vet_error", "repeat", "repeat_check_error"] as const;
export type ReasonKey = (typeof REASON_KEYS)[number] | "other";

export function reasonKey(word: string): ReasonKey {
  return (REASON_KEYS as readonly string[]).includes(word) ? (word as ReasonKey) : "other";
}

// ── the price (the database's) ───────────────────────────────────────────────

export type PriceStatus = "priced" | "unpriced" | "included";

export interface QuoteView {
  status: EpisodeStatus;
  priceStatus: PriceStatus;
  /** Credits for `priced`; null for `unpriced` and `included` (the operator's own organization pays nothing: not "0 credits"). */
  credits: number | null;
  needsConfirmation: boolean;
  /** The database's word for why the episode cannot start now (earlier_episode_not_finished, plan_not_ready, ...), or null. */
  blockedBy: string | null;
  mayStart: boolean;
  startable: boolean;
}

/** `quote_series_episode`'s answer, or null when it is not one we understand: an episode with no readable quote shows "price unavailable". */
export function parseQuote(raw: unknown): QuoteView | null {
  const r = obj(raw);
  if (!r) return null;
  const priceStatus = r.price_status === "priced" || r.price_status === "unpriced" || r.price_status === "included" ? r.price_status : null;
  if (!priceStatus) return null;
  let credits: number | null = null;
  if (priceStatus === "priced") {
    const c = typeof r.credits === "number" ? r.credits : typeof r.credits === "string" ? Number(r.credits) : NaN;
    if (!Number.isFinite(c) || c < 0) return null;
    credits = c;
  }
  return {
    status: r.status === "started" ? "started" : "planned",
    priceStatus,
    credits,
    needsConfirmation: r.needs_confirmation === true,
    blockedBy: typeof r.blocked_by === "string" ? r.blocked_by : null,
    mayStart: r.may_start === true,
    startable: r.startable === true,
  };
}

export type SeriesTotal =
  | { kind: "none" }
  | { kind: "included" }
  | { kind: "incomplete"; unknownEpisodes: number[] }
  | { kind: "priced"; credits: number; episodes: number };

/**
 * The price of making every USABLE episode of the series, from the database's per-episode quotes (a refused episode never starts, so it
 * is not in it). Never a partial sum: if any usable episode has no price (unpriced, or its quote could not be read) the total is
 * `incomplete`, not a smaller number. The sum is rounded up to the cent, as a hold is (`roundUpCredits`).
 */
export function seriesTotal(items: { n: number; usable: boolean; quote: QuoteView | null }[]): SeriesTotal {
  const usable = items.filter((i) => i.usable);
  if (usable.length === 0) return { kind: "none" };
  const unknown = usable.filter((i) => !i.quote || i.quote.priceStatus === "unpriced").map((i) => i.n);
  if (unknown.length > 0) return { kind: "incomplete", unknownEpisodes: unknown };
  if (usable.every((i) => i.quote?.priceStatus === "included")) return { kind: "included" };
  let sum = 0;
  for (const i of usable) {
    if (i.quote?.priceStatus !== "priced" || i.quote.credits === null) return { kind: "incomplete", unknownEpisodes: [i.n] };
    sum += i.quote.credits;
  }
  return { kind: "priced", credits: roundUpCredits(sum), episodes: usable.length };
}

/** What the series total counts, said in numbers: how many STARTED episodes it includes, and what is held for them (null when a started
 *  episode's held amount is not a number, e.g. the operator's own organization holds nothing). */
export function startedSummary(items: { usable: boolean; status: EpisodeStatus; creditsHeld: number | null }[]): { count: number; held: number | null } {
  const started = items.filter((i) => i.usable && i.status === "started");
  if (started.length === 0) return { count: 0, held: null };
  const held = started.every((i) => i.creditsHeld !== null) ? roundUpCredits(started.reduce((a, i) => a + (i.creditsHeld ?? 0), 0)) : null;
  return { count: started.length, held };
}

// ── the status chip ──────────────────────────────────────────────────────────

export type ChipKey =
  | "refused" // the planner refused this episode: it never starts
  | "needs_confirm" // usable, but a person must confirm its niche first
  | "ready" // can start now
  | "blocked" // waits for an earlier episode (or another database reason)
  | "unpriced" // no price: it cannot start
  | "unavailable" // its quote could not be read
  | "started" // started, and nothing more is known
  | "queued"
  | "running"
  | "storyboard" // a storyboard is waiting (link)
  | "video" // a video exists (link)
  | "finished" // the run succeeded, but no storyboard or video could be found
  | "failed"
  | "cancelled";

export interface EpisodeLinks {
  jobStatus: string | null;
  storyboard: { id: string; status: string } | null;
  video: { id: string } | null;
}

export interface Chip {
  key: ChipKey;
  /** A link target section and id, for the chips that go to a page. */
  link: { section: "storyboard" | "video"; id: string } | null;
}

/** Which chip an episode wears. A planned one by its quote; a started one by its run, its storyboard and its video. */
export function episodeChip(ep: Pick<EpisodeView, "usable" | "needsConfirmation" | "status">, quote: QuoteView | null, links: EpisodeLinks | null): Chip {
  const plain = (key: ChipKey): Chip => ({ key, link: null });
  if (ep.status === "planned") {
    if (!ep.usable) return plain("refused");
    if (!quote) return plain("unavailable");
    if (quote.blockedBy) return plain("blocked");
    if (quote.priceStatus === "unpriced") return plain("unpriced");
    return plain(ep.needsConfirmation ? "needs_confirm" : "ready");
  }
  const job = links?.jobStatus ?? null;
  if (job === "failed") return plain("failed");
  if (job === "cancelled") return plain("cancelled");
  if (job === "queued") return plain("queued");
  if (job === "running") return plain("running");
  const sb = links?.storyboard ?? null;
  const video = links?.video ?? null;
  if (sb && sb.status === "ready" && isStoryboardLinkId(sb.id)) return { key: "storyboard", link: { section: "storyboard", id: sb.id } };
  if (video && isVideoLinkId(video.id)) return { key: "video", link: { section: "video", id: video.id } };
  if (sb && isStoryboardLinkId(sb.id)) return { key: "storyboard", link: { section: "storyboard", id: sb.id } };
  if (job === "succeeded") return plain("finished");
  return plain("started");
}

/** The path (under the channel) a chip links to. Ids are checked again here: a link is never built from text that is not an id. */
export function chipHref(path: (section: string) => string, chip: Chip): string | null {
  if (!chip.link) return null;
  if (chip.link.section === "storyboard") return isStoryboardLinkId(chip.link.id) ? path(`/videos/storyboard/${chip.link.id}`) : null;
  return isVideoLinkId(chip.link.id) ? path(`/videos/${chip.link.id}`) : null;
}

// ── how often a plan being made is looked at ─────────────────────────────────

/** Every 5 seconds for the plan's first 2 minutes, then every 30 seconds, then not at all after 10 minutes (the person presses Check again). */
export const POLL_FAST_MS = 5_000;
export const POLL_SLOW_MS = 30_000;
export const POLL_FAST_FOR_MS = 2 * 60_000;
export const POLL_STOP_AFTER_MS = 10 * 60_000;

/** The wait before the next look at a plan that is `ageMs` old, or null when the page should stop looking by itself. */
export function nextPollDelay(ageMs: number): number | null {
  if (!Number.isFinite(ageMs) || ageMs < 0) return POLL_FAST_MS;
  if (ageMs >= POLL_STOP_AFTER_MS) return null;
  return ageMs >= POLL_FAST_FOR_MS ? POLL_SLOW_MS : POLL_FAST_MS;
}

// ── what a refusal means ─────────────────────────────────────────────────────

export interface DbError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
  status?: number | null;
}

export type StartErrorKey =
  | "price_changed"
  | "insufficient"
  | "unpriced"
  | "earlier_episode_not_finished"
  | "rate_limited"
  | "run_limit"
  | "forbidden"
  | "confirmation_required"
  | "price_required"
  | "already_started"
  | "plan_not_ready"
  | "episode_not_usable"
  | "series_not_runnable"
  | "not_found"
  | "idempotency_conflict"
  | "failed";

export interface StartError {
  key: StartErrorKey;
  /** `price_changed`: the price the database holds now. */
  credits?: number;
  /** `insufficient`: what the account has and what the hold needs. */
  available?: number | null;
  needed?: number | null;
  /** `run_limit`: the plan's parallel runs. */
  limit?: number | null;
}

const START_WORDS: Record<string, StartErrorKey> = {
  price_changed: "price_changed",
  unpriced: "unpriced",
  earlier_episode_not_finished: "earlier_episode_not_finished",
  confirmation_required: "confirmation_required",
  price_required: "price_required",
  already_started: "already_started",
  plan_not_ready: "plan_not_ready",
  episode_not_usable: "episode_not_usable",
  series_not_runnable: "series_not_runnable",
  idempotency_conflict: "idempotency_conflict",
  rate_limited: "rate_limited",
  forbidden: "forbidden",
  not_found: "not_found",
};

/** `start_series_episode`'s refusal, as a key (and the numbers its detail carries). The message is the database's fixed word; the
 *  detail carries `credits=15.00`, `available=… needed=…` or `active=… limit=…`. Anything else is `failed`: nothing is guessed. */
export function startError(error: DbError | null | undefined): StartError {
  if (!error) return { key: "failed" };
  const word = String(error.message ?? "").trim();
  if (error.code === INSUFFICIENT_CREDITS_CODE) {
    const p = parseInsufficient({ code: error.code, details: error.details ?? null });
    return { key: "insufficient", available: p?.available ?? null, needed: p?.needed ?? null };
  }
  if (error.code === RUN_LIMIT_CODE) {
    const limit = parseRunLimit({ code: error.code, details: error.details ?? null });
    // reserve_credits' own "parallel run limit reached" is a different refusal from the plan press cap; both say "wait".
    if (/parallel/i.test(word)) return { key: "run_limit", limit: limit?.limit ?? null };
    return { key: "rate_limited" };
  }
  const key = START_WORDS[word];
  if (key === "price_changed") {
    const m = /credits=([\d.]+)/.exec(error.details ?? "");
    const credits = m ? Number(m[1]) : NaN;
    return Number.isFinite(credits) ? { key, credits } : { key };
  }
  if (key) return { key };
  if (error.code === "42501") return { key: "forbidden" };
  if (error.code === "P0002") return { key: "not_found" };
  return { key: "failed" };
}

export type RequestErrorKey =
  | "not_available" // the database refused the call itself: the function is not granted (or not installed) yet
  | "forbidden"
  | "voice"
  | "plan_in_progress"
  | "rate_limited"
  | "series_user_cap" // migration 0127: this person's plans in the last 24 hours
  | "series_global_cap" // migration 0127: every organization's plans in the last 24 hours
  | "invalid_topic"
  | "invalid_count"
  | "invalid_duration"
  | "invalid_language"
  | "invalid_template"
  | "no_niche"
  | "not_found"
  | "idempotency_conflict"
  | "failed";

export interface RequestError {
  key: RequestErrorKey;
  limit?: number | null;
}

const REQUEST_WORDS: Record<string, RequestErrorKey> = {
  plan_in_progress: "plan_in_progress",
  rate_limited: "rate_limited",
  series_user_cap: "series_user_cap",
  series_global_cap: "series_global_cap",
  invalid_topic: "invalid_topic",
  invalid_episode_count: "invalid_count",
  invalid_duration: "invalid_duration",
  invalid_language: "invalid_language",
  invalid_template: "invalid_template",
  no_niche: "no_niche",
  idempotency_conflict: "idempotency_conflict",
  invalid_idempotency_key: "failed",
  not_found: "not_found",
  forbidden: "forbidden",
};

/**
 * `request_series_plan`'s refusal, as a key. The function is granted to nobody until the owner decides (docs/SERIES_FACTORY.md), and
 * the database's answer to a call it does not allow is "permission denied for function" (42501), "could not find the function"
 * (PGRST202 / 42883) or a 404: all of them are "not available yet", never "forbidden" (which is the function's OWN word for a viewer)
 * and never a vague failure. Nothing was queued in any of those cases.
 */
export function requestError(error: DbError | null | undefined): RequestError {
  if (!error) return { key: "failed" };
  const word = String(error.message ?? "").trim();
  const text = `${word} ${error.details ?? ""} ${error.hint ?? ""}`;
  if (/voice_not_allowed/i.test(text)) return { key: "voice" };
  if (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    error.status === 404 ||
    (error.code === "42501" && /permission denied/i.test(word)) ||
    /could not find the function|function .* does not exist/i.test(word)
  ) {
    return { key: "not_available" };
  }
  const key = REQUEST_WORDS[word];
  if (key === "rate_limited") {
    const m = /limit=(\d+)/.exec(error.details ?? "");
    return { key, limit: m ? Number(m[1]) : null };
  }
  if (key) return { key };
  if (error.code === "42501") return { key: "forbidden" };
  if (error.code === "P0002") return { key: "not_found" };
  return { key: "failed" };
}

/** `quote_series_episode`'s blocked_by words that have their own sentence; any other is shown as the generic "cannot start now". */
export const BLOCKED_WORDS = [
  "earlier_episode_not_finished",
  "plan_not_ready",
  "already_started",
  "episode_not_usable",
  "not_found",
] as const;
export type BlockedKey = (typeof BLOCKED_WORDS)[number] | "other";

export function blockedKey(word: string | null): BlockedKey | null {
  if (!word) return null;
  return (BLOCKED_WORDS as readonly string[]).includes(word) ? (word as BlockedKey) : "other";
}

/** The idempotency key of one episode start: the database requires exactly this (`se:<episode id>`). */
export function startKey(episodeId: string): string {
  return `se:${episodeId}`;
}

/** A fresh key for one "plan a series" press: stable across a double tap or a retry of the SAME inputs, new for new inputs. */
export function newPlanKey(random: () => string): string {
  return `sp:${random().replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 100)}`;
}
