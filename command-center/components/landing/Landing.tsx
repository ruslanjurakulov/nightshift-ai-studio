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
import { EffectsGallery } from "@/components/site/EffectsGallery";
import { TryDemo } from "@/components/landing/TryDemo";
import { PriceBlock } from "@/components/landing/PriceBlock";
import { CapabilityWall } from "@/components/landing/CapabilityWall";
import { MotionToggle } from "@/components/site/MotionToggle";
import { StickyCta } from "@/components/site/StickyCta";
import { landingExcludedJobs, landingPlacedJobs, slotMedia } from "@/components/site/samples";
import { AiBadge, PlaceFill, placeBox } from "@/components/site/PlaceFill";
import { PromptBar, type PromptIdea } from "@/components/landing/PromptBar";
import { creditLine } from "@/lib/site/media";
import { FORMATS } from "@/lib/site/formats";
import { STEP_PHONE_JOB, studioToolsOpen } from "@/lib/site/tool-samples";
import { TypedText } from "@/components/site/TypedText";
import { PROMPT_TOOLS, type PromptTool } from "@/lib/site/prompt-link";
import { SHOWCASE_ENTRIES, modelLeftOut, showcaseModels, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { priceRatesFrom } from "@/lib/site/price-check";
import { Showcase } from "@/components/landing/Showcase";
import { Faq } from "@/components/landing/Faq";
import { ModelMarquee } from "@/components/site/motion/ModelMarquee";
import { AutopilotDemo } from "@/components/site/AutopilotDemo";
import { SampleCarousel, SampleCompare, SampleTicker } from "@/components/site/landing-samples";
import "@/components/site/explore-hover.css";

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
 * picture says what it is: one of our samples (AI-generated; its model on its gallery card) or a
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
  // The samples the landing's own places show (slots, tool wall, steps, approval screen) are left out of its gallery, so no clip
  // is on the page twice, and so are the repeated sea and sky samples: one list (components/site/slots.ts landingExcludedJobs).
  const inSlots = landingPlacedJobs();
  const leftOut = landingExcludedJobs();
  const gallery = showcaseItems().filter(({ e }) => !leftOut.includes(e.jobId));
  // Everything on the page that is one of our samples: the gallery's, then the slots' (each with its files). The facts count
  // these and the model tiles are built from these, so a tile's count and the facts can never disagree.
  const onPage = [...gallery, ...showcaseItems().filter(({ e }) => inSlots.includes(e.jobId))];
  const formats = formatsFor(t);
  return (
    <div className="lp-root">
      <Hero t={t} formats={formats} />
      <SampleTicker t={t} locale={locale} exclude={leftOut} />
      <Facts t={t} locale={locale} anchor={anchor} entries={onPage.map(({ e }) => e)} />
      <SampleCarousel t={t} locale={locale} exclude={leftOut} />
      {/* Real generations from the operator's Studio (lib/site/showcase.json): nothing at all until the first one is merged. The landing is signed out. */}
      <ShowcaseGallery t={t} locale={locale} exclude={leftOut} formats={formats} />
      {/* Named one-press shots that open the Studio's video form (lib/effects/catalog.ts); it names no model. */}
      <EffectsGallery t={t} />
      <ModelMarquee entries={onPage.map(({ e }) => e)} pause={t.site.fx.pause} />
      <ModelTiles t={t} items={onPage} />
      <SampleCompare t={t} locale={locale} exclude={leftOut} />
      <Showcases t={t} />
      <How t={t} locale={locale} anchor={anchor} />
      <AutopilotDemo copy={t.site.autopilot.demo} />
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
 * The first screen, lean as an AI studio's is: the hero slot's picture edge to edge (one of our generations once its job is
 * merged, labelled AI-generated; until then the stock fallback, labelled stock), under a veil that keeps the words at 4.5:1;
 * the headline, one sentence, the prompt bar (it only opens the Studio form) with real prompts to start from, one primary and
 * one secondary action. The welcome grant, the price and the three promises are just under it (Facts). The picture is the
 * page's LCP: eager, high priority, its clip started only after load and idle.
 */
function Hero({ t, formats }: { t: Dictionary; formats: LandingFormat[] }) {
  const h = t.site.hero;
  const m = slotMedia("hero");
  const moving = m.kind === "ai" ? m.moving : m.clip !== null;
  const ideas: PromptIdea[] = formats.flatMap(({ id, title, entry }) =>
    (PROMPT_TOOLS as readonly string[]).includes(entry.capability) && entry.prompt.trim() ? [{ id, label: title, tool: entry.capability as PromptTool, prompt: entry.prompt }] : [],
  );
  return (
    <section aria-labelledby="hero-title" className="nx-hero nx-sh">
      <div className="nx-sh-media" {...placeBox(m, true)}>
        <PlaceFill media={m} s={t.site} eager early labels={false} sizes="100vw" />
      </div>
      <div className="nx-wrap nx-sh-in">
        <h1 id="hero-title" className="nx-h1 nx-sh-h1">
          {h.titleA} <span className="nx-h1-b">{h.titleB}</span>
        </h1>
        {/* While no Studio model is on sale (lib/site/tool-samples.ts), the sentence offers no picture or clip a visitor can make. */}
        <p className="nx-sh-lead">{studioToolsOpen() ? h.leadShort : h.leadShortClosed}</p>
        {/* Four starting points, one row: the first screen stays lean (the rest of the formats are in the gallery). */}
        <PromptBar copy={t.site.prompt} ideas={ideas.slice(0, 4)} studioOpen={studioToolsOpen()} />
        <div className="nx-sh-actions">
          <Link href="/signup" className="nx-btn">
            {h.cta}
            <ArrowRight aria-hidden />
          </Link>
          {/* The one secondary action, and not a second button: it jumps to the plan demo below, which shows a plan and creates nothing. */}
          <a href="#try" className="nx-sample">
            <span className="nx-sample-label">{h.demo}</span>
            <span className="nx-sample-note">{h.demoNote}</span>
          </a>
        </div>
      </div>
      <div className="nx-wrap nx-sh-foot">
        {/* What the picture behind the words is, on it: our sample's AI-generated badge, or the stock contributor's credit. */}
        {m.kind === "ai" ? (
          <p className="nx-sh-credit" {...placeBox({ ...m, moving: false })}>
            <AiBadge g={t.site.gallery} />
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

/**
 * Just under the first screen: three facts counted from what the page holds (the samples on it, the models that made them) and
 * the welcome grant, a count of zero left out, never shown as a claim; then the welcome grant's terms, the one price a visitor can
 * know before signing up (only when the live price list says it: never a default, never a zero), the three promises the page
 * keeps, and the way to the prices.
 */
function Facts({ t, locale, anchor, entries }: { t: Dictionary; locale: Locale; anchor: MoneyAnchor; entries: readonly ShowcaseEntry[] }) {
  const f = t.site.facts;
  const h = t.site.hero;
  const a = t.site.anchor;
  const price = anchor.site
    ? `${a.siteLabel}: ${fmt(a.siteValue, { n: formatCredits(anchor.site.perMinute, locale), unit: creditUnit(anchor.site.perMinute, locale, t.shell.creditUnit) })}`
    : null;
  const items = [
    { id: "samples", n: entries.length, label: f.samples },
    { id: "models", n: showcaseModels(entries).length, label: f.models },
    { id: "credits", n: WELCOME_CREDITS, label: f.credits },
  ].filter((i) => i.n > 0);
  return (
    <section aria-label={f.label} className="nx-facts">
      <div className="nx-wrap">
        <ul className="nx-facts-list">
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
        <div className="nx-facts-more">
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
          <Link href="/pricing" className="nx-link">
            {h.secondary}
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * The models behind the samples: one tile per model, each inside the box of that model's first sample on the page (the only kind
 * of element that may name a model), with its AI-generated label, how many of the page's samples it made, whether the Studio offers
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
                {/* The model's sample, alive: its loop plays with the grid's rules (LoopClip `together`), a still drifts slowly. */}
                <div className="nx-model-media" data-clip={e.kind === "video" && f.clip ? "sample" : undefined}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={f.posterSm} width={e.width} height={e.height} alt="" className="nx-model-pic nx-drift-pic" loading="lazy" decoding="async" />
                  {e.kind === "video" && f.clip && <ShowcaseClip jobId={e.jobId} together />}
                </div>
                <div className="nx-model-body">
                  <span className="nx-ai-badge">{g.badge}</span>
                  <h3 className="nx-model-name">{e.modelName}</h3>
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
/**
 * The live piece above a step of "How it works", made of the product's own parts and words, never a drawing of a result:
 * 1. the ask, typed as you watch (the chat card's own example ask; reduced motion or the pause switch show it whole);
 * 2. the Generate key as the Studio draws it, with the price beside it only when the live price list holds one, else where it
 *    will appear (never a default or a zero);
 * 3. a phone with one of our vertical samples playing as a channel's video, under "Private on YouTube": an example,
 *    labelled AI-generated (the badge only: the phone illustrates the step, the clip is not its subject), in the sample's own box.
 * The first two are pictures of a control, not controls: hidden from assistive tech (the step's words say it).
 */
function StepLive({ id, t, locale, anchor }: { id: string; t: Dictionary; locale: Locale; anchor: MoneyAnchor }) {
  if (id === "topic") {
    return (
      <div className="nx-step-live" data-step="topic" aria-hidden>
        <span className="nx-step-input">
          <TypedText text={t.site.caps.items[0].bubble} />
        </span>
      </div>
    );
  }
  if (id === "price") {
    const a = t.site.anchor;
    const price = anchor.site ? fmt(a.siteValue, { n: formatCredits(anchor.site.perMinute, locale), unit: creditUnit(anchor.site.perMinute, locale, t.shell.creditUnit) }) : null;
    return (
      <div className="nx-step-live" data-step="price" aria-hidden>
        <span className="nx-step-key">{t.gen.generate}</span>
        <span className="nx-step-price" data-known={price ? "true" : "false"}>
          {price ?? t.site.how.priceLater}
        </span>
      </div>
    );
  }
  const e = SHOWCASE_ENTRIES.find((x) => x.jobId === STEP_PHONE_JOB);
  const f = e ? SHOWCASE_FILES[e.jobId] : undefined;
  const approve = t.site.stage.steps.find((x) => x.id === "approve" && "lamp" in x) as { lamp: string } | undefined;
  if (!e || !f) return null;
  const clip = e.kind === "video" && f.clip !== null;
  return (
    <div className="nx-step-live" data-step="approve" data-showcase-entry={e.jobId} data-model={e.modelId}>
      <span className="nx-step-phone" data-clip={clip ? "sample" : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={f.posterSm} width={e.width} height={e.height} alt={clip ? t.site.gallery.bgClip : t.site.gallery.bgImage} className="nx-step-shot nx-drift-pic" loading="lazy" decoding="async" />
        {clip && <ShowcaseClip jobId={e.jobId} />}
        {approve && <span className="nx-step-private">{approve.lamp}</span>}
      </span>
      <AiBadge g={t.site.gallery} className="nx-ai-credit nx-step-credit" />
    </div>
  );
}

function How({ t, locale, anchor }: { t: Dictionary; locale: Locale; anchor: MoneyAnchor }) {
  const h = t.site.how.simple;
  return (
    <section id="how" aria-labelledby="how-title" className="nx-section" data-tone="raised">
      <div className="nx-wrap">
        <p className="nx-label">{t.site.how.slug}</p>
        <h2 id="how-title" className="nx-h2">
          {h.title}
        </h2>
        <ol className="nx-strip" aria-label={t.site.how.slug}>
          {h.steps.map((s, i) => {
            // A live piece of the product above each step (round 10): the ask being typed, the Generate key with its price, a channel's video waiting private.
            return (
              <li key={s.id} className="nx-strip-step">
                <StepLive id={s.id} t={t} locale={locale} anchor={anchor} />
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
        <div className="nx-final" {...placeBox(m, true)}>
          {/* The slot's picture (or its loop) behind the closing words: decorative, so no description; what it is is printed on it. */}
          <PlaceFill media={m} s={t.site} alt="" className="nx-final-pic" labels={false} sizes="(min-width: 1240px) 1160px, 100vw" />
          {m.kind === "ai" ? (
            <AiBadge g={t.site.gallery} className="nx-ai-credit nx-final-credit" />
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
