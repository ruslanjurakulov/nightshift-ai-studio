import { CHANNEL_HEADER } from "@/lib/channels";

/**
 * The navy/neon look (app/tokens.css) is the signed-in app's only. The owner chose (2026-11-22) the public site — "/",
 * /pricing, the legal pages, sign-in and sign-up, /welcome, the 404 and every other page a signed-out visitor sees — as it
 * looked before 20 November, which is the same CSS without this class on <html>.
 */
export const DS_SKIN_CLASS = "ds-skin";

/**
 * Whether this request is a signed-in app page, decided by the middleware, never guessed from the URL: it sets the channel
 * header only after gateDecision() said "app" (middleware.ts, the last step of gate()), and never for a "pass" (every public
 * path in lib/public-paths.ts, /welcome and /reset-password included) or the public 404 rewrite.
 */
export function skinOnFor(headers: { get(name: string): string | null }): boolean {
  return headers.get(CHANNEL_HEADER) !== null;
}
