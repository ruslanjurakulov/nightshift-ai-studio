import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, Lock } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import type { MoneyAnchor, PricingTeaser as PricingTeaserData, ShowcaseItem } from "@/lib/landing";
import { WELCOME_CREDITS } from "@/lib/pricing";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";
import { packExpiry, type PackExpiry } from "@/lib/plans";
import { creditUnit, formatCredits } from "@/lib/credits";
import { isSolutionId, solutionHref } from "@/lib/solutions";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { PressStage } from "@/components/landing/PressStage";
import { TryDemo } from "@/components/landing/TryDemo";
import { WhoTabs, type WhoSolutions } from "@/components/landing/WhoTabs";
import { Compare } from "@/components/landing/Compare";
import { PriceCheck } from "@/components/landing/PriceCheck";
import { HeroFx } from "@/components/site/HeroFx";
import { MotionToggle } from "@/components/site/MotionToggle";
import { StickyCta } from "@/components/site/StickyCta";
import { priceRatesFrom } from "@/lib/site/price-check";
import { Showcase } from "@/components/landing/Showcase";
import { Capabilities } from "@/components/landing/Capabilities";
import { PricingTeaser } from "@/components/landing/PricingTeaser";
import { Faq } from "@/components/landing/Faq";
import reviewEnLight from "@/components/site/shots/review-en-light.webp";
import reviewEnDark from "@/components/site/shots/review-en-dark.webp";
import reviewRuLight from "@/components/site/shots/review-ru-light.webp";
import reviewRuDark from "@/components/site/shots/review-ru-dark.webp";
import reviewUzLight from "@/components/site/shots/review-uz-light.webp";
import reviewUzDark from "@/components/site/shots/review-uz-dark.webp";
import reviewEnLightPhone from "@/components/site/shots/review-en-light-phone.webp";
import reviewEnDarkPhone from "@/components/site/shots/review-en-dark-phone.webp";
import reviewRuLightPhone from "@/components/site/shots/review-ru-light-phone.webp";
import reviewRuDarkPhone from "@/components/site/shots/review-ru-dark-phone.webp";
import reviewUzLightPhone from "@/components/site/shots/review-uz-light-phone.webp";
import reviewUzDarkPhone from "@/components/site/shots/review-uz-dark-phone.webp";

type Shot = { src: string; width: number; height: number };
/** The video page of the real Command Center with a finished video waiting
 *  for approval — signed in, every value sample data — in each language: the
 *  desktop page, and the same panel as a phone shows it (a 1600px screen
 *  shrunk to a phone's width was unreadable). */
const REVIEW_SHOTS: Record<Locale, Record<"light" | "dark", { desk: Shot; phone: Shot }>> = {
  en: { light: { desk: reviewEnLight, phone: reviewEnLightPhone }, dark: { desk: reviewEnDark, phone: reviewEnDarkPhone } },
  ru: { light: { desk: reviewRuLight, phone: reviewRuLightPhone }, dark: { desk: reviewRuDark, phone: reviewRuDarkPhone } },
  uz: { light: { desk: reviewUzLight, phone: reviewUzLightPhone }, dark: { desk: reviewUzDark, phone: reviewUzDarkPhone } },
};

const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

/** Each rule's state, as the app would show it on its lamp. */
const RULE_TONE: Record<string, LampTone> = { price: "ok", refund: "ok", approval: "run" };

/**
 * The signed-out homepage. One idea per section, in the order a visitor asks
 * the questions: what is this (the hero, with the product drawn in four
 * states), can I try it (a hands-on example that needs no account and no
 * server), how does it work (three steps and the real approval screen), what
 * does it make, who is it for (tabs), what stays in my hands, what do I save
 * by not doing it by hand, what will my video cost (a price check from the
 * published rate), what does it cost in general, what are the catches (the
 * FAQ), and the button again.
 *
 * Every claim on it is one the code backs; the only figures are the welcome
 * grant (WELCOME_CREDITS, pinned to the database by a test) and whatever the
 * pricing source holds. No competitor and no AI provider is named, and there
 * are no testimonials, logos or usage numbers, because there are none to show.
 * The pictures are labelled examples (docs/design/SITE_ENGAGE.md).
 *
 * A Server Component. The client code on the page is the header's menu and its
 * theme and language keys, the hero's four-state picture and pause switch, the
 * example, the tabs, the price slider, the start bar and the effects script.
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
  const rates = priceRatesFrom(anchor);
  return (
    <div className="lp-root">
      <Hero t={t} locale={locale} anchor={anchor} />
      <Try t={t} locale={locale} />
      <How t={t} locale={locale} />
      <Capabilities t={t} />
      <Who t={t} />
      {showcase.length > 0 && (
        <div className="st-section">
          <div className="st-wrap">
            <Showcase t={t} items={showcase} hour="02:00" />
          </div>
        </div>
      )}
      <Rules t={t} />
      <Compare t={t} />
      {rates && (
        <section id="price-check" aria-labelledby="calc-title" className="nx-section" data-tone="raised">
          <div className="nx-wrap nx-calc-wrap">
            <div className="nx-calc-words">
              <p className="nx-label">{t.site.calc.slug}</p>
              <h2 id="calc-title" className="nx-h2">
                {t.site.calc.title}
              </h2>
              <p className="nx-sub">{t.site.calc.lead}</p>
            </div>
            <PriceCheck t={t} locale={locale} rates={rates} welcome={WELCOME_CREDITS} />
          </div>
        </section>
      )}
      <PricingTeaser t={t} locale={locale} teaser={pricing} anchor={anchor} expiry={expiry} />
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
      <div className="nx-wrap nx-hero-in">
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
        {/* The three things a visitor most wants settled, each already a promise lower on the page. */}
        <ul className="nx-trust" aria-label={t.site.rules.slug}>
          {t.site.rules.items.map((item) => (
            <li key={item.id}>
              <Check aria-hidden />
              {item.title}
            </li>
          ))}
        </ul>
        <PressStage stage={t.site.stage} note={t.site.samples.note} />
        <MotionToggle pause={t.site.fx.pause} play={t.site.fx.play} />
      </div>
    </section>
  );
}

/** The hands-on example, right under the first screen: type a topic, watch a plan take shape. */
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

function How({ t, locale }: { t: Dictionary; locale: Locale }) {
  const h = t.site.how;
  const shot = REVIEW_SHOTS[locale] ?? REVIEW_SHOTS.en;
  return (
    <section id="how" aria-labelledby="how-title" className="nx-section">
      <div className="nx-wrap nx-how">
        <div className="nx-how-words">
          <h2 id="how-title" className="nx-h2">
            {h.simple.title}
          </h2>
          <p className="nx-sub">{h.simple.lead}</p>
          <ol className="nx-steps" aria-label={h.slug}>
            {h.simple.steps.map((s, i) => (
              <li key={s.id} className="nx-step">
                <span className="nx-step-no" aria-hidden>
                  {i + 1}
                </span>
                <div>
                  <h3 className="nx-h3">{s.title}</h3>
                  <p className="nx-body">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="nx-how-shot">
          <p className="nx-kicker">{h.shotTitle}</p>
          <ReviewShot t={t} shot={shot} />
        </div>
      </div>
    </section>
  );
}

/** The real page, photographed: light and dark, desktop and phone are
 *  separate captures; only the one matching the theme and the width is shown
 *  (the others, lazy and display:none, are never fetched). Served from
 *  /_next/static like any build asset. */
function ReviewShot({ t, shot }: { t: Dictionary; shot: (typeof REVIEW_SHOTS)[Locale] }) {
  const h = t.site.how;
  return (
    <figure className="st-shot">
      {(["light", "dark"] as const).flatMap((theme) =>
        (["desk", "phone"] as const).map((size) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${theme}-${size}`}
            src={shot[theme][size].src}
            width={shot[theme][size].width}
            height={shot[theme][size].height}
            alt={h.shotAlt}
            loading="lazy"
            decoding="async"
            data-shot-theme={theme}
            data-shot-size={size}
          />
        )),
      )}
      <figcaption>
        <span className="st-tag">{h.shotTag}</span>
        {h.shotCaption}
      </figcaption>
    </figure>
  );
}

/** Only the lines the tabs print (never the whole page copy): a client component's props travel in the page's HTML. */
function whoSolutions(t: Dictionary): WhoSolutions {
  const s = t.site.solutions;
  return {
    open: s.open,
    startLabel: s.startLabel,
    notLabel: s.notLabel,
    pages: s.pages.map((p) => ({ id: p.id, kicker: p.kicker, title: p.title, lead: p.lead, start: p.start, not: p.not.slice(0, 1) })),
  };
}

function Who({ t }: { t: Dictionary }) {
  const w = t.site.who;
  return (
    <section id="solutions" aria-labelledby="who-title" className="nx-section">
      <div className="nx-wrap">
        <h2 id="who-title" className="nx-h2">
          {w.title}
        </h2>
        <p className="nx-sub">{w.lead}</p>
        <WhoTabs who={w} solutions={whoSolutions(t)} />
        <Link href="/solutions" className="nx-link mt-6">
          {w.more}
          <ArrowRight aria-hidden />
        </Link>
      </div>
    </section>
  );
}

/** Each rule's state, as the app would show it on its lamp. */
function Rules({ t }: { t: Dictionary }) {
  const r = t.site.rules;
  return (
    <section id="rules" aria-labelledby="rules-title" className="nx-section" data-tone="raised">
      <div className="nx-wrap">
        <h2 id="rules-title" className="nx-h2">
          {r.title}
        </h2>
        <ul className="nx-rules">
          {r.items.map((item) => (
            <li key={item.id} className="nx-rule" data-spot>
              <StatusLamp tone={RULE_TONE[item.id] ?? "ok"} label={item.state} />
              <h3 className="nx-h3">{item.title}</h3>
              <p className="nx-body">{item.body}</p>
              <ol className="st-ledger" aria-label={item.title}>
                {item.lines.map((line, i) => {
                  const last = i === item.lines.length - 1;
                  // The refund ledger's middle line is the failure itself.
                  const tone: LampTone = item.id === "refund" && i === 1 ? "fail" : last && item.id === "approval" ? "run" : "ok";
                  return (
                    <li key={line}>
                      <span aria-hidden className="ns-lamp" data-tone={tone} />
                      {line}
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ul>
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
            <Link href="#try" className="nx-link">
              {f.try}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
