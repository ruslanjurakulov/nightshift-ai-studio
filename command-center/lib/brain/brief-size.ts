/**
 * How many bytes a BRIEF takes as the database measures it: octet_length(brief::text), jsonb's own text form ("key": value, items
 * joined by ", "), without ref_sheets and film_link, which 0249 counts apart (ai_chat_sessions_brief_0249). Pure.
 *
 * Why the route measures at all: a turn's BRIEF over 0199's 262144 bytes used to fail inside ai_chat_finish_turn and roll the paid
 * call back to pending (Breach BR-SW-08). The route now ends such a turn as brief_too_large itself, with the tokens it was told, and
 * 0249's finish_turn does the same if a BRIEF ever reaches it over the limit. jsonb sorts keys, which does not change the length;
 * strings are escaped as JSON.stringify escapes them; numbers here are the BRIEF's integers and short decimals, printed alike.
 */
export const BRIEF_MAX_BYTES = 262144;

const enc = new TextEncoder();

function size(v: unknown): number {
  if (v === null || v === undefined) return 4;
  if (typeof v === "string") return enc.encode(JSON.stringify(v)).length;
  if (typeof v === "number") return Number.isFinite(v) ? String(v).length : 4;
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
