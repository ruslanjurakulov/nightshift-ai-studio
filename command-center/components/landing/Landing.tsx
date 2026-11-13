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
import { ShowcaseGallery, showcaseItems, type LandingFormat } from "@/components/site/ShowcaseGallery";
import { TryDemo } from "@/components/landing/TryDemo";
import { PriceBlock } from "@/components/landing/PriceBlock";
import { CapabilityWall } from "@/components/landing/CapabilityWall";
import { MotionToggle } from "@/components/site/MotionToggle";
import { StickyCta } from "@/components/site/StickyCta";
import { LANDING_SLOTS, slotJobs, slotMedia } from "@/components/site/samples";
import { AiCredit, PlaceFill, placeBox } from "@/components/site/PlaceFill";
import { placeTry } from "@/components/site/place-try";
import { PromptBar, type PromptIdea } from "@/components/landing/PromptBar";
import { ArtSlotImg, slotArt } from "@/components/site/art";
import { creditLine } from "@/lib/site/media";
import { FORMATS } from "@/lib/site/formats";
import { PROMPT_TOOLS, type PromptTool } from "@/lib/site/prompt-link";
import { SHOWCASE_ENTRIES, modelLeftOut, showcaseModels, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { priceRatesFrom } from "@/lib/site/price-check";
import { Showcase } from "@/components/landing/Showcase";
import { Faq } from "@/components/landing/Faq";
import { ModelMarquee } from "@/components/site/motion/ModelMarquee";

const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

/**
 * The signed-out homepage, laid out as an AI studio's (round 10): the first
 * screen is the hero slot's picture edge to edge with the headline and a prompt
 * bar over it; then three facts the page can count, the explore grid of our own
 * generations, the models behind them, two full-width showcases, how it works
 * (three steps and the idea in one card), a hands-on example that needs no
 * account and no server, what it costs, the questions and the button again over
 * the closing slot's picture.
 *
 * Every claim on it is one the code backs; the only figures are the welcome
 * grant (WELCOME_CREDITS, pinned to the database by a test), counts of what the
 * page itself holds, and whatever the pricing source holds. No competitor is
 * named, a model only inside its own sample's box, and there are no
 * testimonials, logos or usage numbers, because there are none to show. Every
 * picture says what it is: one of our samples (AI-generated, its model) or a
 * stock example (its contributor), from components/site/samples.tsx slotMedia.
 *
 * A Server Component. The client code on the page is the header's menu and its
 * theme and language keys, the prompt bar, the pause switches, the clips, the
 * example, the price slider, the start bar and the effects script.
 */
export function Landing({
  t,
  locale,
  pricing,
  anchor,
  showcase,
  expiry = packExpiry(null, CREDIT_EXPIRY_MONTHS),
  dodo = false,
}: {
  t: Dictionary;
  locale: Locale;
  pricing: PricingTeaserData;
  /** The money a visitor can know before signing up (lib/landing.ts moneyAnchor). */
  anchor: MoneyAnchor;
  showcase: ShowcaseItem[];
  /** How long top-up credits last (lib/plans.ts packExpiry): the catalog's policy, the env, or unknown. */
  expiry?: PackExpiry;
  /** Dodo Payments sells here (PAYMENTS_PROVIDER=dodo): the FAQ names it as the seller. */
  dodo?: boolean;
}) {
  // The samples the landing's own slots show are left out of its gallery, so no clip is on the page twice.
  const inSlots = slotJobs(LANDING_SLOTS);
  const gallery = showcaseItems().filter(({ e }) => !inSlots.includes(e.jobId));
  const onPage = [...gallery.map(({ e }) => e), ...SHOWCASE_ENTRIES.filter((e) => inSlots.includes(e.jobId))];
  const formats = formatsFor(t);
  return (
    <div className="lp-root">
      <Hero t={t} locale={locale} anchor={anchor} formats={formats} />
      <Facts t={t} locale={locale} entries={onPage} />
      {/* Real generations from the operator's Studio (lib/site/showcase.json): nothing at all until the first one is merged. The landing is signed out. */}
      <ShowcaseGallery t={t} locale={locale} exclude={inSlots} formats={formats} />
      <ModelMarquee entries={gallery.map(({ e }) => e)} pause={t.site.fx.pause} />
      <ModelTiles t={t} items={gallery} />
      <Showcases t={t} />
      <How t={t} />
      {showcase.length > 0 && (
        <div className="st-section">
          <div className="st-wrap">
            <Showcase t={t} items={showcase} hour="02:00" />
          </div>
        </div>
      )}
      <Try t={t} locale={locale} />
      <PriceBlock t={t} locale={locale} teaser={pricing} rates={priceRatesFrom(anchor)} />
      <Faq t={t} plansOnSale={pricing.kind === "plans"} expiry={expiry} aside={<GoogleData t={t} />} dodo={dodo} />
      <FinalCta t={t} />
      <StickyCta label={t.site.bar.label} text={t.site.bar.text} cta={t.site.bar.cta} dismiss={t.site.bar.dismiss} />
    </div>
  );
}

/** The formats the landing shows (lib/site/formats.ts): those whose sample is merged, with their words in this language. */
function formatsFor(t: Dictionary): LandingFormat[] {
  return FORMATS.flatMap((f) => {
    const entry = SHOWCASE_ENTRIES.find((e) => e.jobId === f.job);
    const copy = t.site.formats.items.find((i) => i.id === f.id);
    return entry && copy && SHOWCASE_FILES[entry.jobId] ? [{ id: f.id, job: f.job, title: copy.title, body: copy.body, entry }] : [];
  });
}

/**
 * The first screen, as an AI studio's is: the hero slot's picture edge to edge (one of our generations once its job is merged,
 * labelled with its model and "Try this prompt"; until then the stock fallback, labelled stock), under a veil that keeps the words
 * at 4.5:1; the promise, the prompt bar (it only opens the Studio form) with real prompts to start from, the button, and the
 * three promises. The picture is the page's LCP: eager, high priority, its clip started only after load and idle.
 */
function Hero({ t, locale, anchor, formats }: { t: Dictionary; locale: Locale; anchor: MoneyAnchor; formats: LandingFormat[] }) {
  const h = t.site.hero;
  const a = t.site.anchor;
  const m = slotMedia("hero");
  const moving = m.kind === "ai" ? m.moving : m.clip !== null;
  // The one price a visitor can know before signing up, said above the fold, and
  // only when the live price list says it: never a default, never a zero.
  const price = anchor.site
    ? `${a.siteLabel}: ${fmt(a.siteValue, { n: formatCredits(anchor.site.perMinute, locale), unit: creditUnit(anchor.site.perMinute, locale, t.shell.creditUnit) })}`
    : null;
  const ideas: PromptIdea[] = formats.flatMap(({ id, title, entry }) =>
    (PROMPT_TOOLS as readonly string[]).includes(entry.capability) && entry.prompt.trim() ? [{ id, label: title, tool: entry.capability as PromptTool, prompt: entry.prompt }] : [],
  );
  return (
    <section aria-labelledby="hero-title" className="nx-hero nx-sh">
      <div className="nx-sh-media" {...placeBox(m)}>
        <PlaceFill media={m} s={t.site} eager early labels={false} sizes="100vw" />
      </div>
      <div className="nx-wrap nx-sh-in">
        <p className="nx-pill">
          <span aria-hidden className="nx-pill-dot" />
          {h.kicker}
        </p>
        <h1 id="hero-title" className="nx-h1 nx-sh-h1">
          {h.titleA} <span className="nx-h1-b">{h.titleB}</span>
        </h1>
        <p className="nx-sh-lead">{h.lead}</p>
        <PromptBar copy={t.site.prompt} ideas={ideas} />
        <div className="nx-sh-actions">
          <Link href="/signup" className="nx-btn">
            {h.cta}
            <ArrowRight aria-hidden />
          </Link>
          <Link href="/pricing" className="nx-link">
            {h.secondary}
          </Link>
          {/* Not a second button: it jumps to the plan demo below, which shows a plan and creates nothing. */}
          <a href="#try" className="nx-sample">
            <span className="nx-sample-label">{h.demo}</span>
            <span className="nx-sample-note">{h.demoNote}</span>
          </a>
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
      <div className="nx-wrap nx-sh-foot">
        {/* What the picture behind the words is, on it: our sample's model and credit, or the stock contributor's. */}
        {m.kind === "ai" ? (
          <p className="nx-sh-credit" {...placeBox({ ...m, moving: false })}>
            <AiCredit entry={m.entry} g={t.site.gallery} href={placeTry(m)} scope="hero" />
          </p>
        ) : (
          <p className="nx-sh-credit" data-media="stock">
            <span className="nx-result-badge" data-kind="still">
              {m.footage ? t.site.samples.frameTag : t.site.samples.tag}
            </span>
            {m.clip && (
              <span className="nx-result-badge" data-kind="clip">
                {t.site.samples.clipTag}
              </span>
            )}
            <span className="nx-result-credit">{creditLine(m.id, t.site.samples.credit)}</span>
          </p>
        )}
        {moving && <MotionToggle pause={t.site.fx.pause} />}
      </div>
    </section>
  );
}

/** Three facts counted from what the page holds (the samples on it, the models that made them) and the welcome grant; a count of zero is left out, never shown as a claim. */
function Facts({ t, locale, entries }: { t: Dictionary; locale: Locale; entries: readonly ShowcaseEntry[] }) {
  const f = t.site.facts;
  const items = [
    { id: "samples", n: entries.length, label: f.samples },
    { id: "models", n: showcaseModels(entries).length, label: f.models },
    { id: "credits", n: WELCOME_CREDITS, label: f.credits },
  ].filter((i) => i.n > 0);
  return (
    <section aria-label={f.label} className="nx-facts">
      <ul className="nx-wrap nx-facts-list">
        {items.map((i) => (
          <li key={i.id} data-fact={i.id}>
            {/* data-count: the count-up's target (components/site/motion/attach.ts); the text stays the server's number. */}
            <span className="nx-facts-n" data-count={i.n}>
              {formatCredits(i.n, locale)}
            </span>
            <span className="nx-facts-l">{i.label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The models behind the samples: one tile per model, each inside the box of that model's first sample on the page (the only kind
 * of element that may name a model), with its maker's credit, how many of the page's samples it made, whether the Studio offers
 * it (an operator preview says it does not yet), and a link down to its sample. No price: the site has no public per-model price
 * to read, and a typed one would be a promise (CLAUDE.md #5).
 */
function ModelTiles({ t, items }: { t: Dictionary; items: { e: ShowcaseEntry; f: ShowcaseFiles }[] }) {
  const c = t.site.models;
  const g = t.site.gallery;
  const byModel = new Map<string, { e: ShowcaseEntry; f: ShowcaseFiles; n: number }>();
  for (const it of items) {
    const had = byModel.get(it.e.modelId);
    if (had) had.n += 1;
    else byModel.set(it.e.modelId, { ...it, n: 1 });
  }
  if (byModel.size === 0) return null;
  return (
    <section id="models" aria-labelledby="models-title" className="nx-section nx-models" data-tone="raised">
      <div className="nx-wrap">
        <p className="nx-label">{c.label}</p>
        <h2 id="models-title" className="nx-h2">
          {c.title}
        </h2>
        <p className="nx-sub">{c.lead}</p>
        <ul className="nx-models-grid">
          {[...byModel.values()].map(({ e, f, n }) => {
            const leftOut = modelLeftOut(e);
            return (
              <li key={e.modelId} className="nx-model" data-showcase-entry={e.jobId} data-model={e.modelId} data-spot>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={f.posterSm} width={e.width} height={e.height} alt="" className="nx-model-pic" loading="lazy" decoding="async" />
                <div className="nx-model-body">
                  <span className="nx-ai-badge">{g.badge}</span>
                  <h3 className="nx-model-name">{e.modelName}</h3>
                  {e.attribution && (
                    <a href={e.attribution.url} target="_blank" rel="noopener noreferrer" className="nx-ai-attr">
                      {e.attribution.text}
                    </a>
                  )}
                  <p className="nx-model-count">{fmt(c.count, { n: String(n) })}</p>
                  {leftOut && <p className="nx-gallery-unavailable">{leftOut === "shut_down" ? g.gone : g.notInStudio}</p>}
                  <a href={`#sample-${e.jobId}`} className="nx-model-see">
                    {c.see}
                    <ArrowRight aria-hidden />
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/** Three steps in a strip: a numeral, a title, a sentence (the last one is the person's own press), and under them what Nightshift can make, as a wall of eight icon tiles, one per tool. */
function How({ t }: { t: Dictionary }) {
  const h = t.site.how.simple;
  return (
    <section id="how" aria-labelledby="how-title" className="nx-section" data-tone="raised">
      <div className="nx-wrap">
        <h2 id="how-title" className="nx-h2">
          {h.title}
        </h2>
        <ol className="nx-strip" aria-label={t.site.how.slug}>
          {h.steps.map((s, i) => {
            // An optional picture above the numeral (components/site/art.tsx SLOT_ART): none is configured today, so the step is text.
            const art = slotArt("step", s.id);
            return (
              <li key={s.id} className="nx-strip-step">
                {art && <ArtSlotImg slot={art} alt={t.site.art.alts[art.altKey]} className="nx-strip-pic" />}
                <span className="nx-strip-no" aria-hidden>
                  {i + 1}
                </span>
                <h3 className="nx-h3">{s.title}</h3>
                <p className="nx-body">{s.body}</p>
              </li>
            );
          })}
        </ol>
        {/* The idea in one card (ask, plan, wait for approval), with no picture: the first screen already shows one. */}
        <div className="nx-how-chat">
          <ChatCard copy={chatCopy(t, "hero", undefined, { note: t.site.stage.bareNote })} bare />
        </div>
        <CapabilityWall t={t} />
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
        <TryDemo copy={c} art={t.site.art.alts} note={fmt(c.ctaNote, { n: formatCredits(WELCOME_CREDITS, locale) })} />
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
  const m = slotMedia("landing.final");
  return (
    <section aria-labelledby="final-title" className="nx-final-wrap">
      <div className="nx-wrap">
        <div className="nx-final" {...placeBox(m)}>
          {/* The slot's picture (or its loop) behind the closing words: decorative, so no description; what it is is printed on it. */}
          <PlaceFill media={m} s={t.site} alt="" className="nx-final-pic" labels={false} sizes="(min-width: 1240px) 1160px, 100vw" />
          {m.kind === "ai" ? (
            <AiCredit entry={m.entry} g={t.site.gallery} href={placeTry(m)} scope="final" className="nx-ai-credit nx-final-credit" />
          ) : (
            <span className="nx-final-credit">{creditLine(m.id, t.site.samples.credit)}</span>
          )}
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
