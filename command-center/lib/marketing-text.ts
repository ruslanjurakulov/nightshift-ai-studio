import { fmt } from "@/lib/i18n";
import type { Dictionary } from "@/lib/i18n";
import { isMarketingRefusal, safeCode, type MarketingPost } from "@/lib/marketing-posts";
import type { OperatorResult } from "@/lib/operator-post";
import { operatorFailureText } from "@/lib/setup-errors";

type FailedResult = Extract<OperatorResult, { ok: false }>;
type Text = Pick<Dictionary, "providers" | "mfa" | "ownerTruth" | "marketing">;

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/**
 * A refusal of the marketing functions in the person's own language. The database answers with a code and the figures
 * that explain it; the English sentence it also carries is never shown. A figure it did not send reads "unknown", never
 * 0 and never a gap (a full week that names no figures would read as a bug, and "0 used" would be a lie).
 */
export function marketingRefusalText(t: Text, data: Record<string, unknown> | undefined): string {
  const e = t.marketing.err;
  const d = data ?? {};
  const code = typeof d.error === "string" ? d.error : "";
  // A code from a newer database is shown as the closed code it is, or "unknown": never free text from the server.
  if (!isMarketingRefusal(code)) return fmt(e.unknown, { code: code === "" ? "?" : safeCode(code, 40, true) });
  if (code === "cap_full") {
    const f = (v: unknown) => {
      const n = num(v);
      return n === null ? e.figureUnknown : String(n);
    };
    return fmt(e.cap_full, { used: f(d.used_7d), waiting: f(d.approved_waiting), max: f(d.max_per_7d) });
  }
  return e[code];
}

/**
 * Any failed call to /api/marketing as one sentence: a refusal the database or the route gave is worded by its code; a
 * signed-out session, the second step, a dropped connection and the rest keep the wording every other owner button uses
 * (operatorFailureText). `uncertain` adds "check first" for the cases where the answer never arrived and the action may
 * still have gone through.
 */
export function marketingFailureText(t: Text, failure: Pick<FailedResult, "kind" | "data" | "status">, uncertain = false): string {
  const code = typeof failure.data?.error === "string" ? failure.data.error : "";
  const own = isMarketingRefusal(code) && code !== "unauthorized" && code !== "forbidden";
  if (own || (failure.kind === "server" && code !== "" && !isMarketingRefusal(code) && failure.data?.ok === false)) {
    return marketingRefusalText(t, failure.data as Record<string, unknown>);
  }
  return operatorFailureText(t, failure, `${t.ownerTruth.serverError}${uncertain ? ` ${t.ownerTruth.checkBeforeRetry}` : ""}`, uncertain);
}

/** The refusals after which the page the owner is looking at is stale: it reloads so the next look is the truth. */
export function refusalMeansStale(code: unknown): boolean {
  return ["content_changed", "not_draft", "not_editable", "not_rejectable", "no_such_post", "expired", "poster_off", "cap_full", "facts_stale"].includes(
    typeof code === "string" ? code : "",
  );
}

/** The named fix for the code a failed or lost send left on a post (the closed list of 0108). */
export function fixText(t: Pick<Dictionary, "marketing">, code: string): string {
  const fix = t.marketing.fix as Record<string, string>;
  return Object.prototype.hasOwnProperty.call(fix, code) && code !== "unknown" ? fix[code] : fmt(fix.unknown, { code: code === "?" ? code : safeCode(code, 40, true) });
}

/** What the page says about how a post went (or is going) out. Null when there is nothing to say yet. */
export type SendNote = { tone: "ok" | "warn" | "fail" | "info"; lines: string[] };
export function sendNote(
  t: Pick<Dictionary, "marketing">,
  p: Pick<MarketingPost, "status" | "lastErrorCode">,
  when: { sent: string; next: string | null },
  posterOn: boolean,
  expires: string,
): SendNote | null {
  const m = t.marketing;
  switch (p.status) {
    case "sent":
      return { tone: "ok", lines: [fmt(m.send.sentOk, { when: when.sent })] };
    case "dead":
      // The post may be on the channel: never "resend", always "look".
      return { tone: "fail", lines: [m.send.unconfirmed, ...(p.lastErrorCode ? [fixText(t, p.lastErrorCode)] : [])] };
    case "failed":
      return { tone: "fail", lines: [m.send.failedLead, p.lastErrorCode ? fixText(t, p.lastErrorCode) : fixText(t, "?")] };
    case "expired":
      return p.lastErrorCode === "expired" ? { tone: "warn", lines: [m.send.approvalLapsed] } : null;
    case "approved": {
      const lines = [fmt(posterOn ? m.post.waitingWorker : m.post.waitingOff, { when: expires })];
      if (p.lastErrorCode) lines.push(fixText(t, p.lastErrorCode));
      if (p.lastErrorCode && when.next) lines.push(fmt(m.post.nextTry, { when: when.next }));
      return { tone: p.lastErrorCode ? "warn" : "info", lines };
    }
    default:
      return null;
  }
}

/** Which plural form a count takes: Russian has three (1 / 2-4 / 5+, with 11-14 as 5+), English two, Uzbek counts do not change the noun. */
export function pluralForm(n: number, locale: string): "one" | "few" | "many" {
  const base = (locale ?? "en").toLowerCase().split(/[-_]/)[0];
  const i = Math.abs(Math.trunc(n));
  if (base === "ru") {
    if (i % 10 === 1 && i % 100 !== 11) return "one";
    if (i % 10 >= 2 && i % 10 <= 4 && (i % 100 < 12 || i % 100 > 14)) return "few";
    return "many";
  }
  if (base === "uz") return "one";
  return i === 1 ? "one" : "few";
}

/** "142 units", "1 единица", "3 единицы", "11 единиц": a count of the unit the limits are counted in (UTF-16 units). */
export function unitCount(t: Pick<Dictionary, "marketing">, locale: string, n: number): string {
  return `${n} ${t.marketing.units[pluralForm(n, locale)]}`;
}
