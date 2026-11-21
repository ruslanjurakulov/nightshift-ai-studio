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
 * Nothing in here sends, tests or publishes anything. The only things this page can ask the database for are the owner
 * functions (edit, approve, reject, kill and, since migration 0110, create: a DRAFT the owner typed); the post itself goes
 * out by the worker, after an approval, only while the poster is switched on.
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
  // owner_marketing_create (0110)
  "bad_link",
  "bad_request_id",
  "bad_kind",
  "key_reused",
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
/** The request id of a "New post" screen (owner_marketing_create): 16 to 64 letters, digits, - or _. */
const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** A link is a path on our own site (modules/marketing_content._LINK, the database's own check). */
const LINK = /^\/[a-z0-9][a-z0-9/_-]{0,78}$/;
export const linkOk = (link: string): boolean => LINK.test(link) && !link.includes("//") && !link.includes("..");
/**
 * What the database refuses inside a text (marketing_texts_ok, and Postgres itself for NUL): control characters (a new line is allowed), the C1 controls, soft
 * hyphen, zero-width and direction-changing characters, line and paragraph separators, the byte order mark.
 */
const BAD_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
/** Each language is at most this many characters (code points), as marketing_texts_ok demands. */
export const TEXT_MAX = 1000;
export const LANGS = ["uz", "ru", "en"] as const;
export type Lang = (typeof LANGS)[number];
export type Texts = Record<Lang, string>;

const bad = (error: MarketingRefusal): MarketingParse => ({ ok: false, error });
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * The one body the route accepts: `{action, ...}` with exactly five actions. There is deliberately no action that sends,
 * re-sends or tests a post: the only way a post reaches the channel is the worker, after an approval.
 *
 *   create  {requestId, texts:{uz,ru,en}, link|null}
 *                                      -> owner_marketing_create(p_request_id, p_texts, p_link, p_kind)   a DRAFT, kind custom
 *   edit    {id, texts:{uz,ru,en}}     -> owner_marketing_edit(p_id, p_texts)
 *   approve {id, contentHash}          -> owner_marketing_approve(p_id, p_content_hash)   the hash the owner SAW
 *   reject  {id, reason}               -> owner_marketing_reject(p_id, p_reason)
 *   kill    {kill, reason?}            -> owner_marketing_kill(p_kill, p_reason)          kill:false needs a reason
 *
 * `create` never approves: the owner approves on the card, as for every other kind. The page makes the requestId ONCE per
 * "New post" screen, so a double tap or a retry names the same post. `p_kind` is always `custom`: a person cannot make a
 * `promo` post (the database refuses any other kind).
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
  if (action === "create") {
    const requestId = str(b.requestId);
    if (!requestId || !REQUEST_ID.test(requestId)) return bad("bad_request_id");
    const texts = parseTexts(b.texts);
    if (!texts || textsProblem(texts) !== null) return bad("bad_texts");
    // Absent, null or empty is "no link"; anything else must be a path on our own site.
    const raw = b.link;
    if (raw !== undefined && raw !== null && typeof raw !== "string") return bad("bad_link");
    const link = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
    if (link !== null && !linkOk(link)) return bad("bad_link");
    return { ok: true, call: { fn: "owner_marketing_create", args: { p_request_id: requestId, p_texts: texts, p_link: link, p_kind: "custom" } } };
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
  const texts = parseTexts(b.texts);
  if (!texts) return bad("bad_texts");
  return { ok: true, call: { fn: "owner_marketing_edit", args: { p_id: id, p_texts: texts } } };
}

/** Exactly the keys uz, ru, en, each a string of 1 to 1000 characters (code points) once trimmed; the trimmed texts, or null. */
function parseTexts(v: unknown): Texts | null {
  const t = obj(v);
  if (!t || Object.keys(t).length !== 3) return null;
  const out: Partial<Texts> = {};
  for (const lang of LANGS) {
    const x = str(t[lang]);
    if (x === null) return null;
    const trimmed = x.trim();
    const n = charCount(trimmed);
    if (n < 1 || n > TEXT_MAX) return null;
    out[lang] = trimmed;
  }
  return { uz: out.uz!, ru: out.ru!, en: out.en! };
}

/**
 * Why the database would refuse these (already trimmed) texts as a new post, or null: an empty language, a character it never
 * allows, or a language over 1000 characters, counted in code points as the database counts. (marketing_texts_ok also caps the
 * three together at 4096 less 160, which three texts of 1000 can never reach; the message the SENDER builds is the tighter limit,
 * in UTF-16 units, and the form checks it with buildPreview.)
 */
export type TextsProblem = "empty" | "bad_chars" | "lang_too_long";
/** A lone surrogate half (a broken emoji): Postgres refuses it (22P05) as it refuses a NUL, so the page does before the call. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** The same check for one language's (already trimmed) text. */
export function textProblem(text: string): TextsProblem | null {
  if (text.trim() === "") return "empty";
  if (BAD_CHARS.test(text) || LONE_SURROGATE.test(text)) return "bad_chars";
  if (charCount(text) > TEXT_MAX) return "lang_too_long";
  return null;
}
export function textsProblem(texts: Texts): TextsProblem | null {
  const all = LANGS.map((l) => textProblem(texts[l]));
  return all.includes("empty") ? "empty" : all.includes("bad_chars") ? "bad_chars" : all.includes("lang_too_long") ? "lang_too_long" : null;
}

/**
 * A new id for one "New post" screen: 32 hex characters from the browser's random source (16 to 64 of [A-Za-z0-9_-] is what
 * the database accepts). The screen makes it ONCE and sends it with every attempt, so a double tap or a retry is one post.
 */
export function newRequestId(): string {
  const bytes = new Uint8Array(16);
  const c = typeof globalThis.crypto !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Own-site pages the New post form offers as a link (any other path of the same shape can be typed). All are public pages. */
export const LINK_CHOICES = ["/pricing", "/solutions", "/studio", "/mcp", "/docs/api", "/signup"] as const;

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
  /** The sender would refuse the words as unsafe (a key, a token or an e-mail address in them). */
  unsafe: boolean;
}

/**
 * An origin the way the sender accepts it (modules/notify_telegram.valid_app_origin): https, or http for localhost; no
 * credentials, path, query or fragment. The result keeps the host exactly as typed, port included (`https://a.example:443`
 * stays `:443`, as Python's urlsplit netloc does; `new URL().host` would drop it and the count would be 4 units short).
 */
export function validOrigin(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const typed = raw.trim();
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(typed);
  if (!m) return null;
  try {
    const u = new URL(typed);
    if (u.username || u.password || (u.pathname !== "" && u.pathname !== "/") || u.search || u.hash || !u.hostname) return null;
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    return `${m[1].toLowerCase()}://${m[2]}`;
  } catch {
    return null;
  }
}

// ─── Text the sender refuses as unsafe (a mirror of modules/tg_text.sanitize_outgoing + modules/log_redaction) ───

// Python's \b is Unicode-aware (a Cyrillic letter is a word character), JavaScript's is ASCII-only: build the same boundary.
const W = "[\\p{L}\\p{N}_]";
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const UNSAFE: RegExp[] = [
  /bot\d+:[A-Za-z0-9_-]+/u,
  /hooks\.slack(?:-gov)?\.com\/(?:services|workflows|triggers)\/[^\s'"<>)]+/u,
  /[?&](?:key|api_key|apikey|access_token|token)=[^&\s'"<>)]+/iu,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/u,
  new RegExp(`${B}(?:bearer|basic)\\s+[A-Za-z0-9._~+/=-]{12,}`, "iu"),
  new RegExp(`${B}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`, "u"),
  new RegExp(`${B}(?:sk|pk|rk|xox[abprs]|gh[pousr]|AIza)[-_A-Za-z0-9]{16,}`, "u"),
];
const LONG_TOKEN = new RegExp(`${B}[A-Za-z0-9_-]{48,}${B}`, "gu");

/**
 * Would the sender replace something in this text with a placeholder (so it REFUSES the post, never altering the words)?
 * The same rules as tg_text.sanitize_outgoing: a URL-borne credential, an e-mail address, a bearer/basic header, a JWT, a
 * key with a well-known prefix, or an unbroken run of 48+ key characters that mixes upper case, lower case and digits.
 * Pinned against the real sanitizer by tests/fixtures/marketing_message_cases.json.
 */
export function looksUnsafe(plain: string): boolean {
  if (UNSAFE.some((re) => re.test(plain))) return true;
  for (const m of plain.matchAll(LONG_TOKEN)) {
    if (/[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) && /[0-9]/.test(m[0])) return true;
  }
  return false;
}

/**
 * The code the sender would refuse this post with (modules/channel_post.render), or null if it would send it:
 * bad_texts, bad_link, no_origin, unsafe_text, too_long, in that order. `originUnknownOk` is for the page, which may not
 * know the site's address although the worker does: it then skips no_origin and checks the rest on the message without the
 * link, which can only under-count (a post it calls too long is too long).
 */
export function senderRefusal(
  texts: Partial<Record<Lang, unknown>>,
  link: string | null,
  origin: string | null,
  hasMedia: boolean,
  originUnknownOk = false,
): string | null {
  for (const lang of LANGS) {
    const v = texts[lang];
    if (typeof v !== "string" || v.trim() === "") return "bad_texts";
  }
  if (link && !linkOk(link)) return "bad_link";
  if (link && !validOrigin(origin) && !originUnknownOk) return "no_origin";
  const pv = buildPreview(texts as Texts, link, origin, hasMedia);
  if (looksUnsafe(pv.plain)) return "unsafe_text";
  if (pv.over) return "too_long";
  return null;
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
  return { blocks, linkUrl, linkUncounted: Boolean(link) && !site, plain, total, limit, over: total > limit, unsafe: looksUnsafe(plain) };
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
/**
 * The kinds this page can show, edit, reject and approve as a Telegram post. `promo` (drafted by the worker from a reviewed
 * file) and `custom` (typed by the owner on this page) came with migration 0110. A kind not in this list is an OtherPost.
 */
export const POST_KINDS = ["news", "showcase", "price", "promo", "custom"] as const;
export type PostKind = (typeof POST_KINDS)[number];
/** The one target and delivery this page version can approve (the worker's Telegram path). Anything else is shown, never approved. */
export const KNOWN_TARGET = "telegram";
export const KNOWN_DELIVERY = "auto";

/**
 * A closed code (a kind, a target, a delivery, an error code) made safe to print: lower-case letters and underscores
 * (digits too when `digits`), 1 to `max` characters, else "unknown". The database's vocabularies are closed, but this page is
 * deployed BEFORE the database learns a new word, so what it prints must never be free text, markup or a secret by accident.
 */
export function safeCode(v: unknown, max = 24, digits = false): string {
  if (typeof v !== "string") return "unknown";
  const ok = digits ? /^[a-z0-9_]+$/.test(v) : /^[a-z_]+$/.test(v);
  return ok && v.length >= 1 && v.length <= max ? v : "unknown";
}

/** The columns the page reads from marketing_posts (a platform admin may SELECT). Not `facts`: it is for the drafter. */
export const POST_COLUMNS =
  "id,kind,target,status,texts,media_path,link,source_ref,content_hash,created_at,updated_at,approved_at,expires_at,edited_at," +
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

/**
 * Is this row one the Telegram path of this page version understands: a kind it knows, the Telegram target and automatic
 * delivery? `target` and `delivery` are optional (0108 has no `delivery`; a row without them is the Telegram path of today).
 * Anything else is an OtherPost: listed, labelled, never approved.
 */
function supportedRow(d: Record<string, unknown>): boolean {
  const target = d.target === undefined || d.target === null ? KNOWN_TARGET : d.target;
  const delivery = d.delivery === undefined || d.delivery === null ? KNOWN_DELIVERY : d.delivery;
  return POST_KINDS.some((k) => k === d.kind) && target === KNOWN_TARGET && delivery === KNOWN_DELIVERY;
}

/**
 * One row of marketing_posts the Telegram path knows, or null when it is not one this page can show safely. Extra fields are
 * ignored. A row of a kind, target or delivery this page version does not know is ALSO null here: it is read by
 * coerceListedPost as an OtherPost, so it is never mistaken for a post this page can approve.
 */
export function coercePost(data: unknown): MarketingPost | null {
  const d = rec(data);
  if (!d) return null;
  if (!supportedRow(d)) return null;
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

/**
 * A row this page version does not know how to act on: a kind, target or delivery from a newer version of the app (a later
 * migration adds some). It is LISTED, with its status and age, so it is never dropped and never counted as 0, but it
 * carries no hash to approve, and its words appear only if they have the known three-language shape.
 */
export interface OtherPost {
  other: true;
  id: string;
  status: PostStatus;
  /** Which part was not known: the title says "Other kind", "Other target" or "Other delivery". */
  reason: "kind" | "target" | "delivery";
  /** The kind as a closed code ([a-z_]{1,24}), or "unknown". */
  kindCode: string;
  targetCode: string;
  /** Null when the row carries no delivery column (today's database). */
  deliveryCode: string | null;
  /** The three languages, only if they have the known shape; otherwise null and the page says "preview unavailable". */
  texts: Texts | null;
  sourceRef: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  sentAt: string | null;
  /** A closed code, or "unknown". */
  lastErrorCode: string | null;
}
export type ListedPost = MarketingPost | OtherPost;
export const isOtherPost = (p: ListedPost): p is OtherPost => "other" in p;

function otherTexts(v: unknown): Texts | null {
  const t = rec(v);
  if (!t) return null;
  const out: Partial<Texts> = {};
  for (const lang of LANGS) {
    const x = t[lang];
    if (typeof x !== "string" || x.trim() === "" || charCount(x) > TEXT_MAX) return null;
    out[lang] = x;
  }
  return out as Texts;
}

/**
 * A row of any kind: a post this page knows (read exactly as coercePost reads it, null if unreadable), or an OtherPost. Only the
 * columns every row has since 0108 are required of an OtherPost: a uuid and a status this page knows. Everything else is
 * optional, so one row from the future cannot turn the whole page into "could not read".
 */
export function coerceListedPost(data: unknown): ListedPost | null {
  const d = rec(data);
  if (!d) return null;
  if (supportedRow(d)) return coercePost(d);
  const id = text(d.id);
  const status = POST_STATUSES.find((s) => s === d.status);
  if (!id || !UUID.test(id) || !status) return null;
  const kindKnown = POST_KINDS.some((k) => k === d.kind);
  const targetKnown = d.target === undefined || d.target === null || d.target === KNOWN_TARGET;
  const code = text(d.last_error_code);
  return {
    other: true,
    id,
    status,
    reason: !kindKnown ? "kind" : !targetKnown ? "target" : "delivery",
    kindCode: safeCode(d.kind),
    targetCode: d.target === undefined || d.target === null ? KNOWN_TARGET : safeCode(d.target),
    deliveryCode: d.delivery === undefined || d.delivery === null ? null : safeCode(d.delivery),
    texts: otherTexts(d.texts),
    sourceRef: text(d.source_ref),
    createdAt: text(d.created_at),
    updatedAt: text(d.updated_at),
    approvedAt: text(d.approved_at),
    expiresAt: text(d.expires_at),
    sentAt: text(d.sent_at),
    lastErrorCode: code === null ? null : safeCode(code, 40, true),
  };
}

/**
 * All rows, or null if ANY row is unreadable: a list that silently drops a post would read as "nothing to approve". A row of a
 * kind, target or delivery this page version does not know is readable (an OtherPost), so it is listed, never dropped.
 */
export function coercePosts(data: unknown): ListedPost[] | null {
  if (!Array.isArray(data)) return null;
  const out: ListedPost[] = [];
  for (const row of data) {
    const p = coerceListedPost(row);
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
export function sortPosts<T extends Pick<MarketingPost, "id" | "status" | "createdAt">>(posts: readonly T[]): T[] {
  const open = (p: T) => (p.status === "draft" || p.status === "approved" || p.status === "sending" ? 0 : 1);
  const at = (p: T) => Date.parse(p.createdAt ?? "") || 0;
  return [...posts].sort((a, b) => open(a) - open(b) || at(b) - at(a) || (a.id < b.id ? -1 : 1));
}

/** The post that settled most recently (sent, failed or dead): "the last send". Null when none has. */
export function lastSettled<T extends Pick<MarketingPost, "status" | "sentAt" | "updatedAt">>(posts: readonly T[]): T | null {
  const settled = posts.filter((p) => p.status === "sent" || p.status === "failed" || p.status === "dead");
  const at = (p: T) => Date.parse(p.sentAt ?? p.updatedAt ?? "") || 0;
  return settled.reduce<T | null>((best, p) => (best === null || at(p) > at(best) ? p : best), null);
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

/**
 * The channel the worker posts to, as the deploy accepts it (deploy/build-service-env.py CHAT): `@name` (5 to 32 characters
 * after the @) or a numeric chat id. Anything else is unknown to the page, not guessed.
 */
export function channelHandle(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim();
  return /^(@[A-Za-z][A-Za-z0-9_]{4,31}|-?[0-9]{5,20})$/.test(v) ? v : null;
}
