/**
 * The pure half of the public landing page — unit-tested in tests/landing.test.ts.
 *
 * Everything here decides what the page is ALLOWED to say, and each rule is the
 * landing-page form of CLAUDE.md rule 5: a result nobody measured, a price
 * nobody set, or an origin nobody configured is left out, never filled in.
 */

import { plansOnSale, type PlanMatrix } from "@/lib/plans";
import { displayPriceCents, type CreditRates, type Pricing } from "@/lib/pricing";
import type { CreditPackId } from "@/lib/paddle";
import type { ApiPriceMap } from "@/lib/api/pricing";

// ── Output showcase ───────────────────────────────────────────────────────────

/**
 * One real video Nightshift produced, shown on the landing page.
 *
 * HOW TO ADD ONE: append an entry to SHOWCASE below — the YouTube video id (the
 * 11 characters after `watch?v=`), its title exactly as published, and the
 * channel's name. Only add videos that are PUBLIC on YouTube and whose channel
 * owner agreed to be shown; the thumbnail is YouTube's own, loaded from
 * i.ytimg.com, so nothing is stored here. While the list is empty the whole
 * section is left out of the page: an empty "results" grid, or a mock one, would
 * be a claim with nothing behind it.
 */
export interface ShowcaseItem {
  youtubeId: string;
  title: string;
  channel: string;
  /** "short" renders a 9:16 card; anything else a 16:9 one. */
  format?: "long" | "short";
}

export const SHOWCASE: readonly ShowcaseItem[] = [];

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** The entries fit to show. A malformed id or a blank title is dropped rather
 *  than rendered as a broken card. */
export function visibleShowcase(items: readonly ShowcaseItem[]): ShowcaseItem[] {
  return items.filter(
    (it) => YOUTUBE_ID_RE.test(it.youtubeId) && it.title.trim() !== "" && it.channel.trim() !== "",
  );
}

// ── Pricing teaser ────────────────────────────────────────────────────────────

export type PricingTeaser =
  | { kind: "announced" }
  | {
      kind: "packs";
      packs: { id: CreditPackId; credits: number; price: string | null }[];
    }
  | {
      /** Monthly plans (0034) are on sale: the teaser lists them instead of packs. */
      kind: "plans";
      plans: { id: string; name: string; credits: number; price: string | null }[];
    };

/**
 * What the landing page's pricing section shows, from the same source /pricing
 * reads (lib/pricing.ts: Paddle, then the owner's display env).
 *
 * The landing page is a Server Component with no Paddle script, so it shows
 * only the owner's display price; a pack Paddle sells without one reads
 * "price at checkout" (price: null), and with no pricing configured at all the
 * section says pricing is announced at launch. It never prints a number the
 * owner did not set.
 */
export function pricingTeaser(pricing: Pricing, plans: PlanMatrix | null = null): PricingTeaser {
  if (plans && plansOnSale(plans)) {
    return {
      kind: "plans",
      plans: plans.columns
        .filter((c) => !c.isDefault && (c.priceId !== null || c.displayPrice !== null))
        .map((c) => ({ id: c.id, name: c.name, credits: c.monthlyCredits, price: c.displayPrice })),
    };
  }
  if (pricing.source === "none" || pricing.packs.length === 0) return { kind: "announced" };
  return {
    kind: "packs",
    packs: pricing.packs.map((p) => ({ id: p.id, credits: p.credits, price: p.displayPrice })),
  };
}

// ── Money anchor ─────────────────────────────────────────────────────────────

/**
 * The money a visitor can know before signing up, and only that.
 *
 * - pack: the smallest top-up pack with a published price (the owner's display
 *   price — the same text /pricing shows); "checkout" when Paddle sells packs
 *   but no display price is set (its preview runs in the browser on /pricing);
 *   "none" when nothing is on sale.
 * - api: what a video costs through the API, in US cents, from the live
 *   api_prices list — null when it could not be read. The seeded defaults are
 *   never used here: they are a fresh database's starting point, not a price.
 *
 * - site: what a video costs in the app, in credits per finished minute and
 *   the smallest hold, from the live list (public_video_rates(), 0089) — null
 *   when it is not published or could not be read. With a priced pack whose
 *   price is a plain US-dollar amount, also that minute in dollars at that
 *   pack's price (rounded to the cent, shown as "≈"); any other display price
 *   is never reinterpreted.
 *
 * Nothing else is derived: no "from" computed across plans, and no figure
 * from a default.
 */
export type MoneyAnchor = {
  pack: { kind: "priced"; id: CreditPackId; credits: number; price: string } | { kind: "checkout" } | { kind: "none" };
  api: { perMinuteCents: number; minimumCents: number | null } | null;
  site: { perMinute: number; minimum: number | null; usd: { cents: number; pack: CreditPackId } | null } | null;
};

export function moneyAnchor(
  pricing: Pricing,
  apiPrices: ApiPriceMap | null,
  siteRates: CreditRates | null = null,
): MoneyAnchor {
  const priced = pricing.packs
    .filter((p) => p.displayPrice !== null)
    .sort((a, b) => a.credits - b.credits)[0];
  const pack: MoneyAnchor["pack"] = priced?.displayPrice
    ? { kind: "priced", id: priced.id, credits: priced.credits, price: priced.displayPrice }
    : pricing.source === "paddle" && pricing.packs.length > 0
      ? { kind: "checkout" }
      : { kind: "none" };
  const perMinute = apiPrices?.video_minute;
  const minimum = apiPrices?.job_minimum;
  // A zero per-minute price is not a price someone set for a video; read it as unpublished.
  const api =
    typeof perMinute === "number" && perMinute > 0
      ? { perMinuteCents: perMinute, minimumCents: typeof minimum === "number" && minimum > 0 ? minimum : null }
      : null;
  let site: MoneyAnchor["site"] = null;
  if (siteRates && siteRates.perMinute !== null && siteRates.perMinute > 0) {
    const packCents = pack.kind === "priced" ? displayPriceCents(pack.price) : null;
    const usd =
      pack.kind === "priced" && packCents !== null && pack.credits > 0
        ? { cents: Math.max(1, Math.round((siteRates.perMinute * packCents) / pack.credits)), pack: pack.id }
        : null;
    site = { perMinute: siteRates.perMinute, minimum: siteRates.jobMinimum, usd };
  }
  return { pack, api, site };
}

// ── SEO ───────────────────────────────────────────────────────────────────────

export interface SiteEnv {
  APP_ORIGIN?: string;
  /** Vercel's production domain, a bare host ("app.example.com"); set on every Vercel deploy. */
  VERCEL_PROJECT_PRODUCTION_URL?: string;
}

function httpOrigin(value: string | undefined, assumeHttps = false): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  try {
    const url = new URL(assumeHttps && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? `https://${v}` : v);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // A loopback origin in a card is the bug this exists to stop.
    if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The site's public origin for canonical, OpenGraph and Twitter URLs, or null.
 *
 * A deploy states it in APP_ORIGIN — the same variable the OAuth redirect
 * trusts (lib/server/public-origin.ts), already set by the self-hosted compose
 * file — or, failing that, the production domain Vercel sets on every deploy. Request headers are not consulted: a canonical
 * URL a client can steer is worse than none. A loopback host is never an
 * answer. Unset, a page leaves canonical, og:url and the share image out
 * (shareMetadata) rather than let Next resolve them against localhost.
 */
export function siteOrigin(env: SiteEnv): string | null {
  return (
    httpOrigin(env.APP_ORIGIN) ??
    httpOrigin(env.VERCEL_PROJECT_PRODUCTION_URL, true)
  );
}

/** The origin for this request's metadata, from the environment read by literal
 *  name at request time (a self-hosted deploy sets APP_ORIGIN in the container,
 *  not at build). */
export function runtimeSiteOrigin(): string | null {
  return siteOrigin({
    APP_ORIGIN: process.env.APP_ORIGIN,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  });
}

/** Served by app/og.png/route.tsx; see there for why it is not opengraph-image.tsx. */
export const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, type: "image/png" } as const;

const OG_LOCALE = { en: "en_US", ru: "ru_RU", uz: "uz_UZ" } as const;

/**
 * The share metadata every public page carries: canonical, OpenGraph and the
 * Twitter card, all on one origin.
 *
 * With an origin, metadataBase is set and every URL — og:url, og:image,
 * twitter:image — is absolute on it. Without one, there is no URL to give a
 * crawler that would not be a guess (Next would resolve it against
 * localhost), so the card goes out with no image, a plain summary card, and
 * no canonical: a missing picture beats a broken one.
 */
export function shareMetadata(input: {
  origin: string | null;
  path: string;
  title: string;
  description: string;
  siteName: string;
  imageAlt: string;
  locale?: keyof typeof OG_LOCALE;
}) {
  const { origin, path, title, description, siteName, imageAlt, locale } = input;
  const image = origin ? { ...OG_IMAGE, url: new URL(OG_IMAGE.url, origin).toString(), alt: imageAlt } : null;
  return {
    ...(origin ? { metadataBase: new URL(origin), alternates: { canonical: path } } : {}),
    openGraph: {
      type: "website" as const,
      siteName,
      title,
      description,
      ...(locale ? { locale: OG_LOCALE[locale] } : {}),
      ...(origin ? { url: new URL(path, origin).toString() } : {}),
      ...(image ? { images: [image] } : {}),
    },
    twitter: {
      card: image ? ("summary_large_image" as const) : ("summary" as const),
      title,
      description,
      ...(image ? { images: [{ url: image.url, alt: imageAlt }] } : {}),
    },
  };
}

/**
 * schema.org SoftwareApplication for the homepage. Deliberately without
 * `offers` or `aggregateRating`: prices are the owner's to publish and there
 * are no ratings, so neither is invented to win a rich result.
 */
export function softwareApplicationJsonLd(input: {
  name: string;
  description: string;
  url: string | null;
}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: input.name,
    description: input.description,
    applicationCategory: "MultimediaApplication",
    operatingSystem: "Web",
    ...(input.url ? { url: input.url } : {}),
  };
}

/** JSON for an inline <script type="application/ld+json">: `<` is escaped so a
 *  string in the data can never close the script element. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
