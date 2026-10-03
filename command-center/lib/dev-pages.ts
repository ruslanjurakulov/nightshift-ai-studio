/**
 * The CLI and Agent Skills pages (/docs/cli, /docs/skills), switched by a flag.
 *
 * The command-line tool and the skills are built on their own branch and are
 * not published to npm yet; the owner publishes them. Until then a page that
 * tells people to `npm i -g @nightshift/cli` would be a false promise, so the
 * two pages exist in code but answer the public 404.
 *
 *  - The flag is `DEV_CLI_PAGE=1`, read at request time from the server's
 *    environment (never `NEXT_PUBLIC_`, so it is not baked into a bundle).
 *    Anything else, including unset, is OFF.
 *  - OFF: exactly `/docs/cli` and `/docs/skills` answer the public 404, signed
 *    in or out, with or without a backend (middleware.ts decides before the
 *    gate; each page checks the flag again). Neither is linked from the
 *    header, footer or developer sub-navigation, and neither is in the sitemap.
 *  - ON: exactly those two paths are public pages like /docs/api.
 *
 * The pages' own text lives in lib/dev/cli-skills.ts so the commands can be
 * changed in one place the day the packages are published.
 */

/** The environment variable that switches the two pages on. */
export const DEV_PAGES_FLAG = "DEV_CLI_PAGE";

export const DEV_PAGE_PATHS = ["/docs/cli", "/docs/skills"] as const;
export type DevPagePath = (typeof DEV_PAGE_PATHS)[number];

/** On only for the literal "1". "true", "yes", " 1" and the empty string are off. */
export function devPagesEnabled(env?: Record<string, string | undefined>): boolean {
  // A literal read of the variable's name, because the deploy template test
  // scans for those; an injected map is for tests.
  const value = env ? env[DEV_PAGES_FLAG] : process.env.DEV_CLI_PAGE;
  return value === "1";
}

/** Next treats `/docs/cli/` as `/docs/cli`. */
function trimmed(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
}

export function isDevPagePath(pathname: string): boolean {
  return (DEV_PAGE_PATHS as readonly string[]).includes(trimmed(pathname));
}

/**
 * What the middleware does with a request:
 * - `serve`: flag on and the path is exactly one of the two pages.
 * - `hide`: flag off and the path is exactly one of the two pages: the public 404.
 * - `none`: not one of these pages; the existing gate decides, unchanged.
 */
export type DevPageDecision = "serve" | "hide" | "none";

export function devPageDecision(pathname: string, enabled: boolean): DevPageDecision {
  if (!isDevPagePath(pathname)) return "none";
  return enabled ? "serve" : "hide";
}
