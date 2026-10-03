/**
 * Home ("Bosh sahifa") — the customer's first screen, the pure half.
 *
 * Home never starts, prices or spends anything. Its composer only builds a
 * link into the existing channel run entry (/create, CreateStudio), which
 * shows the price and asks for confirmation exactly as before; its tiles only
 * build links into the Studio panel (/create?tool=…), which fills a form.
 * Everything here is a shape check or a URL, and is unit-tested
 * (tests/home.test.tsx).
 */
import { STUDIO_CAPABILITIES, type StudioCapability, type StudioPrefill } from "@/lib/creative/studio";
import { isChannelVerified } from "@/lib/channels";
import type { Locale } from "@/lib/i18n";
import type { ChannelRow } from "@/lib/types";

// ── length ("format" chip) ──────────────────────────────────────────────────

/**
 * The lengths the composer offers, as the seconds the run route accepts
 * (/api/agent/run clamps 30…3600). A range chip asks for its upper end: those
 * are the lengths CreateStudio already lists (~5 / ~10 / ~20 min), so the
 * price shown after the hand-off is the price of what the chip said.
 */
export const HOME_LENGTHS = [
  { id: "short", seconds: 60 },
  { id: "m3_5", seconds: 300 },
  { id: "m5_10", seconds: 600 },
  { id: "m10_20", seconds: 1200 },
] as const;
export type HomeLengthId = (typeof HOME_LENGTHS)[number]["id"];

/** Every length CreateStudio's select can show, so a prefill always lands on an option. */
export const RUN_DURATIONS_S = [60, 180, 300, 600, 1200] as const;

export function lengthSeconds(id: HomeLengthId): number {
  return HOME_LENGTHS.find((l) => l.id === id)?.seconds ?? 600;
}

// ── language ────────────────────────────────────────────────────────────────

/**
 * The script language, as the pipeline reads it (the workflow's free-text
 * `language` input). The label is the language's own name, in every locale.
 */
export const HOME_LANGUAGES = [
  { id: "uz", value: "Uzbek", label: "O'zbek" },
  { id: "ru", value: "Russian", label: "Русский" },
  { id: "en", value: "English", label: "English" },
] as const;
export type HomeLanguage = (typeof HOME_LANGUAGES)[number]["value"];

export function isHomeLanguage(v: unknown): v is HomeLanguage {
  return typeof v === "string" && HOME_LANGUAGES.some((l) => l.value === v);
}

/** The composer starts in the viewer's own language. */
export function defaultLanguage(locale: Locale): HomeLanguage {
  return locale === "uz" ? "Uzbek" : locale === "ru" ? "Russian" : "English";
}

// ── formats ("What can you make") ───────────────────────────────────────────

export const HOME_FORMATS = [
  { id: "story", length: "m5_10" },
  { id: "kids", length: "m3_5" },
  { id: "explainer", length: "m5_10" },
  { id: "interview", length: "m10_20" },
  { id: "drama", length: "m3_5" },
  { id: "shorts", length: "short" },
] as const satisfies readonly { id: string; length: HomeLengthId }[];
export type HomeFormatId = (typeof HOME_FORMATS)[number]["id"];

// ── quick actions → the Studio panel ────────────────────────────────────────

export const QUICK_ACTIONS = [
  { id: "image", tool: "t2i" },
  { id: "video", tool: "t2v" },
  { id: "voice", tool: "tts" },
  { id: "edit", tool: "edit" },
  { id: "upscale", tool: "upscale" },
  { id: "cutout", tool: "remove_bg" },
] as const satisfies readonly { id: string; tool: StudioCapability }[];
export type QuickActionId = (typeof QUICK_ACTIONS)[number]["id"];

/** `/create?tool=t2i` — the Studio panel opens on that tool, empty. */
export function toolHref(tool: StudioCapability): string {
  return `/create?tool=${encodeURIComponent(tool)}`;
}

/**
 * `/create?tool=…` without a picture: the panel opens on that tool and waits.
 * (With a library picture, lib/creative/studio prefillFromQuery applies.)
 * Only fills the form; nothing is priced or spent until Generate is pressed.
 */
export function toolPrefill(tool: unknown): StudioPrefill | null {
  if (typeof tool !== "string" || !(STUDIO_CAPABILITIES as readonly string[]).includes(tool)) return null;
  return { capability: tool as StudioCapability, model: "", prompt: "", aspect: "16:9", duration: 5, sourceId: null, factor: 2 };
}

// ── the hand-off into the channel run (CreateStudio) ────────────────────────

export const TOPIC_MAX = 300;

export interface RunHandoff {
  topic: string;
  seconds: number;
  language: HomeLanguage;
}

/**
 * Where the composer's button goes: the chosen channel's /create, with the
 * topic, length and language in the query and the run form in view. That page
 * shows the price and asks again before anything is dispatched.
 */
export function runHandoffHref(slug: string, h: RunHandoff): string {
  const q = new URLSearchParams();
  const topic = h.topic.trim().slice(0, TOPIC_MAX);
  if (topic) q.set("topic", topic);
  q.set("length", String(h.seconds));
  q.set("lang", h.language);
  return `/${encodeURIComponent(slug)}/create?${q.toString()}#run`;
}

/** What CreateStudio starts with. Strings, because that is what its controls hold. */
export interface RunPrefill {
  brief: string;
  duration: string;
  language: string;
}

const first = (v: unknown): unknown => (Array.isArray(v) ? undefined : v);

/**
 * The /create query → CreateStudio's starting values, or null when the query
 * carries nothing usable. Shape only: an unknown length or language is
 * dropped (the channel's own setting applies), and the topic is trimmed and
 * capped the way the run route caps it. A repeated parameter is refused
 * rather than guessed between.
 */
export function runPrefillFromQuery(q: Record<string, string | string[] | undefined>): RunPrefill | null {
  const topicRaw = first(q.topic);
  const lengthRaw = first(q.length);
  const langRaw = first(q.lang);
  const brief = typeof topicRaw === "string" ? topicRaw.replace(/\s+/g, " ").trim().slice(0, TOPIC_MAX) : "";
  const n = typeof lengthRaw === "string" && /^\d{1,5}$/.test(lengthRaw) ? Number(lengthRaw) : NaN;
  const duration = (RUN_DURATIONS_S as readonly number[]).includes(n) ? String(n) : "";
  const language = isHomeLanguage(langRaw) ? langRaw : "";
  if (!brief && !duration && !language) return null;
  return { brief, duration, language };
}

// ── channels ────────────────────────────────────────────────────────────────

/**
 * A channel a run can be made for: one YouTube has answered for (rule 7 —
 * a typed name is a draft and never runs).
 */
export function runnableChannels(channels: ChannelRow[]): ChannelRow[] {
  return channels.filter((c) => isChannelVerified(c));
}

/** The scheduler's default hour when a channel has none stored (ScheduleEditor). */
export const DEFAULT_PUBLISH_HOUR_UTC = 15;

/**
 * When the scheduler will next pick this channel up, from its own settings:
 * a live (verified, ACTIVE) channel with autopilot on, at its publish hour
 * (UTC), today or tomorrow. Null when it will not run on its own. This is the
 * schedule as configured, not a promise that the run will succeed.
 */
export function nextScheduledRun(
  channel: Pick<ChannelRow, "channel_id" | "credential_ref" | "status" | "schedule_config">,
  now: Date = new Date(),
): Date | null {
  if (!isChannelVerified(channel) || channel.status !== "ACTIVE") return null;
  if (channel.schedule_config?.enabled === false) return null;
  const h = channel.schedule_config?.publish_hour_utc;
  const hour = typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_PUBLISH_HOUR_UTC;
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
  if (at.getTime() <= now.getTime()) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

export type ChannelStanding = "live" | "paused" | "draft";

export function channelStanding(channel: Pick<ChannelRow, "channel_id" | "credential_ref" | "status">): ChannelStanding {
  if (!isChannelVerified(channel)) return "draft";
  return channel.status === "ACTIVE" ? "live" : "paused";
}

/** One channel's card on Home. Counts are null when the read behind them failed. */
export interface HomeChannel {
  id: string;
  slug: string;
  name: string;
  /** The channel's YouTube avatar (public, read back when it was confirmed), https only. */
  avatar: string | null;
  /** Its script language as configured, or "" for the deployment's default. */
  language: string;
  standing: ChannelStanding;
  autoPublish: boolean;
  lastVideo: { title: string; at: string | null } | null;
  nextRun: string | null;
  /** Finished runs waiting for a decision (held, not uploaded); null = unknown. */
  waiting: number | null;
}

type VideoLite = { channel_id?: unknown; title?: unknown; topic?: unknown; published_at?: unknown };

/** Newest uploaded video per channel, from rows already ordered newest first. */
export function lastVideoByChannel(rows: unknown): Map<string, { title: string; at: string | null }> {
  const out = new Map<string, { title: string; at: string | null }>();
  if (!Array.isArray(rows)) return out;
  for (const r of rows as VideoLite[]) {
    if (!r || typeof r.channel_id !== "string" || out.has(r.channel_id)) continue;
    const title =
      typeof r.title === "string" && r.title.trim() ? r.title.trim() : typeof r.topic === "string" ? r.topic.trim() : "";
    out.set(r.channel_id, { title, at: typeof r.published_at === "string" ? r.published_at : null });
  }
  return out;
}

/** Held rows per channel. */
export function countByChannel(rows: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(rows)) return out;
  for (const r of rows as { channel_id?: unknown }[]) {
    if (!r || typeof r.channel_id !== "string") continue;
    out.set(r.channel_id, (out.get(r.channel_id) ?? 0) + 1);
  }
  return out;
}

/** One video on Home's "your videos" row. */
export interface HomeVideo {
  id: string;
  /** The channel's URL slug, for the link to the video. */
  slug: string;
  title: string;
  at: string | null;
  /** held = finished but not uploaded (waiting for the person); otherwise what YouTube was told. */
  state: "waiting" | "private" | "unlisted" | "public" | "uploaded";
}

/**
 * The newest videos across the open channels, from rows already read (held rows,
 * which have no publish time, come first: they are the ones waiting for a decision).
 * A privacy value this build does not know reads as plain "uploaded", never guessed.
 */
export function recentVideos(rows: unknown, slugOfChannel: (channelId: string) => string | null, limit = 6): HomeVideo[] {
  if (!Array.isArray(rows)) return [];
  const out: HomeVideo[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r.video_id !== "string" || typeof r.channel_id !== "string") continue;
    const slug = slugOfChannel(r.channel_id);
    if (!slug) continue;
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : typeof r.topic === "string" ? r.topic.trim() : "";
    const at = typeof r.published_at === "string" && r.published_at ? r.published_at : null;
    const privacy = typeof r.privacy === "string" ? r.privacy : "";
    const uploaded = at !== null || privacy !== "";
    const state: HomeVideo["state"] = !uploaded ? "waiting" : privacy === "private" || privacy === "unlisted" || privacy === "public" ? privacy : "uploaded";
    out.push({ id: r.video_id, slug, title, at, state });
  }
  // Waiting first, then newest first; the read's own order is not relied on.
  const rank = (v: HomeVideo) => (v.state === "waiting" ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || Date.parse(b.at ?? "") - Date.parse(a.at ?? "") || 0);
  return out.slice(0, limit);
}

const httpsUrl = (v: unknown): string | null =>
  typeof v === "string" && /^https:\/\/[^\s"'<>]+$/i.test(v) ? v : null;

/**
 * One card per channel, from reads the page already made. `waiting` is null
 * when the held-videos read failed — "couldn't read", never 0.
 */
export function buildHomeChannels(input: {
  channels: ChannelRow[];
  slugOf: (c: ChannelRow) => string;
  lastVideos: Map<string, { title: string; at: string | null }>;
  waiting: Map<string, number> | null;
  now?: Date;
}): HomeChannel[] {
  return input.channels.map((c) => {
    const next = nextScheduledRun(c, input.now);
    return {
      id: c.channel_id,
      slug: input.slugOf(c),
      name: c.name || c.channel_id,
      avatar: httpsUrl(c.credential_ref?.youtube_thumbnail),
      language: typeof c.agent_config?.language === "string" ? c.agent_config.language.trim() : "",
      standing: channelStanding(c),
      autoPublish: c.auto_publish === true,
      lastVideo: input.lastVideos.get(c.channel_id) ?? null,
      nextRun: next ? next.toISOString() : null,
      waiting: input.waiting ? input.waiting.get(c.channel_id) ?? 0 : null,
    };
  });
}
