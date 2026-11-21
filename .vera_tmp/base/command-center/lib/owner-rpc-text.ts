import { fmt } from "@/lib/i18n";
import type { Dictionary } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { isOwnerRefusal, ratioText } from "@/lib/owner-rpc";
import type { OperatorResult } from "@/lib/operator-post";
import { operatorFailureText } from "@/lib/setup-errors";

type FailedResult = Extract<OperatorResult, { ok: false }>;

/**
 * The owner functions' refusals in the person's own language.
 *
 * The database answers a refusal with a code (owner_err) and the figures that explain it; the English sentence it
 * also carries is never shown. A figure the database did not send is written "unknown" rather than left as a gap or
 * a 0 (a refusal for a cap that names no cap would read as a bug, and "0 credits" would be a lie).
 */
type Text = Pick<Dictionary, "providers" | "mfa" | "ownerTruth" | "ownerRpc">;

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export function ownerRefusalText(t: Text, data: Record<string, unknown> | undefined, locale = "en"): string {
  const e = t.ownerRpc.err;
  const d = data ?? {};
  const code = typeof d.error === "string" ? d.error : "";
  const credits = (v: unknown) => {
    const n = num(v);
    return n === null ? e.figureUnknown : formatCredits(n, locale);
  };
  if (!isOwnerRefusal(code)) return fmt(e.unknown, { code: code || "?" });
  switch (code) {
    case "per_call_cap":
      return fmt(e.per_call_cap, { cap: credits(d.cap), requested: credits(d.requested) });
    case "daily_cap":
      return fmt(e.daily_cap, { granted: credits(d.granted_24h), cap: credits(d.cap), requested: credits(d.requested) });
    case "too_old": {
      const days = num(d.window_days);
      return fmt(e.too_old, { days: days === null ? e.figureUnknown : String(days) });
    }
    case "confirm_required": {
      const max = num(d.max_ratio);
      return fmt(e.confirm_required, {
        rate: ratioText(num(d.rate_ratio)) ?? e.figureUnknown,
        charged: ratioText(num(d.charged_ratio)) ?? e.figureUnknown,
        max: max === null ? e.figureUnknown : String(max),
      });
    }
    default:
      return e[code];
  }
}

/**
 * Any failed call to an /api/owner route as one sentence. A refusal the database gave (its code is in the body)
 * is worded by ownerRefusalText; a signed-out session, the second step, a dropped connection and the rest keep the
 * wording every other owner button uses (operatorFailureText), so the owner hears the same advice everywhere.
 * `uncertain` adds "check the history first" for the cases where the answer never arrived.
 */
export function ownerFailureText(t: Text, failure: Pick<FailedResult, "kind" | "data" | "status">, locale = "en", uncertain = false): string {
  const code = typeof failure.data?.error === "string" ? failure.data.error : "";
  const own = isOwnerRefusal(code) && code !== "unauthorized" && code !== "forbidden";
  if (own || (failure.kind === "server" && code !== "" && !isOwnerRefusal(code) && failure.data?.ok === false)) {
    return ownerRefusalText(t, failure.data as Record<string, unknown>, locale);
  }
  return operatorFailureText(t, failure, `${t.ownerTruth.serverError}${uncertain ? ` ${t.ownerTruth.checkBeforeRetry}` : ""}`, uncertain);
}
