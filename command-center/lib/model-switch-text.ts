import { fmt } from "@/lib/i18n";
import type { Dictionary } from "@/lib/i18n";
import { SWITCH_NOTE_MAX, isSwitchRefusal, type SwitchProvider, type SwitchReason } from "@/lib/model-switch";
import type { OperatorResult } from "@/lib/operator-post";
import { operatorFailureText } from "@/lib/setup-errors";

type FailedResult = Extract<OperatorResult, { ok: false }>;
type Text = Pick<Dictionary, "providers" | "mfa" | "ownerTruth" | "modelSwitch">;

/** A code from the database or the route in the person's language. A code a newer database might send is shown as the closed code it is, never as free text. */
export function switchRefusalText(t: Text, data: Record<string, unknown> | undefined): string {
  const e = t.modelSwitch.err;
  const code = typeof data?.error === "string" ? data.error : "";
  if (!isSwitchRefusal(code)) return fmt(e.unknown, { code: /^[a-z0-9_]{1,40}$/.test(code) ? code : "?" });
  return fmt(e[code], { max: SWITCH_NOTE_MAX });
}

/**
 * Any failed call to /api/owner/model-switch as one sentence: a refusal the database or the route gave is worded by its code; a signed-out
 * session, the second step, a dropped connection and the rest keep the wording every other owner button uses (operatorFailureText).
 * `uncertain` adds "check first" for the cases where the answer never arrived and the switch may still have gone through.
 */
export function switchFailureText(t: Text, failure: Pick<FailedResult, "kind" | "data" | "status">, uncertain = false): string {
  const code = typeof failure.data?.error === "string" ? failure.data.error : "";
  const own = isSwitchRefusal(code) && code !== "unauthorized" && code !== "forbidden" && code !== "mfa_required" && code !== "rate_limited";
  if (own || (failure.kind === "server" && code !== "" && !isSwitchRefusal(code) && failure.data?.ok === false)) {
    return switchRefusalText(t, failure.data as Record<string, unknown>);
  }
  return operatorFailureText(t, failure, `${t.ownerTruth.serverError}${uncertain ? ` ${t.ownerTruth.checkBeforeRetry}` : ""}`, uncertain);
}

export function reasonText(t: Pick<Dictionary, "modelSwitch">, reason: SwitchReason | null): string {
  return reason ? t.modelSwitch.reasons[reason] : t.modelSwitch.reasonUnknown;
}

/** The provider as the owner reads it: its registry id, and the first models it makes, so "bytedance" is recognisably Seedance. */
export function providerLabel(p: Pick<SwitchProvider, "provider" | "models">): string {
  const names = p.models.slice(0, 2).map((m) => m.displayName);
  return names.length === 0 ? p.provider : `${p.provider} (${names.join(", ")}${p.models.length > 2 ? ", …" : ""})`;
}
