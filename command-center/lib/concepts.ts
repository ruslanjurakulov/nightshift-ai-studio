/**
 * The Atelier concept stage (docs/design/ATELIER_CONCEPTS.md): three hero
 * compositions for the public landing, built as real prototypes so they can be
 * looked at and scored before any of them is applied.
 *
 * They are NOT public pages. The rules, in one place so the middleware, the
 * page and the tests read the same ones:
 *
 *  - The flag is `ATELIER_CONCEPTS=1`, read at request time from the server's
 *    environment (never `NEXT_PUBLIC_`, so it is not baked into a bundle and
 *    never reaches a browser). Anything else, including unset, is OFF.
 *  - OFF: everything under `/atelier` answers the public 404, signed in or
 *    out, with or without a backend. The paths are in no sitemap, no robots
 *    rule (a robots line would publish the path), and none of the public-path
 *    lists in lib/public-paths.ts; the page itself checks the flag too, so a
 *    request that ever reached it would still be a 404.
 *  - ON: exactly `/atelier/a`, `/atelier/b` and `/atelier/c` are served to
 *    anyone who can reach the deploy, with `noindex`. Every other path under
 *    `/atelier` stays a 404. The auth gate and its matcher
 *    (BR-H-001, lib/public-paths.ts) are not touched: this decision is made
 *    before the gate for this one namespace only, and answers "serve" only for
 *    three exact strings.
 */

/** The environment variable that switches the concepts on. */
export const CONCEPT_FLAG = "ATELIER_CONCEPTS";

/** The one URL namespace the concepts live under. */
export const CONCEPT_ROOT = "/atelier";

export const CONCEPT_VARIANTS = ["a", "b", "c"] as const;
export type ConceptVariant = (typeof CONCEPT_VARIANTS)[number];

export function isConceptVariant(value: string): value is ConceptVariant {
  return (CONCEPT_VARIANTS as readonly string[]).includes(value);
}

/** The concept URLs, exactly as they are served when the flag is on. */
export const CONCEPT_PATHS: readonly string[] = CONCEPT_VARIANTS.map((v) => `${CONCEPT_ROOT}/${v}`);

/** On only for the literal "1". "true", "yes", " 1" and the empty string are off. */
export function conceptsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[CONCEPT_FLAG] === "1";
}

/** Is this path inside the concept namespace at all (case-insensitive, any depth)? */
export function inConceptNamespace(pathname: string): boolean {
  const first = pathname.split("/")[1] ?? "";
  return first.toLowerCase() === CONCEPT_ROOT.slice(1);
}

/**
 * What the middleware does with a request:
 * - `serve`: flag on and the path is exactly one of the three concept URLs.
 * - `hide`: anything else inside the namespace (flag off, a typo, a deeper
 *   path, an encoded spelling): the public 404.
 * - `none`: not a concept path; the existing gate decides, unchanged.
 */
export type ConceptDecision = "serve" | "hide" | "none";

export function conceptDecision(pathname: string, enabled: boolean): ConceptDecision {
  if (!inConceptNamespace(pathname)) return "none";
  if (!enabled) return "hide";
  // Next treats `/atelier/a/` as `/atelier/a`.
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return CONCEPT_PATHS.includes(trimmed) ? "serve" : "hide";
}
