/**
 * Private review links (migration 0101) — the pure half, client-safe and
 * unit-tested (tests/review-link.test.ts).
 *
 * A link is a 256-bit token in the URL path (`/r/<token>`). The database keeps
 * only its SHA-256, so the token exists in one place after creation: the link
 * the owner copied. Every refusal a visitor can meet is the same word, "gone"
 * — an unknown, malformed, expired or turned-off link do not read differently.
 */

/** What the owner may choose, in days. The database accepts exactly these. */
export const REVIEW_LINK_DAYS = [1, 3, 7, 14, 30] as const;
export type ReviewLinkDays = (typeof REVIEW_LINK_DAYS)[number];
export const REVIEW_LINK_DEFAULT_DAYS: ReviewLinkDays = 7;

export function parseReviewLinkDays(v: unknown): ReviewLinkDays | null {
  return typeof v === "number" && (REVIEW_LINK_DAYS as readonly number[]).includes(v) ? (v as ReviewLinkDays) : null;
}

/** The token's exact shape: 64 lowercase hex characters (256 bits). */
export const REVIEW_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function isReviewToken(v: unknown): v is string {
  return typeof v === "string" && REVIEW_TOKEN_PATTERN.test(v);
}

/** The path a viewer opens; the origin is added by the caller. */
export function reviewLinkPath(token: string): string {
  return `/r/${token}`;
}

/** One link of a video as the owner's list shows it (never a token or a hash). */
export interface ReviewLinkRow {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  views: number;
  lastViewedAt: string | null;
}

export type ReviewLinkState = "live" | "expired" | "revoked";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isReviewLinkId(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

function iso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

/** Rows from list_review_links(); anything malformed is dropped, never guessed. */
export function coerceReviewLinks(data: unknown): ReviewLinkRow[] {
  if (!Array.isArray(data)) return [];
  const out: ReviewLinkRow[] = [];
  for (const r of data) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const createdAt = iso(o.created_at);
    const expiresAt = iso(o.expires_at);
    if (!isReviewLinkId(o.id) || !createdAt || !expiresAt) continue;
    out.push({
      id: o.id,
      createdAt,
      expiresAt,
      revokedAt: iso(o.revoked_at),
      views: typeof o.views === "number" && Number.isFinite(o.views) && o.views >= 0 ? Math.floor(o.views) : 0,
      lastViewedAt: iso(o.last_viewed_at),
    });
  }
  return out;
}

/** Turned off wins over expired: the owner's action is the more useful fact. */
export function reviewLinkState(row: Pick<ReviewLinkRow, "expiresAt" | "revokedAt">, now: number = Date.now()): ReviewLinkState {
  if (row.revokedAt) return "revoked";
  return Date.parse(row.expiresAt) > now ? "live" : "expired";
}

export type ReviewLinkErrorCode =
  | "unauthorized"
  | "forbidden"
  | "bad_request"
  | "not_found"
  | "no_preview"
  | "limit_reached"
  | "rate_limited"
  | "not_available"
  | "failed";

/** The database's refusals (create_review_link) as the fixed codes the page maps to text. */
export function mapReviewLinkError(error: { code?: string; message?: string } | null | undefined): ReviewLinkErrorCode {
  if (!error) return "failed";
  const msg = error.message ?? "";
  if (error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(msg)) return "not_available";
  if (error.code === "42501") return "unauthorized";
  if (error.code === "P0002" || /not_found/.test(msg)) return "not_found";
  if (/no_preview/.test(msg)) return "no_preview";
  if (error.code === "NS429" || /limit_reached/.test(msg)) return "limit_reached";
  if (error.code === "NS400" || /invalid_days/.test(msg)) return "bad_request";
  return "failed";
}

/**
 * The shape of a language tag the database accepts (en, ru, pt-br, ...). Only the
 * shape: which languages the app can show is decided by lib/i18n, so a new language
 * is data only here.
 */
export const LOCALE_SHAPE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;

export function localeForLink(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return LOCALE_SHAPE.test(s) ? s : null;
}
