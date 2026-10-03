import Link from "next/link";
import { ArrowRight, ArrowUpRight, Clapperboard, Film, Lock, Maximize2, Mic, Palette, Scissors, SlidersHorizontal, Sparkles, Wand2, ImageIcon, type LucideIcon } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import type { MoneyAnchor, PricingTeaser as PricingTeaserData, ShowcaseItem } from "@/lib/landing";
import { WELCOME_CREDITS } from "@/lib/pricing";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";
import { packExpiry, type PackExpiry } from "@/lib/plans";
import { creditUnit, formatCredits } from "@/lib/credits";
import { isSolutionId, solutionHref } from "@/lib/solutions";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { PressStage } from "@/components/landing/PressStage";
import { EditorPicture } from "@/components/site/EditorPicture";
import { Showcase } from "@/components/landing/Showcase";
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
 * states), how does it work (three steps and the real approval screen), who is
 * it for, what else is in the box (the Studio), which languages, what can I
 * count on, what does it cost, what are the catches (the FAQ), and the
 * button again.
 *
 * Every claim on it is one the code backs; the only figures are the welcome
 * grant (WELCOME_CREDITS, pinned to the database by a test) and whatever the
 * pricing source holds. No competitor and no AI provider is named, and there
 * are no testimonials, logos or usage numbers, because there are none to show.
 *
 * A Server Component. The only client code on the page is the header's menu
 * and its theme and language keys, and the hero's four-state picture.
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
      <How t={t} locale={locale} />
      <Who t={t} />
      <Studio t={t} />
      {showcase.length > 0 && (
        <div className="st-section">
          <div className="st-wrap">
            <Showcase t={t} items={showcase} hour="02:00" />
          </div>
        </div>
      )}
      <Languages t={t} locale={locale} />
      <Rules t={t} />
      <PricingTeaser t={t} locale={locale} teaser={pricing} anchor={anchor} expiry={expiry} />
      <Faq t={t} plansOnSale={pricing.kind === "plans"} expiry={expiry} aside={<GoogleData t={t} />} />
      <FinalCta t={t} />
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
      <div className="nx-wrap">
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
        <PressStage stage={t.site.stage} />
      </div>
    </section>
  );
}

function How({ t, locale }: { t: Dictionary; locale: Locale }) {
  const h = t.site.how;
  const shot = REVIEW_SHOTS[locale] ?? REVIEW_SHOTS.en;
  return (
    <section id="how" aria-labelledby="how-title" className="nx-section" data-tone="raised">
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

const WHO_ICON: Record<string, LucideIcon> = { "youtube-channels": Film, "creative-studio": Palette, developers: Sparkles };

function Who({ t }: { t: Dictionary }) {
  const w = t.site.who;
  return (
    <section id="solutions" aria-labelledby="who-title" className="nx-section">
      <div className="nx-wrap">
        <h2 id="who-title" className="nx-h2">
          {w.title}
        </h2>
        <p className="nx-sub">{w.lead}</p>
        <ul className="nx-tiles">
          {w.items.map((item) => {
            const Icon = WHO_ICON[item.id] ?? Film;
            return (
              <li key={item.id}>
                {isSolutionId(item.id) && (
                  <Link href={solutionHref(item.id)} className="nx-tile">
                    <span className="nx-tile-icon" aria-hidden>
                      <Icon />
                    </span>
                    <span className="nx-tile-title">{item.title}</span>
                    <span className="nx-tile-body">{item.body}</span>
                    <span className="nx-tile-go" aria-hidden>
                      <ArrowRight />
                    </span>
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
        <Link href="/solutions" className="nx-link mt-6">
          {w.more}
          <ArrowRight aria-hidden />
        </Link>
      </div>
    </section>
  );
}

const TOOL_ICON: Record<string, LucideIcon> = {
  image: ImageIcon,
  video: Clapperboard,
  voice: Mic,
  edit: Wand2,
  animate: Film,
  upscale: Maximize2,
  cutout: Scissors,
  styles: Palette,
  editor: SlidersHorizontal,
};

function Studio({ t }: { t: Dictionary }) {
  const s = t.site.studio;
  return (
    <section id="studio" aria-labelledby="studio-title" className="nx-section" data-tone="raised">
      <div className="nx-wrap">
        <h2 id="studio-title" className="nx-h2">
          {s.title}
        </h2>
        <p className="nx-sub">{s.lead}</p>
        <div className="nx-studio">
          <ol className="nx-tools" aria-label={s.slug}>
            {s.tools.map((tool) => {
              const Icon = TOOL_ICON[tool.id] ?? Sparkles;
              // The editor and the style library spend nothing; every other
              // tool is a generation, priced on its button before it runs.
              const free = tool.id === "editor" || tool.id === "styles";
              return (
                <li key={tool.id} className="nx-tool">
                  <span className="nx-tool-icon" aria-hidden>
                    <Icon />
                  </span>
                  <h3 className="nx-tool-name">{tool.title}</h3>
                  <p className="nx-tool-body">{tool.body}</p>
                  {/* Priced is the rule (the lead says so), so only the exceptions
                      are marked on screen; a screen reader hears it on every row. */}
                  {free ? <span className="nx-tool-free st-patch-cost">{s.free}</span> : <span className="sr-only">{s.priced}</span>}
                </li>
              );
            })}
          </ol>
          <div className="nx-studio-pic">
            <EditorPicture t={t} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Languages({ t, locale }: { t: Dictionary; locale: Locale }) {
  const d = t.site.desk;
  const codes = ["uz", "ru", "en"] as const;
  return (
    <section id="channels" aria-labelledby="desk-title" className="nx-section">
      <div className="nx-wrap nx-langs">
        <h2 id="desk-title" className="nx-h2">
          {d.title}
        </h2>
        <ul className="nx-lang-list" aria-label={d.slug}>
          {d.languages.map((l, i) => (
            // The page's own language reads in full ink, the other two dimmed.
            <li key={l} lang={codes[i]} aria-current={codes[i] === locale ? "true" : undefined}>
              {l}
            </li>
          ))}
        </ul>
        <p className="nx-sub">{d.lead}</p>
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
            <li key={item.id} className="nx-rule">
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
            <Link href={solutionHref(p.id)} className="st-sol-row">
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
          </div>
        </div>
      </div>
    </section>
  );
}
