/**
 * The first name the owner's Nightshift AI greets with, from the auth user's metadata (Google sign-in fills given_name / full_name /
 * name; an email sign-up usually fills none). No name is "no name": the page says a plain hello rather than greeting someone by an
 * email address or a guess.
 */
const MAX = 40;

export function firstNameOf(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  for (const key of ["given_name", "first_name", "full_name", "name"]) {
    const v = m[key];
    if (typeof v !== "string") continue;
    const first = v.trim().split(/\s+/)[0] ?? "";
    // An address typed into a name field is still an address: not a name to greet by.
    if (first !== "" && !first.includes("@")) return first.slice(0, MAX);
  }
  return null;
}
