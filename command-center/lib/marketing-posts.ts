/**
 * The owner page for the brand channel's posts (migration 0108, docs/MARKETING_POSTS.md).
 *
 * Pure and free of server-only imports, so the route, the page, the client board and the tests share ONE reading of
 * what the database answers:
 *
 *  - the switch (NIGHTSHIFT_MARKETING_POSTS, read in lib/server/marketing.ts),
 *  - the refusals owner_marketing_* can give and the ones the route gives itself,
 *  - the request checks the route makes before it calls the database,
 *  - the rows and the settings document, read defensively (an unknown is `null`, never 0 or "off"),
 *  - the message Telegram will show, mirrored from modules/channel_post.py and pinned against the same fixture
 *    (tests/fixtures/marketing_message_cases.json) by a Python test and a vitest.
 *
 * Nothing in here sends, tests or publishes anything. The only things this page can ask the database for are the four
 * owner functions; the post itself goes out by the worker, after an approval, only while the poster is switched on.
 */
import { charCount, reasonOk, type OwnerCall } from "@/lib/owner-rpc";

/** The switch's value: only `on` turns the page on (the worker reads it the same way: tools/marketing_worker.py posts_switch_on). */
export function parseMarketingFlag(value: string | undefined | null): boolean {
  return (value ?? "").trim() === "on";
}

// ─── Refusals ──────────────────────────────────────────────────────────────────────────────────────

/** Every refusal the owner_marketing_* functions (owner_err) can give, plus the ones the front door and the route give. */
export const MARKETING_REFUSALS = [
  // the front door of every owner function (owner_guard)
  "mfa_required",
  "rate_limited",
  // the posts
  "no_such_post",
  "not_editable",
  "bad_texts",
  "content_hash_required",
  "expired",
  "not_draft",
  /** The poster is switched off in the database: switch it on first, then approve. */
  "poster_off",
  /** The post changed after this page was loaded. */
  "content_changed",
  "facts_stale",
  "cap_full",
  "not_rejectable",
  // the kill switch and the reasons
  "reason_required",
  "bad_arguments",
  // a route's own
  "unauthorized",
  "forbidden",
  "migration_missing",
  "not_found",
  "bad_request",
  "bad_reply",
  "rpc_failed",
  "not_configured",
] as const;
export type MarketingRefusal = (typeof MARKETING_REFUSALS)[number];

export function isMarketingRefusal(code: unknown): code is MarketingRefusal {
  return typeof code === "string" && (MARKETING_REFUSALS as readonly string[]).includes(code);
}

// ─── Requests ──────────────────────────────────────────────────────────────────────────────────────

export type MarketingParse = { ok: true; call: OwnerCall } | { ok: false; error: MarketingRefusal };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
/** Each language is at most this many characters (code points), as marketing_texts_ok demands. */
export const TEXT_MAX = 1000;
export const LANGS = ["uz", "ru", "en"] as const;
export type Lang = (typeof LANGS)[number];
export type Texts = Record<Lang, string>;

const bad = (error: MarketingRefusal): MarketingParse => ({ ok: false, error });
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * The one body the route accepts: `{action, ...}` with exactly four actions. There is deliberately no action that sends,
 * re-sends or tests a post: the only way a post reaches the channel is the worker, after an approval.
 *
 *   edit    {id, texts:{uz,ru,en}}     -> owner_marketing_edit(p_id, p_texts)
 *   approve {id, contentHash}          -> owner_marketing_approve(p_id, p_content_hash)   the hash the owner SAW
 *   reject  {id, reason}               -> owner_marketing_reject(p_id, p_reason)
 *   kill    {kill, reason?}            -> owner_marketing_kill(p_kill, p_reason)          kill:false needs a reason
 *
 * The database checks everything again; these checks exist so a malformed request is a 400 with a code a person can
 * read, not a Postgres error. Extra fields are dropped, never forwarded.
 */
export function parseMarketing(body: unknown): MarketingParse {
  const b = obj(body);
  if (!b) return bad("bad_request");
  const action = str(b.action);
  if (action === "kill") {
    if (typeof b.kill !== "boolean") return bad("bad_arguments");
    // Stopping the poster is always allowed and needs no reason. Switching it ON is the one step that lets approved
    // posts go public, so it needs a written reason (8 to 300 characters), as the database demands.
    if (b.kill) return { ok: true, call: { fn: "owner_marketing_kill", args: { p_kill: true, p_reason: null } } };
    if (!reasonOk(b.reason)) return bad("reason_required");
    return { ok: true, call: { fn: "owner_marketing_kill", args: { p_kill: false, p_reason: (b.reason as string).trim() } } };
  }
  const id = str(b.id);
  if (action !== "edit" && action !== "approve" && action !== "reject") return bad("bad_request");
  if (!id || !UUID.test(id)) return bad("no_such_post");
  if (action === "approve") {
    const hash = str(b.contentHash);
    if (!hash || !HASH.test(hash)) return bad("content_hash_required");
    return { ok: true, call: { fn: "owner_marketing_approve", args: { p_id: id, p_content_hash: hash } } };
  }
  if (action === "reject") {
    if (!reasonOk(b.reason)) return bad("reason_required");
    return { ok: true, call: { fn: "owner_marketing_reject", args: { p_id: id, p_reason: (b.reason as string).trim() } } };
  }
  const t = obj(b.texts);
  if (!t || Object.keys(t).length !== 3) return bad("bad_texts");
  const out: Partial<Texts> = {};
  for (const lang of LANGS) {
    const v = str(t[lang]);
    if (v === null) return bad("bad_texts");
    const trimmed = v.trim();
    const n = charCount(trimmed);
    if (n < 1 || n > TEXT_MAX) return bad("bad_texts");
    out[lang] = trimmed;
  }
  return { ok: true, call: { fn: "owner_marketing_edit", args: { p_id: id, p_texts: { uz: out.uz, ru: out.ru, en: out.en } } } };
}

// ─── The message Telegram will show (a mirror of modules/channel_post.py render) ─────────────────────

/** One label per language, in the order the blocks appear. Sent to Telegram as they are, so they are not translated. */
export const LABELS: Record<Lang, string> = { uz: "Oʻzbekcha", ru: "Русский", en: "English" };
export const MESSAGE_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;

/** Telegram counts UTF-16 units, which is what a JavaScript string's length is. The database counts code points (charCount). */
export const utf16Length = (s: string): number => s.length;

export interface PreviewBlock {
  lang: Lang;
  label: string;
  text: string;
  /** The text alone, in UTF-16 units. */
  units: number;
}

export interface Preview {
  blocks: PreviewBlock[];
  /** The full link, or null (no link on the post, or the site's address is unknown to this page). */
  linkUrl: string | null;
  /** True when the post has a link and the page does not know the site's address: the total then leaves the link out. */
  linkUncounted: boolean;
  /** The whole message as Telegram parses it (plain text), without the link when `linkUncounted`. */
  plain: string;
  /** UTF-16 units of `plain`. With `linkUncounted` this is a lower bound, never the exact figure. */
  total: number;
  limit: number;
  over: boolean;
}

/** An origin the way the sender accepts it: https, or http for localhost; no path. Anything else is unknown (null). */
export function validOrigin(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.username || u.password || (u.pathname !== "" && u.pathname !== "/") || u.search || u.hash) return null;
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** The one message the worker sends for these texts: three labelled blocks in the fixed order, then the link. */
export function buildPreview(texts: Texts, link: string | null, origin: string | null, hasMedia: boolean): Preview {
  const blocks = LANGS.map((lang) => ({ lang, label: LABELS[lang], text: texts[lang], units: utf16Length(texts[lang]) }));
  const site = validOrigin(origin);
  const linkUrl = link && site ? site + link : null;
  const parts = blocks.map((b) => `${b.label}\n${b.text}`);
  if (linkUrl) parts.push(linkUrl);
  const plain = parts.join("\n\n");
  const limit = hasMedia ? CAPTION_LIMIT : MESSAGE_LIMIT;
  const total = utf16Length(plain);
  return { blocks, linkUrl, linkUncounted: Boolean(link) && !site, plain, total, limit, over: total > limit };
}

// ─── What the database sends ───────────────────────────────────────────────────────────────────────

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
function fin(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export const POST_STATUSES = ["draft", "approved", "sending", "sent", "failed", "dead", "rejected", "expired"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];
export const POST_KINDS = ["news", "showcase", "price"] as const;
export type PostKind = (typeof POST_KINDS)[number];

/** The columns the page reads from marketing_posts (a platform admin may SELECT). Not `facts`: it is for the drafter. */
export const POST_COLUMNS =
  "id,kind,status,texts,media_path,link,source_ref,content_hash,created_at,updated_at,approved_at,expires_at,edited_at," +
  "rejected_at,reject_reason,claimed_at,sent_at,attempts,max_attempts,next_attempt_at,last_error_code,facts_as_of";

/** How many posts the page reads. A full read says so: the page does not pretend the list is complete. */
export const POST_LIMIT = 40;

export interface MarketingPost {
  id: string;
  kind: PostKind;
  status: PostStatus;
  texts: Texts;
  mediaPath: string | null;
  link: string | null;
  sourceRef: string;
  /** What the owner is looking at: approving sends this back, and the database refuses if the post is no longer this. */
  contentHash: string;
  createdAt: string | null;
  updatedAt: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  editedAt: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  claimedAt: string | null;
  sentAt: string | null;
  attempts: number | null;
  maxAttempts: number | null;
  nextAttemptAt: string | null;
  /** The closed code list of 0108, or any other string the database may add later (shown as such, never dropped). */
  lastErrorCode: string | null;
  factsAsOf: string | null;
}

/** One row of marketing_posts, or null when it is not one this page can show safely (the whole read is then "failed"). */
export function coercePost(data: unknown): MarketingPost | null {
  const d = rec(data);
  if (!d) return null;
  const id = text(d.id);
  const kind = POST_KINDS.find((k) => k === d.kind);
  const status = POST_STATUSES.find((s) => s === d.status);
  const t = rec(d.texts);
  const hash = text(d.content_hash);
  const sourceRef = text(d.source_ref);
  if (!id || !UUID.test(id) || !kind || !status || !t || !hash || !HASH.test(hash) || !sourceRef) return null;
  const texts: Partial<Texts> = {};
  for (const lang of LANGS) {
    const v = t[lang];
    if (typeof v !== "string" || v === "") return null;
    texts[lang] = v;
  }
  return {
    id,
    kind,
    status,
    texts: texts as Texts,
    mediaPath: text(d.media_path),
    link: text(d.link),
    sourceRef,
    contentHash: hash,
    createdAt: text(d.created_at),
    updatedAt: text(d.updated_at),
    approvedAt: text(d.approved_at),
    expiresAt: text(d.expires_at),
    editedAt: text(d.edited_at),
    rejectedAt: text(d.rejected_at),
    rejectReason: text(d.reject_reason),
    claimedAt: text(d.claimed_at),
    sentAt: text(d.sent_at),
    attempts: fin(d.attempts),
    maxAttempts: fin(d.max_attempts),
    nextAttemptAt: text(d.next_attempt_at),
    lastErrorCode: text(d.last_error_code),
    factsAsOf: text(d.facts_as_of),
  };
}

/** All rows, or null if ANY row is unreadable: a list that silently drops a post would read as "nothing to approve". */
export function coercePosts(data: unknown): MarketingPost[] | null {
  if (!Array.isArray(data)) return null;
  const out: MarketingPost[] = [];
  for (const row of data) {
    const p = coercePost(row);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

export interface MarketingSettings {
  /** The database kill switch: false = the poster is off and nothing can be approved or claimed. */
  enabled: boolean;
  /** Posts allowed in any rolling 7 days (2). Null = the database did not say. */
  maxPer7d: number | null;
  /** Posts that took a slot in the last 7 days. Null = unknown, which is NOT 0. */
  used7d: number | null;
  approvedWaiting: number | null;
  approvalTtlHours: number | null;
}

/** The document owner_marketing_get() returns, or null when it is not one (the page then says it could not read it). */
export function coerceSettings(data: unknown): MarketingSettings | null {
  const d = rec(data);
  if (!d || d.ok !== true || typeof d.enabled !== "boolean") return null;
  return {
    enabled: d.enabled,
    maxPer7d: fin(d.max_per_7d),
    used7d: fin(d.used_7d),
    approvedWaiting: fin(d.approved_waiting),
    approvalTtlHours: fin(d.approval_ttl_hours),
  };
}

// ─── Derived ───────────────────────────────────────────────────────────────────────────────────────

/** Drafts and approvals first (they wait for the owner or the worker), then the rest, each newest first. */
export function sortPosts(posts: readonly MarketingPost[]): MarketingPost[] {
  const open = (p: MarketingPost) => (p.status === "draft" || p.status === "approved" || p.status === "sending" ? 0 : 1);
  const at = (p: MarketingPost) => Date.parse(p.createdAt ?? "") || 0;
  return [...posts].sort((a, b) => open(a) - open(b) || at(b) - at(a) || (a.id < b.id ? -1 : 1));
}

/** The post that settled most recently (sent, failed or dead): "the last send". Null when none has. */
export function lastSettled(posts: readonly MarketingPost[]): MarketingPost | null {
  const settled = posts.filter((p) => p.status === "sent" || p.status === "failed" || p.status === "dead");
  const at = (p: MarketingPost) => Date.parse(p.sentAt ?? p.updatedAt ?? "") || 0;
  return settled.reduce<MarketingPost | null>((best, p) => (best === null || at(p) > at(best) ? p : best), null);
}

/** Does this send need the owner to look at the channel, not to resend? A dead post may be on the channel. */
export function mayBeOnChannel(p: Pick<MarketingPost, "status">): boolean {
  return p.status === "dead";
}

/** What kind of file the sender would attach, from its extension (mirrors channel_post.media_kind). */
export function mediaKind(path: string | null): "photo" | "video" | "other" | null {
  if (!path) return null;
  const low = path.toLowerCase();
  if (/\.(jpg|jpeg|png)$/.test(low)) return "photo";
  if (low.endsWith(".mp4")) return "video";
  return "other";
}

/** A Telegram channel handle as the deploy accepts it (`@name`); anything else is unknown to the page, not guessed. */
export function channelHandle(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim();
  return /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(v) ? v : null;
}
