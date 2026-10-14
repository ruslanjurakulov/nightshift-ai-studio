/**
 * "Connect, then pick" — the pure half.
 *
 * Client-safe: shapes and the decisions worth unit-testing. Nothing here ever
 * sees a token. The flow is: one button per platform on the Add channel
 * screen → the platform's consent screen → a pick screen listing what the
 * authorisation can act for → one press that creates the Nightshift channel
 * (YouTube) or stores the account (Instagram, TikTok). The server half is
 * lib/server/connect-pending.ts, connect-youtube.ts and social-connect.ts.
 */

import { isValidChannelId } from "@/lib/channels";

export const CONNECT_PLATFORMS = ["youtube", "instagram", "tiktok"] as const;
export type ConnectPlatform = (typeof CONNECT_PLATFORMS)[number];

export function isConnectPlatform(v: unknown): v is ConnectPlatform {
  return v === "youtube" || v === "instagram" || v === "tiktok";
}

/** The query value that switches a start route into the pick flow. */
export const PICK_FLAG = "pick";

/** Where the pick / confirm screen lives (a fixed same-origin path). */
export const CONNECT_PICK_PATH = "/all-channels/channels/connect";
/** Where a connect that could not reach the pick screen is sent back to. */
export const CONNECT_BACK_PATH = "/all-channels/channels/new";

/** The words a connect may come back with. The page never echoes query text. */
export const CONNECT_WORDS = [
  "denied",
  "not_configured",
  "not_available",
  "token_store",
  "forbidden",
  "not_found",
  "bad_state",
  "missing_scopes",
  "no_refresh",
  "no_channel",
  "no_account",
  "not_business",
  "exchange_rejected",
  "unavailable",
  "expired",
  "failed",
] as const;
export type ConnectWord = (typeof CONNECT_WORDS)[number];

export function parseConnectWord(raw: string | null | undefined): ConnectWord | null {
  const v = (raw ?? "").trim();
  return (CONNECT_WORDS as readonly string[]).includes(v) ? (v as ConnectWord) : null;
}

/** The path a failed connect returns to: fixed, same-origin, one known word. */
export function connectBackPath(platform: ConnectPlatform, word: ConnectWord): string {
  const q = new URLSearchParams({ connect: word, platform });
  return `${CONNECT_BACK_PATH}?${q.toString()}`;
}

/** What a pick submit may answer. */
export const CONFIRM_RESULTS = [
  "connected",
  "created_not_connected",
  "already_connected",
  "not_in_list",
  "expired",
  "forbidden",
  "not_configured",
  "unavailable",
  "id_taken",
  "busy",
  "failed",
] as const;
export type ConfirmResult = (typeof CONFIRM_RESULTS)[number];

/** One channel the Google sign-in can act for, as channels.list returned it. */
export interface YoutubeCandidate {
  id: string;
  title: string;
  /** "@handle" when YouTube returned one. */
  handle: string | null;
  thumbnail: string | null;
  /** Null when YouTube hides the count: an unknown is never rendered as 0. */
  subscribers: string | null;
  videos: string | null;
}

/** A candidate plus what the server knows about it in this organization. */
export interface YoutubeCandidateView extends YoutubeCandidate {
  /** The Nightshift channel already linked to it, if any. */
  linkedTo: { channelId: string; name: string } | null;
}

/** An Instagram / TikTok account the authorisation acts for. */
export interface SocialCandidateView {
  externalId: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  /** Already connected in this organization (a confirm then reconnects it). */
  connected: boolean;
}

/** What the pick screen is handed. Never carries a token or the pending id. */
export type PickView =
  | { platform: "youtube"; candidates: YoutubeCandidateView[]; expiresAt: number }
  | { platform: "instagram" | "tiktok"; account: SocialCandidateView; expiresAt: number };

const YT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

/** Only an https picture is rendered; anything else is dropped. */
export function safeImageUrl(v: unknown): string | null {
  const s = str(v, 2048);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A count YouTube returned as a string of digits; anything else is unknown. */
function count(v: unknown): string | null {
  return typeof v === "string" && /^\d{1,15}$/.test(v) ? v : null;
}

/**
 * Validate a channels.list body. An item without a well-formed id is dropped;
 * a hidden subscriber count reads as unknown (CLAUDE.md #5); the list is
 * capped so a hostile or odd response cannot fill the server's memory.
 */
export function coerceYoutubeChannels(body: unknown, max = 50): YoutubeCandidate[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: YoutubeCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as {
      id?: unknown;
      snippet?: { title?: unknown; customUrl?: unknown; thumbnails?: Record<string, { url?: unknown } | undefined> };
      statistics?: { subscriberCount?: unknown; videoCount?: unknown; hiddenSubscriberCount?: unknown };
    };
    if (typeof r.id !== "string" || !YT_ID_RE.test(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    const thumbs = r.snippet?.thumbnails ?? {};
    out.push({
      id: r.id,
      title: str(r.snippet?.title, 200) ?? r.id,
      handle: str(r.snippet?.customUrl, 100),
      thumbnail: safeImageUrl(thumbs.medium?.url ?? thumbs.default?.url ?? thumbs.high?.url),
      subscribers: r.statistics?.hiddenSubscriberCount === true ? null : count(r.statistics?.subscriberCount),
      videos: count(r.statistics?.videoCount),
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The Nightshift channel id for a picked YouTube channel: its handle, else its
 * title, else its YouTube id; `attempt` > 1 adds a suffix for a taken id.
 * Always a value create_channel and the URL rules accept (isValidChannelId),
 * or null when no attempt could produce one.
 */
export function pickedChannelSlug(c: Pick<YoutubeCandidate, "id" | "title" | "handle">, attempt = 1): string | null {
  const ascii = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const fromId = `channel-${ascii(c.id).slice(0, 12)}`.replace(/-+$/, "");
  const base = ascii((c.handle ?? "").replace(/^@/, "")) || ascii(c.title) || fromId;
  const suffix = attempt > 1 ? `-${attempt}` : "";
  const slug = (base.slice(0, 39 - suffix.length).replace(/-+$/, "") || fromId) + suffix;
  return isValidChannelId(slug) ? slug : attempt > 1 ? null : pickedChannelSlug(c, 2);
}

/** "1 234" style count, or null for an unknown (the caller prints its own word). */
export function formatCount(v: string | null, locale: string): string | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(locale) : null;
}

/** What a candidate row may offer. Presentation only: the server re-checks. */
export function candidateAction(c: Pick<YoutubeCandidateView, "linkedTo">): "pick" | "connected" {
  return c.linkedTo ? "connected" : "pick";
}
