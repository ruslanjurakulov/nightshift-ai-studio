/**
 * In-app notifications (migration 0064) — the pure, client-safe half.
 *
 * The database writes a row per person per event and stores only ids, a
 * capability word, a machine code and numbers. The words the person reads are
 * made here from kind + data and the dictionary, so a language switch re-words
 * old notifications too, and nothing a person typed ever travels through one.
 *
 * Two rules from CLAUDE.md shape this file: an unknown is never a number (a
 * missing amount is left out of the sentence, never shown as 0), and a row the
 * database sent that this build does not understand is skipped rather than
 * shown as a blank card.
 */

export const NOTIFICATION_KINDS = [
  "creative_job_completed",
  "creative_job_failed",
  "storyboard_ready",
  "editor_export_done",
  "credits_low",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** How many notifications the bell lists (the newest). The unread count is
 *  the database's own count, not the length of this list. */
export const INBOX_LIMIT = 30;

/** The count shown on the bell: "9+" past nine, nothing at zero. */
export function badgeText(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  return unread > 9 ? "9+" : String(Math.floor(unread));
}

export interface InboxRow {
  id: string;
  org_id: string;
  kind: NotificationKind;
  ref: string;
  data: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isKind(v: unknown): v is NotificationKind {
  return typeof v === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(v);
}

/** What the table returned, as rows this build can show. Anything malformed or
 *  of a kind it does not know is dropped. */
export function parseInbox(rows: unknown): InboxRow[] {
  if (!Array.isArray(rows)) return [];
  const out: InboxRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.org_id !== "string" || typeof o.created_at !== "string") continue;
    if (!isKind(o.kind)) continue;
    out.push({
      id: o.id,
      org_id: o.org_id,
      kind: o.kind,
      ref: typeof o.ref === "string" ? o.ref : "",
      data: o.data && typeof o.data === "object" && !Array.isArray(o.data) ? (o.data as Record<string, unknown>) : {},
      created_at: o.created_at,
      read_at: typeof o.read_at === "string" ? o.read_at : null,
    });
  }
  return out;
}

/** A numeric field of a notification, or null when absent or not a number. */
export function numberField(data: Record<string, unknown>, key: string): number | null {
  const v = data[key];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** An id field, only when it really is a uuid: it ends up in a link. */
function idField(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" && UUID.test(v) ? v : null;
}

export type NotificationCopy = "creativeDone" | "creativeFailed" | "storyboardReady" | "exportDone" | "creditsLow";

export interface NotificationView {
  id: string;
  copy: NotificationCopy;
  /** The amount line to add under the body, when the row carries the number. */
  amount: { key: "charged" | "returned" | "available"; n: number } | null;
  /** A section path ("/studio"), to be made channel-aware by the caller. */
  section: string;
  createdAt: string;
  unread: boolean;
}

/** What a row says and where it leads. Never invents a number. */
export function describeNotification(row: InboxRow): NotificationView {
  const base = { id: row.id, createdAt: row.created_at, unread: row.read_at === null };
  switch (row.kind) {
    case "creative_job_completed": {
      const n = numberField(row.data, "credits_charged");
      return { ...base, copy: "creativeDone", amount: n === null ? null : { key: "charged", n }, section: "/library" };
    }
    case "creative_job_failed": {
      const n = numberField(row.data, "credits_returned");
      return { ...base, copy: "creativeFailed", amount: n === null ? null : { key: "returned", n }, section: "/studio" };
    }
    case "storyboard_ready": {
      const id = idField(row.data, "storyboard_id");
      return { ...base, copy: "storyboardReady", amount: null, section: id ? `/videos/storyboard/${id}` : "/videos" };
    }
    case "editor_export_done": {
      const project = idField(row.data, "project_id");
      return { ...base, copy: "exportDone", amount: null, section: project ? `/editor/${project}` : "/library" };
    }
    case "credits_low": {
      const n = numberField(row.data, "available");
      return { ...base, copy: "creditsLow", amount: n === null ? null : { key: "available", n }, section: "/credits" };
    }
  }
}

/** "5m ago" without a language: the dictionary supplies the words. */
export function ageParts(iso: string, now: number = Date.now()): { unit: "now" | "m" | "h" | "d"; n: number } {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { unit: "now", n: 0 };
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return { unit: "now", n: 0 };
  const m = Math.round(s / 60);
  if (m < 60) return { unit: "m", n: m };
  const h = Math.round(m / 60);
  if (h < 24) return { unit: "h", n: h };
  return { unit: "d", n: Math.round(h / 24) };
}
