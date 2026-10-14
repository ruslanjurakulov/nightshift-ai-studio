/**
 * First-party, cookieless page counts for the PUBLIC site (migration 0103).
 *
 * What a count is: one added to a daily total for (path, referring HOST, device
 * class, language). What it can never be: a visitor. There is no cookie, no
 * localStorage or sessionStorage key, no IP address, no user agent, no
 * fingerprint and no id of any kind, on the page, on the wire or in the
 * database; the beacon is sent with credentials omitted, so the request itself
 * carries no cookie either. Do-Not-Track and Global Privacy Control are honoured
 * twice (the page does not send, and the route counts nothing if it is sent).
 *
 * Pure and client-safe: the decisions are unit-tested (tests/page-views.test.ts).
 */

/** The route the page posts to (public, exact; lib/public-paths.ts PAGE_VIEW_PATH). */
export const PAGE_VIEW_ENDPOINT = "/api/pv";

import { LOCALES, type Locale } from "@/lib/i18n/core";

export const PAGE_VIEW_DEVICES = ["mobile", "desktop"] as const;
/** The site's languages come from the one registry (lib/i18n/core.ts LOCALES): a language added there is counted with no edit here. */
export const PAGE_VIEW_LANGS: readonly Locale[] = LOCALES.map((l) => l.code);
export type PageViewDevice = (typeof PAGE_VIEW_DEVICES)[number];
export type PageViewLang = Locale;

/** What the page sends: four short strings, nothing that names a person. */
export interface PageViewBeacon {
  path: string;
  /** The referring site's host ("news.example"), or "" for a direct visit. */
  ref: string;
  device: PageViewDevice;
  lang: PageViewLang;
}

/** A DNS host name as migration 0103 stores it: lowercase, 2 to 100 characters, no port, no path. */
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])?$/;

/**
 * The host of a referrer URL, or "" when there is none, it is not http(s), it
 * is this site itself (a click inside the site is not a referral) or it is not
 * a plain host name. Only the host is kept: the path and query of a referring
 * page can carry a search or a person's account, and are dropped here, before
 * anything is sent.
 */
export function referrerHost(referrer: string, ownHost: string): string {
  if (!referrer) return "";
  let u: URL;
  try {
    u = new URL(referrer);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!HOST.test(host)) return "";
  const own = ownHost.toLowerCase().replace(/:\d+$/, "");
  return host === own || host === `www.${own}` || `www.${host}` === own ? "" : host;
}

/** A phone-sized window counts as mobile. The Desktop view a phone may choose (width=1280) counts as desktop, which is what the page then is. */
export function deviceClass(viewportWidth: number): PageViewDevice {
  return viewportWidth < 768 ? "mobile" : "desktop";
}

/** Next treats /terms/ as /terms. */
export function countedPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
}

/** Did the browser ask not to be tracked? (DNT header "1", or Global Privacy Control "1".) */
export function optedOut(headers: { get(name: string): string | null }): boolean {
  return headers.get("dnt") === "1" || headers.get("sec-gpc") === "1";
}

/** The same two signals as the page sees them. */
export function optedOutInBrowser(nav: { doNotTrack?: string | null; globalPrivacyControl?: boolean }, win: { doNotTrack?: string | null }): boolean {
  return nav.doNotTrack === "1" || nav.doNotTrack === "yes" || win.doNotTrack === "1" || nav.globalPrivacyControl === true;
}

/**
 * Programs that are not people: crawlers, link-preview fetchers, headless
 * browsers, monitors and HTTP libraries. A CLOSED list matched against the
 * user agent in memory; the user agent is never stored or logged. A page that
 * ran this far already executed JavaScript, which most of these do not; the
 * list catches the ones that do. An empty user agent is not a browser.
 */
const BOT_UA =
  /bot|crawl|spider|slurp|scrap|headless|lighthouse|pagespeed|gtmetrix|prerender|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|curl|wget|python|java\b|go-http|okhttp|libwww|httpclient|node-fetch|undici|axios|monitor|uptime|pingdom|phantom|selenium|playwright|puppeteer/i;

export function isBotUserAgent(ua: string | null): boolean {
  return !ua || BOT_UA.test(ua);
}

/**
 * The beacon, or null when it is not one. Anything but the four expected
 * strings is refused here and again in the database, which holds the closed
 * path list; a refusal changes nothing and says nothing.
 */
export function parseBeacon(raw: unknown): PageViewBeacon | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.path !== "string" || b.path.length > 64 || !b.path.startsWith("/")) return null;
  if (typeof b.ref !== "string" || b.ref.length > 100 || (b.ref !== "" && !HOST.test(b.ref))) return null;
  if (!(PAGE_VIEW_DEVICES as readonly unknown[]).includes(b.device)) return null;
  if (!PAGE_VIEW_LANGS.includes(b.lang as Locale)) return null;
  return { path: countedPath(b.path), ref: b.ref, device: b.device as PageViewDevice, lang: b.lang as PageViewLang };
}

/** One in-process ceiling for the route (a serverless instance forgets it; the database's ceiling is the one that holds). */
export const PAGE_VIEW_ROUTE_LIMIT = { max: 300, windowMs: 60_000 };

let windowStart = 0;
let windowCount = 0;

/** True while this process may still count one more view this minute. No address or visitor is involved. */
export function takePageView(now = Date.now()): boolean {
  const start = Math.floor(now / PAGE_VIEW_ROUTE_LIMIT.windowMs) * PAGE_VIEW_ROUTE_LIMIT.windowMs;
  if (start !== windowStart) {
    windowStart = start;
    windowCount = 0;
  }
  windowCount += 1;
  return windowCount <= PAGE_VIEW_ROUTE_LIMIT.max;
}

/** For tests. */
export function resetPageViewLimit() {
  windowStart = 0;
  windowCount = 0;
}
