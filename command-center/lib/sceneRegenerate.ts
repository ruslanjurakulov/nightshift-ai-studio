/**
 * Scene regeneration v2 (migration 0076, modules/scene_regenerate.py) — the
 * pure half: the shapes the video page reads, the quote the button shows, and
 * how the database's refusals become route answers and sentences.
 *
 * "Regenerate scene" is ONE priced, confirmed press for ONE scene of a run
 * that has not uploaded:
 *  - the price comes from the database (quote_scene_regenerate), computed from
 *    the run's own Video IR and the price list — never from the browser, and
 *    an unset price is "unpriced", never 0;
 *  - the scene is made again with the SAME source it was made with (the same
 *    generator, or stock); stock replaces a generated scene only when the
 *    person ticks that choice, and the choice is recorded;
 *  - the press carries the price it showed (max_credits) and one idempotency
 *    key; the database holds exactly the quote, queues one job, and refuses a
 *    changed price, a second press while one runs, and a published video.
 *
 * Nothing here spends, renders or publishes: the button calls one route, the
 * route calls one database function. Client-safe and pure, so it is
 * unit-tested directly (tests/sceneRegenerate.test.ts).
 */

import { fmt, type Dictionary } from "@/lib/i18n";

export type RegenSource = "same" | "stock";
export type RegenStatus = "queued" | "running" | "succeeded" | "failed";

const SCENE_ID = /^s\d{3,4}$/;
/** Held runs are "run-" + 20 hex; uploaded ones a YouTube id. */
const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IDEM = /^[A-Za-z0-9_:.-]{8,128}$/;
export const MAX_PROMPT = 1000;

export function isSceneId(v: unknown): v is string {
  return typeof v === "string" && SCENE_ID.test(v);
}
export function isVideoId(v: unknown): v is string {
  return typeof v === "string" && VIDEO_ID.test(v);
}
export function isIdempotencyKey(v: unknown): v is string {
  return typeof v === "string" && IDEM.test(v);
}
export function isSource(v: unknown): v is RegenSource {
  return v === "same" || v === "stock";
}

/** A prompt edit as the database will accept it: trimmed, bounded, no
 *  control characters. Empty means "no edit". Null when it is not acceptable. */
export function cleanPrompt(v: unknown): string | null | undefined {
  if (v == null) return undefined;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return undefined;
  // eslint-disable-next-line no-control-regex
  if (t.length > MAX_PROMPT || /[\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

/** One key per intended press: a retry of the same press (a dropped
 *  connection, a double click) sends the same key and gets the same job. */
export function newIdempotencyKey(rand: () => string = () => globalThis.crypto.randomUUID()): string {
  return `scene-regen:${rand()}`;
}

// ── the quote ───────────────────────────────────────────────────────────────

export type QuoteStatus = "priced" | "included" | "unpriced" | "unavailable";

/** Why a scene cannot be regenerated, as quote_scene_regenerate says it. */
export type UnavailableReason =
  | "published"
  | "no_run"
  | "in_progress"
  | "no_manifest"
  | "scene_not_found"
  | "scene_has_no_footage"
  | "too_many_assets"
  | "asset_missing"
  | "source_not_recorded"
  | "generator_not_recorded"
  | "generator_model_not_recorded"
  | "mixed_generators"
  | "generated_stills_not_supported"
  | "stock_source_not_supported"
  | "invalid_scene"
  | "invalid_source"
  | "unknown";

const REASONS: readonly string[] = [
  "published", "no_run", "in_progress", "no_manifest", "scene_not_found", "scene_has_no_footage",
  "too_many_assets", "asset_missing", "source_not_recorded", "generator_not_recorded",
  "generator_model_not_recorded", "mixed_generators", "generated_stills_not_supported",
  "stock_source_not_supported", "invalid_scene", "invalid_source",
];

export interface RegenQuote {
  status: QuoteStatus;
  /** Credits for this press — only when status is "priced". Never 0 for "unknown". */
  credits: number | null;
  reason: UnavailableReason | null;
  /** May this person press (an admin of the channel's organization)? */
  mayStart: boolean;
  sourceKind: "generated" | "stock" | null;
  /** The scene had generated clips: offering the explicit stock choice makes sense. */
  hadGenerated: boolean;
  explicitStock: boolean;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The database's quote jsonb → what the button needs. Anything unexpected
 *  reads as unavailable, never as a price. */
export function parseQuote(raw: unknown): RegenQuote {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const statusRaw = typeof r.status === "string" ? r.status : "";
  const status: QuoteStatus = (["priced", "included", "unpriced", "unavailable"] as const).includes(
    statusRaw as QuoteStatus,
  )
    ? (statusRaw as QuoteStatus)
    : "unavailable";
  const credits = status === "priced" ? num(r.credits) : null;
  const reasonRaw = typeof r.reason === "string" ? r.reason : null;
  const sourceKind = r.source_kind === "generated" || r.source_kind === "stock" ? r.source_kind : null;
  const out: RegenQuote = {
    status,
    credits: credits !== null && credits > 0 ? credits : null,
    reason: status === "unavailable" ? ((reasonRaw && REASONS.includes(reasonRaw) ? reasonRaw : "unknown") as UnavailableReason) : null,
    mayStart: r.may_start === true,
    sourceKind,
    hadGenerated: r.had_generated === true || sourceKind === "generated" || r.explicit_stock === true,
    explicitStock: r.explicit_stock === true,
  };
  // A "priced" quote without a positive number is not a price.
  if (status === "priced" && out.credits === null) return { ...out, status: "unavailable", reason: "unknown" };
  return out;
}

/** May the button be pressed for this quote? */
export function canPress(q: RegenQuote | null): boolean {
  return !!q && q.mayStart && (q.status === "priced" || q.status === "included");
}

// ── the rows the page reads ─────────────────────────────────────────────────

export const REGEN_COLUMNS =
  "id,scene_id,status,source_kind,explicit_stock,quoted_credits,charged_credits,error_code,previous_asset_ids,created_at,finished_at";

export interface RegenRow {
  id: string;
  sceneId: string;
  status: RegenStatus;
  sourceKind: "generated" | "stock";
  explicitStock: boolean;
  quotedCredits: number | null;
  chargedCredits: number | null;
  errorCode: string | null;
  previousAssetIds: string[];
  createdAt: string | null;
  finishedAt: string | null;
}

export function parseRegenRows(rows: unknown): RegenRow[] {
  if (!Array.isArray(rows)) return [];
  const out: RegenRow[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !isSceneId(r.scene_id)) continue;
    const status = r.status;
    if (status !== "queued" && status !== "running" && status !== "succeeded" && status !== "failed") continue;
    out.push({
      id: r.id,
      sceneId: r.scene_id,
      status,
      sourceKind: r.source_kind === "generated" ? "generated" : "stock",
      explicitStock: r.explicit_stock === true,
      quotedCredits: num(r.quoted_credits),
      chargedCredits: num(r.charged_credits),
      errorCode: typeof r.error_code === "string" ? r.error_code : null,
      previousAssetIds: Array.isArray(r.previous_asset_ids) ? r.previous_asset_ids.filter((x): x is string => typeof x === "string") : [],
      createdAt: typeof r.created_at === "string" ? r.created_at : null,
      finishedAt: typeof r.finished_at === "string" ? r.finished_at : null,
    });
  }
  return out;
}

/** The newest regeneration of each scene (rows may come in any order). */
export function latestByScene(rows: readonly RegenRow[]): Map<string, RegenRow> {
  const out = new Map<string, RegenRow>();
  for (const r of rows) {
    const cur = out.get(r.sceneId);
    if (!cur || (r.createdAt ?? "") > (cur.createdAt ?? "")) out.set(r.sceneId, r);
  }
  return out;
}

// ── the route's answers ─────────────────────────────────────────────────────

type DbError = { code?: string; message?: string; details?: string | null; hint?: string | null };

function detailNumber(text: string | null | undefined, key: string): number | null {
  const m = new RegExp(`${key}=([0-9.]+)`).exec(text ?? "");
  return m ? Number(m[1]) : null;
}

/** A quote / press RPC error → the route's answer. The code is the contract;
 *  the body carries only what the person may see (their own price, balance). */
export function mapRegenError(error: DbError): { status: number; body: Record<string, unknown> } {
  const code = error.code ?? "";
  const msg = (error.message ?? "").trim();
  if (code === "42501") return { status: 403, body: { error: "forbidden" } };
  if (code === "NS402")
    return {
      status: 402,
      body: {
        error: "insufficient_credits",
        needed: detailNumber(error.details, "needed"),
        available: detailNumber(error.details, "available"),
      },
    };
  if (code === "NS429") return { status: 429, body: { error: "run_limit" } };
  if (code === "NS409" && msg === "price_changed")
    return { status: 409, body: { error: "price_changed", credits: detailNumber(error.details, "credits") } };
  if (code === "NS409" && ["published", "in_progress", "idempotency_conflict"].includes(msg))
    return { status: 409, body: { error: msg } };
  if (code === "NS400" && msg === "unpriced") return { status: 409, body: { error: "unpriced" } };
  if (code === "NS400" && msg === "scene_unavailable") {
    const reason = (error.details ?? "").trim();
    return { status: 409, body: { error: "scene_unavailable", reason: REASONS.includes(reason) ? reason : "unknown" } };
  }
  if (code === "22023" && msg === "price_required")
    return { status: 409, body: { error: "price_required", credits: detailNumber(error.details, "credits") } };
  if (code === "22023" && ["invalid_scene", "invalid_source", "invalid_prompt", "invalid_idempotency_key"].includes(msg))
    return { status: 400, body: { error: msg } };
  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205" || /does not exist|could not find/i.test(msg))
    return { status: 503, body: { error: "regen_unavailable" } };
  return { status: 502, body: { error: "regen_failed" } };
}

// ── what the screen says ────────────────────────────────────────────────────

type T = Dictionary["sceneRegen"];

export function reasonText(reason: UnavailableReason | string | null, t: T): string {
  const r = (reason ?? "unknown") as keyof T["reasons"];
  return t.reasons[r] ?? t.reasons.unknown;
}

/** The sentence for a route's error body. */
export function regenErrorText(body: Record<string, unknown> | null, t: T): string {
  const error = typeof body?.error === "string" ? body.error : "";
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "?");
  switch (error) {
    case "forbidden":
      return t.errors.forbidden;
    case "insufficient_credits":
      return fmt(t.errors.insufficient, { needed: n(body?.needed), available: n(body?.available) });
    case "run_limit":
      return t.errors.runLimit;
    case "price_changed":
      return fmt(t.errors.priceChanged, { credits: n(body?.credits) });
    case "price_required":
      return t.errors.priceRequired;
    case "published":
      return t.reasons.published;
    case "in_progress":
      return t.reasons.in_progress;
    case "idempotency_conflict":
      return t.errors.conflict;
    case "unpriced":
      return t.unpriced;
    case "scene_unavailable":
      return reasonText(typeof body?.reason === "string" ? body.reason : null, t);
    case "queue_required":
      return t.errors.queueRequired;
    case "invalid_prompt":
      return t.errors.invalidPrompt;
    case "regen_unavailable":
      return t.errors.notInstalled;
    default:
      return t.errors.failed;
  }
}

/** A finished regeneration's line: what happened and what it cost. */
export function rowText(r: RegenRow, t: T): string {
  if (r.status === "queued" || r.status === "running") return r.status === "queued" ? t.status.queued : t.status.running;
  if (r.status === "succeeded") {
    const base = r.chargedCredits !== null ? fmt(t.status.succeeded, { credits: String(r.chargedCredits) }) : t.status.succeededIncluded;
    return r.explicitStock ? `${base} ${t.status.stockChosen}` : base;
  }
  const why = (r.errorCode && (t.failures as Record<string, string>)[r.errorCode]) || t.failures.failed;
  return `${t.status.failed} ${why}`;
}
