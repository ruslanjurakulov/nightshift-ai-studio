import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, Lock } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import type { MoneyAnchor, PricingTeaser as PricingTeaserData, ShowcaseItem } from "@/lib/landing";
import { WELCOME_CREDITS } from "@/lib/pricing";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";
import { packExpiry, type PackExpiry } from "@/lib/plans";
import { creditUnit, formatCredits } from "@/lib/credits";
import { isSolutionId, solutionHref } from "@/lib/solutions";
import { ChatCard, chatCopy } from "@/components/landing/HeroCard";
import { Showcases } from "@/components/landing/Showcases";
import { TryDemo } from "@/components/landing/TryDemo";
import { PriceBlock } from "@/components/landing/PriceBlock";
import { ToolStrip } from "@/components/landing/ToolStrip";
import { HeroFx } from "@/components/site/HeroFx";
import { MotionToggle } from "@/components/site/MotionToggle";
import { StickyCta } from "@/components/site/StickyCta";
import { priceRatesFrom } from "@/lib/site/price-check";
import { Showcase } from "@/components/landing/Showcase";
import { Faq } from "@/components/landing/Faq";

const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

/**
 * The signed-out homepage, six blocks in a single column: what it is (a very
 * large headline and the chat card, with the frame on the first screen), how it
 * works (three steps in a strip), what it makes (three full-width showcases,
 * one still each), a hands-on example that needs no account and no server,
 * what it costs (the price check beside what is on sale, in one place), and the
 * questions and the button again.
 *
 * Every claim on it is one the code backs; the only figures are the welcome
 * grant (WELCOME_CREDITS, pinned to the database by a test) and whatever the
 * pricing source holds. No competitor and no AI provider is named, and there
 * are no testimonials, logos or usage numbers, because there are none to show.
 * The pictures are labelled examples (docs/design/SITE_ENGAGE.md).
 *
 * A Server Component. The client code on the page is the header's menu and its
 * theme and language keys, the hero's pause switch, the example, the price
 * slider, the start bar and the effects script.
 */
export function Landing({
  t,
  locale,
  pricing,
  anchor,
  showcase,
  expiry = packExpiry(null, CREDIT_EXPIRY_MONTHS),
}: {
  t: Dictionary;
  locale: Locale;
  pricing: PricingTeaserData;
  /** The money a visitor can know before signing up (lib/landing.ts moneyAnchor). */
  anchor: MoneyAnchor;
  showcase: ShowcaseItem[];
  /** How long top-up credits last (lib/plans.ts packExpiry): the catalog's policy, the env, or unknown. */
  expiry?: PackExpiry;
}) {
  return (
    <div className="lp-root">
      <Hero t={t} locale={locale} anchor={anchor} />
      <How t={t} />
      <Showcases t={t} />
      {showcase.length > 0 && (
        <div className="st-section">
          <div className="st-wrap">
            <Showcase t={t} items={showcase} hour="02:00" />
          </div>
        </div>
      )}
      <Try t={t} locale={locale} />
      <PriceBlock t={t} locale={locale} teaser={pricing} rates={priceRatesFrom(anchor)} />
      <Faq t={t} plansOnSale={pricing.kind === "plans"} expiry={expiry} aside={<GoogleData t={t} />} />
      <FinalCta t={t} />
      <StickyCta label={t.site.bar.label} text={t.site.bar.text} cta={t.site.bar.cta} dismiss={t.site.bar.dismiss} />
    </div>
  );
}

function Hero({ t, locale, anchor }: { t: Dictionary; locale: Locale; anchor: MoneyAnchor }) {
  const h = t.site.hero;
  const a = t.site.anchor;
  // The one price a visitor can know before signing up, said above the fold, and
  // only when the live price list says it: never a default, never a zero.
  const price = anchor.site
    ? `${a.siteLabel}: ${fmt(a.siteValue, { n: formatCredits(anchor.site.perMinute, locale), unit: creditUnit(anchor.site.perMinute, locale, t.shell.creditUnit) })}`
    : null;
  return (
    <section aria-labelledby="hero-title" className="nx-hero">
      <HeroFx />
      <div className="nx-wrap nx-hero-in nx-hero-grid">
        <div className="nx-hero-copy">
          <p className="nx-pill">
            <span aria-hidden className="nx-pill-dot" />
            {h.kicker}
          </p>
          <h1 id="hero-title" className="nx-h1">
            {h.titleA} <span className="nx-h1-b">{h.titleB}</span>
          </h1>
          <p className="nx-lead">{h.lead}</p>
          <div className="nx-actions">
            <Link href="/signup" className="nx-btn">
              {h.cta}
              <ArrowRight aria-hidden />
            </Link>
            <Link href="/pricing" className="nx-link">
              {h.secondary}
            </Link>
          </div>
          <p className="nx-note">{fmt(h.note, { n: formatCredits(WELCOME_CREDITS, locale) })}</p>
          {price && <p className="nx-price">{price}</p>}
          {/* The three things a visitor most wants settled, each backed by what the code does. */}
          <ul className="nx-trust" aria-label={t.site.rules.slug}>
            {t.site.rules.items.map((item) => (
              <li key={item.id}>
                <Check aria-hidden />
                {item.title}
              </li>
            ))}
          </ul>
        </div>
        <div className="nx-hero-visual">
          <ChatCard copy={chatCopy(t)} eager fx="sand" />
          <MotionToggle pause={t.site.fx.pause} />
        </div>
      </div>
    </section>
  );
}

/** Three steps in a strip: a numeral, a title, a sentence (the last one is the person's own press), and under them what Nightshift can make, as a strip of tool names you can swipe. */
function How({ t }: { t: Dictionary }) {
  const h = t.site.how.simple;
  const st = t.site.studio;
  return (
    <section id="how" aria-labelledby="how-title" className="nx-section" data-tone="raised">
      <div className="nx-wrap">
        <h2 id="how-title" className="nx-h2">
          {h.title}
        </h2>
        <ol className="nx-strip" aria-label={t.site.how.slug}>
          {h.steps.map((s, i) => (
            <li key={s.id} className="nx-strip-step">
              <span className="nx-strip-no" aria-hidden>
                {i + 1}
              </span>
              <h3 className="nx-h3">{s.title}</h3>
              <p className="nx-body">{s.body}</p>
            </li>
          ))}
        </ol>
        <div id="tools" className="nx-tools-block">
          <h3 id="tools-title" className="nx-h3">
            {t.site.toolStrip.title}
          </h3>
          <ToolStrip title={t.site.toolStrip.title} tools={st.tools.map((x) => ({ id: x.id, title: x.title, body: x.body }))} priced={st.priced} free={st.free} />
        </div>
      </div>
    </section>
  );
}

/** The hands-on example, under the showcases: type a topic, watch a plan take shape. */
function Try({ t, locale }: { t: Dictionary; locale: Locale }) {
  const c = t.site.try;
  return (
    <section id="try" aria-labelledby="try-title" className="nx-section" data-tone="raised">
      <div className="nx-wrap">
        <p className="nx-label">{c.label}</p>
        <h2 id="try-title" className="nx-h2">
          {c.title}
        </h2>
        <p className="nx-sub">{c.lead}</p>
        <TryDemo copy={c} note={fmt(c.ctaNote, { n: formatCredits(WELCOME_CREDITS, locale) })} />
      </div>
    </section>
  );
}

/** The solutions as full-width rows, each one link. Shared with /solutions. */
export function SolutionRows({ pages }: { pages: Dictionary["site"]["solutions"]["pages"] }) {
  return (
    <ul className="st-sol-list">
      {pages.map((p) =>
        isSolutionId(p.id) ? (
          <li key={p.id}>
            <Link href={solutionHref(p.id)} className="st-sol-row" data-spot>
              <span className="st-kicker">{p.kicker}</span>
              <span className="st-sol-title">{p.title}</span>
              <span className="st-small">{p.lead}</span>
              <span className="st-sol-arrow" aria-hidden>
                <ArrowRight className="size-5" />
              </span>
            </Link>
          </li>
        ) : null,
      )}
    </ul>
  );
}

/** The Google data statement OAuth reviewers read: it sits in the FAQ's left
 *  column, under the questions' title, rather than as a section of its own. */
function GoogleData({ t }: { t: Dictionary }) {
  const d = t.landing.data;
  return (
    <aside id="google-data" aria-labelledby="data-title" className="nx-data">
      <div className="flex items-start gap-4">
        <span className="nx-data-icon">
          <Lock className="size-5" aria-hidden />
        </span>
        <h2 id="data-title" className="nx-h3 pt-2">
          {d.title}
        </h2>
      </div>
      <p className="nx-body mt-4">{d.body}</p>
      <div className="mt-3 flex flex-wrap gap-x-6">
        <Link href="/privacy" className="nx-link">
          {d.privacy}
        </Link>
        <a href={GOOGLE_PERMISSIONS} target="_blank" rel="noopener noreferrer" className="nx-link">
          {d.revoke}
          <ArrowUpRight aria-hidden />
        </a>
      </div>
    </aside>
  );
}

function FinalCta({ t }: { t: Dictionary }) {
  const f = t.site.final;
  return (
    <section aria-labelledby="final-title" className="nx-final-wrap">
      <div className="nx-wrap">
        <div className="nx-final">
          <h2 id="final-title" className="nx-h2">
            {f.title}
          </h2>
          <p className="nx-sub">{f.lead}</p>
          <div className="nx-actions">
            <Link href="/signup" className="nx-btn">
              {f.cta}
              <ArrowRight aria-hidden />
            </Link>
            <Link href="/pricing" className="nx-link">
              {t.site.hero.secondary}
            </Link>
            <Link href="/solutions" className="nx-link">
              {t.site.nav.solutions}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
