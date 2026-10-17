/**
 * Which alert rows are the owner's alerts, and how many distinct ones there are.
 *
 * The operator bot keeps its own memory in `alert_events` rows of kind `operator.alert|mute|unmute|digest|language`
 * (they carry the real severity of what they remember), and `provider.balance_low` is inserted again on every
 * six-hourly check while a balance stays low. Counting those made "Alerts (24h): 7" out of 1 real alert. The owner's
 * view leaves the bot's bookkeeping out and counts one low-balance alert per provider per owner day.
 */
import { ownerDayNumber } from "@/lib/owner-time";

/** PostgREST filter value: every kind that is the bot's bookkeeping. */
export const BOT_KIND_PATTERN = "operator.%";

export interface AlertKey {
  kind: string;
  title?: string | null;
  at: string;
}

/** Is this the operator bot's bookkeeping rather than an alert for the owner? */
export const isBotBookkeeping = (kind: string): boolean => kind.startsWith("operator.");

function atMs(at: string): number {
  const t = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(at) ? at : `${at}Z`);
  return Number.isFinite(t) ? t : NaN;
}

/** The owner's alerts: bot bookkeeping out, repeated low-balance rows for the same provider and day collapsed to one. */
export function ownerAlerts<T extends AlertKey>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (isBotBookkeeping(r.kind)) continue;
    if (r.kind === "provider.balance_low") {
      const ms = atMs(r.at);
      const key = `${r.kind}|${r.title ?? ""}|${Number.isNaN(ms) ? r.at : ownerDayNumber(ms)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}
