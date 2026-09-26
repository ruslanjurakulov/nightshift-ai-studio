/**
 * The pure half of the public landing page — unit-tested in tests/landing.test.ts.
 *
 * Everything here decides what the page is ALLOWED to say, and each rule is the
 * landing-page form of CLAUDE.md rule 5: a result nobody measured, a price
 * nobody set, or an origin nobody configured is left out, never filled in.
 */

import type { Pricing } from "@/lib/pricing";
import type { CreditPackId } from "@/lib/paddle";

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
export function pricingTeaser(pricing: Pricing): PricingTeaser {
  if (pricing.source === "none" || pricing.packs.length === 0) return { kind: "announced" };
  return {
    kind: "packs",
    packs: pricing.packs.map((p) => ({ id: p.id, credits: p.credits, price: p.displayPrice })),
  };
}

// ── SEO ───────────────────────────────────────────────────────────────────────

export interface SiteEnv {
  APP_ORIGIN?: string;
}

/**
 * The site's public origin for canonical and OpenGraph URLs, or null.
 *
 * A deploy states it once in APP_ORIGIN — the same variable the OAuth redirect
 * trusts (lib/server/public-origin.ts), already set by the self-hosted compose
 * file. Request headers are not consulted: a canonical URL a client can steer
 * is worse than none. Unset, the page leaves canonical and og:url out.
 */
export function siteOrigin(env: SiteEnv): string | null {
  const v = (env.APP_ORIGIN ?? "").trim();
  if (!v) return null;
  try {
    const url = new URL(v);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
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
