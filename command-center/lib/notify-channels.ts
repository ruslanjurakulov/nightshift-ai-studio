/**
 * Notification channels (migration 0102) — the pure, client-safe half.
 *
 * What the Settings panel knows about a person's linked Telegram chats and which
 * of the five notification events go there. The chat id never reaches the
 * browser (the column is not readable through the API). A message language is one
 * of the languages the app and the notification registry share
 * (supabase/functions/_shared/notify-i18n/registry.json; tests/notify-i18n.test.ts
 * keeps the two lists the same), never any other code.
 *
 * Two rules from CLAUDE.md apply: an unknown is never a number (a delivery that
 * was never recorded reads "unknown", not "now"), and a row this build does not
 * understand is skipped, not shown as a blank card.
 */

import { NOTIFICATION_KINDS, type NotificationKind } from "@/lib/notifications";
import { isLocale } from "@/lib/i18n/core";

export const CHANNEL_STATUSES = ["active", "paused", "blocked"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/** The events a person can switch per channel: the five of migration 0064. */
export const CHANNEL_EVENTS = NOTIFICATION_KINDS;
export type ChannelEvent = NotificationKind;

export interface ChannelRow {
  id: string;
  kind: "telegram";
  label: string | null;
  /** One of the registered languages: the language its messages are in. */
  locale: string;
  status: ChannelStatus;
  verified_at: string | null;
  last_ok_at: string | null;
  /** A machine code ("blocked", "http_5xx", …), never provider text. */
  last_error_code: string | null;
}

export interface PreferenceRow {
  event: ChannelEvent;
  enabled: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A language the notifications can be sent in: on the allow-list, exactly as written. */
export function isLanguageCode(v: unknown): v is string {
  return typeof v === "string" && isLocale(v);
}

export function isChannelEvent(v: unknown): v is ChannelEvent {
  return typeof v === "string" && (CHANNEL_EVENTS as readonly string[]).includes(v);
}

/** The table's rows as channels this build can show; malformed ones are dropped. */
export function parseChannels(rows: unknown): ChannelRow[] {
  if (!Array.isArray(rows)) return [];
  const out: ChannelRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || !UUID.test(o.id) || o.kind !== "telegram") continue;
    if (!(CHANNEL_STATUSES as readonly unknown[]).includes(o.status)) continue;
    out.push({
      id: o.id,
      kind: "telegram",
      label: typeof o.label === "string" && o.label.trim() !== "" ? o.label.slice(0, 40) : null,
      locale: isLanguageCode(o.locale) ? o.locale : "en",
      status: o.status as ChannelStatus,
      verified_at: typeof o.verified_at === "string" ? o.verified_at : null,
      last_ok_at: typeof o.last_ok_at === "string" ? o.last_ok_at : null,
      last_error_code: typeof o.last_error_code === "string" && /^[a-z0-9_]{1,32}$/.test(o.last_error_code) ? o.last_error_code : null,
    });
  }
  return out;
}

/** The effective grid from notification_pref_effective(): one row per event, in
 *  order, and an event the database did not report is switched OFF here (an
 *  unknown is not "on"). */
export function parsePreferences(rows: unknown): PreferenceRow[] {
  const byEvent = new Map<string, boolean>();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      if (o.channel === "telegram" && isChannelEvent(o.event) && typeof o.enabled === "boolean") byEvent.set(o.event, o.enabled);
    }
  }
  return CHANNEL_EVENTS.map((event) => ({ event, enabled: byEvent.get(event) ?? false }));
}

/** A bot username as Telegram allows it: 5-32 characters, ends in "bot". */
export function parseBotUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/^@/, "");
  return /^[A-Za-z][A-Za-z0-9_]{3,28}[Bb][Oo][Tt]$/.test(v) ? v : null;
}

/** The one-time token as the database makes it: 56 lower-case hex characters. */
export function isLinkToken(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{56}$/.test(v);
}

/** t.me/<bot>?start=<token>. Both parts are checked: a bad one gives null, never a half link. */
export function telegramLinkUrl(username: unknown, token: unknown): string | null {
  const bot = parseBotUsername(username);
  if (!bot || !isLinkToken(token)) return null;
  return `https://t.me/${bot}?start=${token}`;
}

/** Fixed error codes the routes return; the page maps each to a sentence. */
export const CHANNEL_ERRORS = [
  "unauthorized", "forbidden", "bad_request", "not_configured", "rate_limited", "limit", "not_found", "not_active", "failed",
] as const;
export type ChannelError = (typeof CHANNEL_ERRORS)[number];

export function isChannelError(v: unknown): v is ChannelError {
  return typeof v === "string" && (CHANNEL_ERRORS as readonly string[]).includes(v);
}

export type ChannelAction = "disconnect" | "pause" | "resume" | "test" | "locale";
export const CHANNEL_ACTIONS: readonly ChannelAction[] = ["disconnect", "pause", "resume", "test", "locale"];

/** The word for "last message delivered": null (unknown) when never recorded. */
export function lastDelivery(row: ChannelRow): string | null {
  return row.last_ok_at;
}
