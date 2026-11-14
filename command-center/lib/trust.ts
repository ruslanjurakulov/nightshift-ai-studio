/**
 * The public /trust page (app/trust/page.tsx, components/site/TrustPage.tsx): the facts it is built from that are
 * code, not copy. The words are per language in lib/i18n/trust/*.ts.
 *
 * Every sentence on the page describes what the code does today, and tests/trust-page.test.tsx pins the ones a later
 * change could quietly make false: the YouTube permissions are rendered from YOUTUBE_OAUTH_SCOPES itself
 * (lib/server/google-oauth.ts), the privacy default is config.YOUTUBE_PRIVACY's, the "no code deletes a video" line is
 * checked against modules/ and tools/. When one of those changes, re-read the page, change it, and move this date.
 */

/** The day every sentence on /trust was last checked against the code. A date, never "today". */
export const TRUST_LAST_REVIEWED = "2026-11-14";

/** The one domain the product is served from (deploy/Caddyfile: production DOMAIN; lib/api/docs-origin.ts). */
export const SITE_DOMAIN = "nightshift-ai.studio";

/** The page's sections, in order: each is an `id` the page renders and a key of the copy's `nav`. */
export const TRUST_SECTIONS = ["youtube", "keys", "publishing", "ai-label", "no-fallback", "payments", "report", "real"] as const;
export type TrustSectionId = (typeof TRUST_SECTIONS)[number];
