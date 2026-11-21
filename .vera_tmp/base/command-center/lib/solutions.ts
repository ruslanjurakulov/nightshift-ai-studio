/**
 * The Solutions pages: which exist, and where. Their words live in
 * lib/i18n/site/*.ts (site.solutions.pages, one entry per id, same order in
 * every language — tests/site-copy.test.ts holds that); this file is the list
 * the router, the footer and the auth gate agree on.
 *
 * Each id is a public URL, so lib/public-paths.ts lists every one of them
 * exactly (a prefix match would publish whatever else came to live under
 * /solutions/).
 */
export const SOLUTION_IDS = ["youtube-channels", "creative-studio", "developers"] as const;

export type SolutionId = (typeof SOLUTION_IDS)[number];

export const SOLUTIONS_PATH = "/solutions";

export function solutionHref(id: SolutionId): string {
  return `${SOLUTIONS_PATH}/${id}`;
}

export function isSolutionId(value: string): value is SolutionId {
  return (SOLUTION_IDS as readonly string[]).includes(value);
}
