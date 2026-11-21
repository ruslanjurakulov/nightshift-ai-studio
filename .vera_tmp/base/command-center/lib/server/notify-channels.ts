import "server-only";
import { createClient } from "@/lib/supabase/server";
import { parseBotUsername, parseChannels, parsePreferences, type ChannelRow, type PreferenceRow } from "@/lib/notify-channels";

/**
 * Telegram notification channels (migration 0102), server side.
 *
 * The feature is OFF until the owner has created the CUSTOMER bot and set
 * TELEGRAM_CUSTOMER_BOT_USERNAME: with it unset or malformed nothing is shown
 * and the routes answer "not_configured". It is a public name, not a secret.
 * It is never the operator bot (TELEGRAM_BOT_TOKEN, the pending-approvals
 * alerts): that one is not read anywhere here.
 */
export function customerBotUsername(): string | null {
  return parseBotUsername(process.env.TELEGRAM_CUSTOMER_BOT_USERNAME);
}

const COLUMNS = "id, kind, label, locale, status, verified_at, last_ok_at, last_error_code";

function isMissing(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST202" || error.code === "42883" ||
    /could not find the (table|function)|does not exist/i.test(error.message ?? "")
  );
}

export interface ChannelsView {
  /** False before migration 0102 is applied: the panel is simply not shown. */
  supported: boolean;
  channels: ChannelRow[];
  preferences: PreferenceRow[];
}

/** The signed-in person's own channels and preference grid (RLS + definer functions). */
export async function readChannels(): Promise<ChannelsView> {
  const none: ChannelsView = { supported: false, channels: [], preferences: parsePreferences([]) };
  const supabase = await createClient();
  if (!supabase) return none;
  try {
    const { data, error } = await supabase.from("notification_channels").select(COLUMNS).order("created_at", { ascending: true });
    if (error) return isMissing(error) ? none : { supported: true, channels: [], preferences: parsePreferences([]) };
    const prefs = await supabase.rpc("notification_pref_effective");
    return { supported: true, channels: parseChannels(data), preferences: parsePreferences(prefs.error ? [] : prefs.data) };
  } catch {
    return none;
  }
}
