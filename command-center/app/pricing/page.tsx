import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { createClient } from "@/lib/supabase/server";
import { readCreditPrices } from "@/lib/server/credits";
import { creditRates, type CreditRates } from "@/lib/pricing";
import { packExpiry } from "@/lib/plans";
import { sitePlanMatrix, sitePricing } from "@/lib/server/payments";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";
import { readPublicPlanCatalog } from "@/lib/server/public-catalog";
import { planValue, readPlanCatalog, type PlanRead } from "@/lib/server/plans";
import { generationRates, type GenerationRates, type PlanCatalog } from "@/lib/plans";
import { readSellableModels } from "@/lib/creative/registry";
import { moneyAnchor, runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { readPublicApiPrices } from "@/lib/server/api-prices";
import { PUBLIC_READ_TIMEOUT_MS } from "@/lib/server/public-read";
import { readReferralTerms } from "@/lib/server/referrals";
import { readPublicCreditRates, readPublicVideoPrices } from "@/lib/server/public-rates";
import { readCustomerModels } from "@/lib/server/model-discovery";
import { UNIT_JOB_MINIMUM, type PriceMap } from "@/lib/credits";
import { studioRows, videoPrices, videoRateSetAt, type PlanFinderData } from "@/lib/plan-finder";
import { PublicShell } from "@/components/legal/PublicShell";
import { PricingView } from "@/components/pricing/PricingView";
import { isPlatformAdmin } from "@/lib/auth/org-roles";

// Who is asking decides the rates panel, so this is never a static page.
export const dynamic = "force-dynamic";

/** Public: middleware lets this path through signed in or out (lib/public-paths.ts). */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const title = `${t.pricing.title} · ${t.brand.name}`;
  const description = t.pricing.metaDescription;
  return {
    title: { absolute: title },
    description,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: "/pricing",
      title,
      description,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

/**
 * What a credit pack costs, what a credit buys, and who sells it — the page
 * Paddle's seller verification reads, and the one the Terms link to.
 *
 * Prices come only from Paddle's preview or the owner's display env
 * (lib/pricing.ts). The live credit rates come from credit_rates() (0084: the
 * rates as charged, never the margin) for a signed-in account, and from
 * public_video_rates() (0089: per minute and the smallest hold) for anyone
 * else; when neither is published the page says so rather than showing a
 * number it would have had to guess.
 */
export default async function PricingPage() {
  const { t, locale } = await getDictionary();
  // PAYMENTS_PROVIDER: Paddle (the default) exactly as before, or Dodo's catalog prices (lib/server/payments.ts).
  const pricing = sitePricing();
  // The money a signed-out visitor can be shown: published pack prices, the
  // live API price list (public by 0031) and the two public credit rates
  // (per minute and the smallest hold, 0089). Read alongside the rest.
  const apiPricesRead = readPublicApiPrices();
  const publicRatesRead = readPublicCreditRates();
  // The referral programme (0165): mentioned only while open, with the database's numbers (a shared, bounded public read).
  const referralRead = readReferralTerms();
  // The same two rows, unrounded, for "what does my plan make?": a video there is quoted exactly as Run now quotes it.
  const publicVideoRead = readPublicVideoPrices();
  const readAt = new Date().toISOString();

  const supabase = await createClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;
  // Asked of the database, never a client flag: only the platform admin is shown the test checkout (PricingView).
  // A lookup that fails is "no", so an error closes test sales rather than opening them.
  const operatorRead = user ? isPlatformAdmin() : Promise.resolve(false);
  // The plan catalog is a public price list (0034). Signed out, it is the
  // shared public read — bounded, kept and run alongside the price reads
  // (BR-L-047, BR-L-101); signed in, a per-request read, bounded the same way.
  // `unsupported` (0034 not applied) offers no plans, as before; `failed` says
  // the plans could not be read instead of silently showing none.
  const catalogPending: Promise<PlanRead<PlanCatalog>> = !supabase
    ? Promise.resolve({ state: "unsupported" as const })
    : user
      ? readPlanCatalog(supabase, { signal: AbortSignal.timeout(PUBLIC_READ_TIMEOUT_MS) }).catch(() => ({ state: "failed" as const }))
      : readPublicPlanCatalog();
  let rates: CreditRates | null = null;
  let ratesFailed = false;
  let genRates: GenerationRates | null = null;
  let memberPrices: PriceMap | null = null;
  let studio: PlanFinderData["studio"] = { status: supabase ? "signed_out" : "not_enabled" };
  if (supabase && user) {
    const [res, models, customer] = await Promise.all([readCreditPrices(supabase), readSellableModels(supabase), readCustomerModels(supabase)]);
    // A failed read is no rates at all — not an empty price list — and the
    // page says it could not read them, which is not "not published yet".
    if (res.supported && !res.failed) {
      rates = creditRates(res.prices);
      // "≈ N images · M videos" from the same two reads the Credits page uses;
      // a model list that could not be read leaves those parts out, never guessed.
      genRates = generationRates(models.status === "ok" ? models.models : null, res.prices);
      memberPrices = res.prices;
    }
    ratesFailed = res.failed;
    // The Studio rows need the list's job_minimum too (creative_price raises every quote to it): without a readable
    // list an image's price is unknown, so the rows are not shown at all rather than shown without their floor.
    studio =
      customer.status === "ok" && memberPrices
        ? { status: "ok", rows: studioRows(customer.models, memberPrices[UNIT_JOB_MINIMUM]?.creditsPerUnit ?? 0), stamp: { kind: "read", at: readAt } }
        : customer.status === "not_enabled"
          ? { status: "not_enabled" }
          : customer.status === "forbidden"
            ? { status: "signed_out" }
            : { status: "failed" };
  }
  // Signed out (or before 0084), the rates panel, the pack minutes and the
  // money anchor read the public pair; unpublished stays null, never guessed.
  const publicRates = await publicRatesRead;
  if (!rates && !ratesFailed) rates = publicRates;
  // A member's own list when it was read (it carries each rate's updated_at), the public pair otherwise, and nothing
  // when the member's read failed — as the rates panel above: unknown, never the other list standing in for it.
  const video = memberPrices ? videoPrices(memberPrices) : ratesFailed ? null : videoPrices(await publicVideoRead);
  const setAt = videoRateSetAt(video);
  const finder: PlanFinderData = {
    video,
    videoStamp: video ? (setAt ? { kind: "set", at: setAt } : { kind: "read", at: readAt }) : null,
    studio,
  };
  const catalogRead = await catalogPending;
  const catalog = planValue(catalogRead);
  const plans = sitePlanMatrix(catalog, locale);
  const referral = await referralRead;

  return (
    <PublicShell t={t} fresh>
      <PricingView
        t={t}
        locale={locale}
        pricing={pricing}
        signedIn={Boolean(user)}
        rates={rates}
        ratesFailed={ratesFailed}
        generationRates={genRates}
        plansFailed={catalogRead.state === "failed"}
        plans={plans}
        expiry={packExpiry(catalogRead, CREDIT_EXPIRY_MONTHS)}
        anchor={moneyAnchor(pricing, await apiPricesRead, publicRates)}
        referral={referral.state === "ok" ? referral.value : null}
        finder={finder}
        operator={await operatorRead}
      />
    </PublicShell>
  );
}
