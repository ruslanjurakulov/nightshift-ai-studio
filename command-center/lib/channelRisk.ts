/**
 * Per-channel risk settings an EDITOR may write into `channels.agent_config` (not in channels_config_guard's list, so no
 * administrator lock): `spend_ceiling_usd`, `pinned_comment`, `watch_next`. The worker reads them in
 * modules/channels.py (AgentConfig.from_dict); both sides are held to command-center/tests/fixtures/channel-risk-cases.json
 * so a value this page saves is a value the worker honours. Client-safe and pure.
 *
 * The one that can hurt is the ceiling: the worker reads anything it cannot use as "no ceiling", the most expensive way to
 * be wrong. So the page stores only a plain amount above 0 and up to MAX_SPEND_CEILING_USD, with at most two decimals, and
 * says why when it refuses (0 is not "spend nothing" to the worker, it is "no limit").
 */

/** Same ceiling as the sentence on the page; the worker has none beyond "finite". */
export const MAX_SPEND_CEILING_USD = 1_000_000;

export type SpendCeilingParse =
  | { ok: true; value: number | null }
  | { ok: false; reason: "invalid" | "not_positive" | "too_large" };

/** What a person typed -> the number to store (null = no limit, remove the key), or why not. A comma is accepted as the decimal mark. */
export function parseSpendCeiling(input: string): SpendCeilingParse {
  const text = input.trim();
  if (text === "") return { ok: true, value: null };
  if (/^-\d+([.,]\d+)?$/.test(text)) return { ok: false, reason: "not_positive" };
  if (!/^\d+([.,]\d{1,2})?$/.test(text)) return { ok: false, reason: "invalid" };
  const value = Number(text.replace(",", "."));
  if (!Number.isFinite(value) || value > MAX_SPEND_CEILING_USD) return { ok: false, reason: "too_large" };
  if (!(value > 0)) return { ok: false, reason: "not_positive" };
  return { ok: true, value };
}

const NUMERIC_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * The ceiling the worker enforces for a stored value, or null for none (modules/channels._as_optional_float): only a finite
 * number above 0, or text that is one, counts. Anything else, a boolean or a list included, is no ceiling, and the page says so.
 */
export function effectiveSpendCeiling(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && NUMERIC_TEXT.test(raw.trim())) n = Number(raw.trim());
  else return null;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The live config with the ceiling set, or removed for null. Every other key is kept exactly as it was read. */
export function withSpendCeiling(live: Record<string, unknown> | null | undefined, value: number | null): Record<string, unknown> {
  const { spend_ceiling_usd: _old, ...rest } = live ?? {};
  void _old;
  return value === null ? rest : { ...rest, spend_ceiling_usd: value };
}

/** `pinned_comment` / `watch_next`: absent is ON, only a real false is off (modules/channels.py). */
export function flagIsOn(raw: unknown): boolean {
  return raw !== false;
}
