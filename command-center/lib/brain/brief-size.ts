/**
 * How many bytes a BRIEF takes as the database measures it: octet_length(brief::text), jsonb's own text form ("key": value, items
 * joined by ", "), without ref_sheets and film_link, which 0249 counts apart (ai_chat_sessions_brief_0249). Pure.
 *
 * Why the route measures at all: a turn's BRIEF over 0199's 262144 bytes used to fail inside ai_chat_finish_turn and roll the paid
 * call back to pending (Breach BR-SW-08). The route now ends such a turn as brief_too_large itself, with the tokens it was told, and
 * 0249's finish_turn does the same if a BRIEF ever reaches it over the limit. jsonb sorts keys, which does not change the length;
 * strings are escaped as JSON.stringify escapes them; a safe integer prints alike, any other number is counted at its worst case.
 */
export const BRIEF_MAX_BYTES = 262144;

const enc = new TextEncoder();
/** The most bytes one double can take in jsonb's text form, rounded up. */
export const NUMBER_WORST = 330;

function size(v: unknown): number {
  if (v === null || v === undefined) return 4;
  if (typeof v === "string") return enc.encode(JSON.stringify(v)).length;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return 4; // JSON writes it as null
    // jsonb prints a number in full where JavaScript uses an exponent (1e21 is 22 digits, 1e-7 is 0.0000001, 1e300 is 301
    // digits), and its decimals can differ from String(v). Only a safe integer is printed alike; anything else is counted at the
    // longest a double can print as jsonb (5e-324: "0." and 323 more digits, a sign) so that this never counts low (Lens 4).
    return Number.isSafeInteger(v) ? String(v).length : NUMBER_WORST;
  }
  if (typeof v === "boolean") return v ? 4 : 5;
  if (Array.isArray(v)) return v.length ? 2 + v.reduce((n: number, x) => n + size(x), 0) + 2 * (v.length - 1) : 2;
  if (typeof v === "object") {
    // JSON drops undefined members, and so does a BRIEF sent through PostgREST.
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!entries.length) return 2;
    return 2 + entries.reduce((n, [k, x]) => n + enc.encode(JSON.stringify(k)).length + 2 + size(x), 0) + 2 * (entries.length - 1);
  }
  return 4;
}

export function briefBytes(brief: unknown): number {
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) return size(brief);
  const rest = { ...(brief as Record<string, unknown>) };
  delete rest.ref_sheets;
  delete rest.film_link;
  return size(rest);
}
