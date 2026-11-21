/**
 * Per-channel risk settings an EDITOR may write into `channels.agent_config`: `spend_ceiling_usd`, `pinned_comment`, `watch_next`.
 * Two are plain editor switches; the limit is editor-level in one direction only: since migration 0119 the database refuses an
 * editor who RAISES or REMOVES a limit that is in force (setting a first one and lowering stay open). The worker reads them in
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

/** Zero-width and bidirectional marks and the BOM: invisible, often pasted in from right-to-left text, never part of an amount. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** What a person typed -> the number to store (null = no limit, remove the key), or why not. A comma is accepted as the decimal mark. */
export function parseSpendCeiling(input: string): SpendCeilingParse {
  const text = input.replace(INVISIBLE, "").trim();
  if (text === "") return { ok: true, value: null };
  if (/^-\d+([.,]\d+)?$/.test(text)) return { ok: false, reason: "not_positive" };
  if (!/^\d+([.,]\d{1,2})?$/.test(text)) return { ok: false, reason: "invalid" };
  const value = Number(text.replace(",", "."));
  if (!Number.isFinite(value) || value > MAX_SPEND_CEILING_USD) return { ok: false, reason: "too_large" };
  if (!(value > 0)) return { ok: false, reason: "not_positive" };
  return { ok: true, value };
}

// ASCII only, on purpose: the worker reads text with the same pattern (modules/channels._ASCII_NUMBER). JS trim() would also strip
// a BOM and Unicode spaces, which the worker does not, so the whitespace is spelled out.
const NUMERIC_TEXT = /^[ \t\n\r\f\v]*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[ \t\n\r\f\v]*$/;

/**
 * The ceiling the worker enforces for a stored value, or null for none (modules/channels._as_optional_float): only a finite
 * number above 0, or text that is one, counts. Anything else, a boolean or a list included, is no ceiling, and the page says so.
 */
export function effectiveSpendCeiling(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && NUMERIC_TEXT.test(raw)) n = Number(raw.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, ""));
  else return null;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `pinned_comment` / `watch_next`: absent is ON, only a real false is off (modules/channels.py). */
export function flagIsOn(raw: unknown): boolean {
  return raw !== false;
}

/** The hint migration 0119's refusal carries (and the prefix of its message). */
export const SPEND_CEILING_LOCK_HINT = "spend_ceiling_lock";

/**
 * Is this a PostgREST / RPC error the spend-limit lock raised: an editor tried to raise or remove a limit that is in force? The
 * database decides, on the row as it is when the write runs (not on what the page was drawn with, which may be stale), so the
 * page does not pre-judge: it sends the write and words this refusal in the person's language.
 */
export function isSpendCeilingLockRefusal(err: { code?: string | null; message?: string | null; hint?: string | null } | null | undefined): boolean {
  if (!err) return false;
  return err.hint === SPEND_CEILING_LOCK_HINT || (typeof err.message === "string" && err.message.includes(SPEND_CEILING_LOCK_HINT));
}

/** "$25.50", the same in every language (a currency format would reorder the symbol in ru and uz). */
export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
