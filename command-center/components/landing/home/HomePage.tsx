import Link from "next/link";
import { ArrowRight, Download, Lightbulb, ShieldCheck, Sparkles } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n/core";
import type { PricingTeaser } from "@/lib/landing";
import type { PriceRates } from "@/lib/site/price-check";
import type { PublicModel } from "@/lib/public-models";
import { buttonClass } from "@/components/ds/button-class";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { ClipPause } from "@/components/site/ClipPause";
import { PriceBlock } from "@/components/landing/PriceBlock";
import { Faq } from "@/components/landing/Faq";
import { GoogleData } from "@/components/landing/Landing";
import { AutopilotDemo } from "@/components/site/AutopilotDemo";
import type { PackExpiry } from "@/lib/plans";
import { PIECE_SIZE, studioPieces } from "@/components/landing/home/home-reel";
import { StudioClip, TemplateClip } from "@/components/site/StudioClip";
import { HomeHero } from "@/components/landing/home/HomeHero";
import "@/components/landing/home/home.css";

/**
 * The public landing page "/" (S4 sprint): a cinematic first screen, the Studio's own clips, how it works in three steps, the
 * models on sale today, MCP, a pricing teaser and an honest trust section. The footer is PublicShell's.
 *
 * Performance (LCP < 2.5 s on mobile 4G, no layout shift): the first screen's largest thing is the hero STILL, preloaded with
 * a phone-sized candidate in its srcset; its clip is fetched only after load and idle, and never under reduced motion, Save-Data
 * or a slow link (components/site/LoopClip.tsx). Every other clip waits until it is near the screen. Every picture box has its
 * size before anything loads. Headings are Onest, the face every page already preloads (components/site/fonts.ts).
 */
export function HomePage({
  t,
  locale,
  pricing,
  rates,
  models,
  oauthLive,
  expiry,
  dodo,
}: {
  t: Dictionary;
  locale: Locale;
  pricing: PricingTeaser;
  rates: PriceRates | null;
  /** null: the list could not be read (or 0193 is not applied); the strip is then not drawn at all. */
  models: PublicModel[] | null;
  /** MCP_OAUTH_LIVE: whether Claude and ChatGPT can connect today (lib/mcp-oauth.ts). */
  oauthLive: boolean;
  /** How long top-up credits last (lib/plans.ts packExpiry), for the FAQ; app/page.tsx's FAQPage JSON-LD reads the same. */
  expiry: PackExpiry;
  /** Dodo Payments sells here: the FAQ names it as the seller. */
  dodo: boolean;
}) {
  const h = t.landingHome;
  return (
    <div className="hm-root">
      <HomeHero t={t} />
      <Reel t={t} locale={locale} />
      <How t={t} />
      {/* The stages of one real run, each with its real file (id="autopilot": /solutions links here). */}
      <AutopilotDemo copy={t.site.autopilot.demo} />
      {models && models.length > 0 && <Models h={h} models={models} pause={t.site.fx.pause} />}
      <Mcp h={h} live={oauthLive} />
      <section id="pricing" aria-label={t.site.pricingTeaser.title} className="hm-pricing">
        <PriceBlock t={t} locale={locale} teaser={pricing} rates={rates} />
      </section>
      <Trust t={t} />
      {/* id="faq" and, in its aside, id="google-data": the statement Google's OAuth reviewers read on the home page
          (docs/GOOGLE_OAUTH_VERIFICATION.md); the footer links to both on every public page. */}
      <Faq t={t} plansOnSale={pricing.kind === "plans"} expiry={expiry} aside={<GoogleData t={t} />} dodo={dodo} />
      <Final h={h} />
    </div>
  );
}

function Reel({ t, locale }: { t: Dictionary; locale: Locale }) {
  const h = t.landingHome.hero;
  const pieces = studioPieces();
  if (pieces.length === 0) return null;
  return (
    <section aria-labelledby="hm-reel-title" className="hm-section hm-reel">
      <div className="hm-wrap">
        <h2 id="hm-reel-title" className="hm-h2-sm">
          {h.reelLabel}
        </h2>
        <p className="hm-muted">{h.reelNote}</p>
      </div>
      {/* A row wider than the screen scrolls: focusable, so a keyboard can scroll it too. data-scroll-region: still not a control,
          so a tap on a clip in it is the page's pause (lib/site/motion.ts motionTap). */}
      <ul className="hm-reel-row" aria-labelledby="hm-reel-title" tabIndex={0} data-scroll-region="">
        {pieces.map((p) => {
          const size = PIECE_SIZE[p.aspect];
          return (
            <li key={p.id} className="hm-reel-card" data-aspect={p.aspect} data-piece={p.id}>
              <figure>
                <div className="hm-reel-pic" data-clip={p.kind === "video" ? "sample" : undefined}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.poster}
                    width={size.width}
                    height={size.height}
                    alt={h.ai}
                    loading="lazy"
                    decoding="async"
                    className="hm-reel-still"
                  />
                  {p.kind === "video" && p.media.type === "studio" && <StudioClip slug={p.media.slug} captionsLabel={h.captions} />}
                  {p.media.type === "sample" && <ShowcaseClip jobId={p.media.jobId} together />}
                  {p.media.type === "template" && <TemplateClip slug={p.media.slug} />}
                  {/* The picture's description already says it is AI-generated; the badge is for the eye. */}
                  <span className="hm-badge hm-reel-badge" aria-hidden="true">
                    {h.ai}
                  </span>
                </div>
                <figcaption className="hm-reel-cap">
                  <span className="hm-reel-title">{p.title ? p.title[locale] : h.reelTitles[p.titleKey as keyof typeof h.reelTitles]}</span>
                  <span className="hm-reel-credit">{credit(h, p.models)}</span>
                </figcaption>
              </figure>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Made with A in Nightshift Studio", or "Made with A and B …" for a piece two models made (the dictionary's `and`). */
function credit(h: Dictionary["landingHome"]["hero"], models: string[]): string {
  const names = models.length > 1 ? `${models.slice(0, -1).join(", ")} ${h.and} ${models[models.length - 1]}` : models[0];
  return h.credit.replace("{model}", names);
}

const STEP_ICONS = { idea: Lightbulb, create: Sparkles, export: Download } as const;

function How({ t }: { t: Dictionary }) {
  const h = t.landingHome.how;
  return (
    <section id="how" aria-labelledby="hm-how-title" className="hm-section">
      <div className="hm-wrap">
        <h2 id="hm-how-title" className="ds-display hm-h2">
          {h.title}
        </h2>
        <p className="hm-lead">{h.lead}</p>
        <ol className="hm-steps">
          {h.steps.map((s, i) => {
            const Icon = STEP_ICONS[s.id as keyof typeof STEP_ICONS] ?? Sparkles;
            return (
              <li key={s.id} className="hm-step" data-step={s.id}>
                <div className="hm-step-head">
                  <span className="hm-step-icon" aria-hidden="true">
                    <Icon />
                  </span>
                  <span className="hm-step-num ds-num" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <p className="hm-step-label">{s.label}</p>
                <h3 className="hm-h3">{s.title}</h3>
                <p className="hm-muted">{s.body}</p>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

/**
 * How many chips one half of the ribbon holds at least. The loop slides by exactly one half, so a half narrower than the screen
 * would open a gap at the right end: with three or four models on sale, one copy of the list is far shorter than 1920 px.
 */
export const RIBBON_MIN_PER_HALF = 10;

/** How many times the list is repeated in each half of the ribbon (at least once). */
export function ribbonRepeats(n: number): number {
  return n > 0 ? Math.max(1, Math.ceil(RIBBON_MIN_PER_HALF / n)) : 0;
}

/**
 * The models on sale today (0193), as a slow ribbon on a dark band (the old landing's ModelMarquee look, its data source not).
 *
 * The first list is the accessible one: each model once, with its kinds and its 18+ mark, so a screen reader hears each name
 * once. The repeats that make the loop seamless are one more list, hidden from assistive technology. The band stops under the
 * pointer, with focus inside it, with the page's pause switch, and on a tap (lib/site/motion.ts TAP_AREAS); its keyboard pause key
 * (ClipPause) stays invisible until focused (the owner's rule: no visible pause button). Under reduced motion the repeats are not
 * drawn and the names sit still in a wrapped row (home.css).
 */
function Models({ h, models, pause }: { h: Dictionary["landingHome"]; models: PublicModel[]; pause: string }) {
  const k = ribbonRepeats(models.length);
  const chip = (m: PublicModel, key: string) => (
    <li key={key} className="hm-model">
      <span className="hm-model-name">{m.name}</span>
      {m.adultOnly && (
        <span className="hm-adult" data-adult-only="">
          {h.models.adultOnly}
        </span>
      )}
      {m.kinds.length > 0 && (
        <span className="hm-model-kinds">
          {m.kinds.map((kind) => (
            <span key={kind} className="hm-kind" data-kind={kind}>
              {h.models.kinds[kind]}
            </span>
          ))}
        </span>
      )}
    </li>
  );
  // 2k copies in all: the accessible list is the first, the hidden list the other 2k - 1, so the track's half is k copies.
  const repeats = Array.from({ length: 2 * k - 1 }, (_, c) => models.map((m) => chip(m, `${c}-${m.name}`))).flat();
  return (
    <section aria-labelledby="hm-models-title" className="hm-section hm-models">
      <div className="hm-wrap">
        <h2 id="hm-models-title" className="ds-display hm-h2">
          {h.models.title}
        </h2>
        <p className="hm-lead">{h.models.lead}</p>
      </div>
      <div className="hm-ribbon" data-theme-scope="dark" style={{ "--hm-rb-n": k * models.length } as React.CSSProperties}>
        <div className="hm-ribbon-track">
          <ul className="hm-model-list" aria-label={h.models.listLabel}>
            {models.map((m) => chip(m, m.name))}
          </ul>
          <ul className="hm-model-list" data-copy="repeat" aria-hidden="true">
            {repeats}
          </ul>
        </div>
        <ClipPause label={pause} />
      </div>
    </section>
  );
}

function Mcp({ h, live }: { h: Dictionary["landingHome"]; live: boolean }) {
  return (
    <section aria-labelledby="hm-mcp-title" className="hm-section">
      <div className="hm-wrap">
        <div className="hm-mcp">
          <span className="hm-tag">{h.mcp.tag}</span>
          <h2 id="hm-mcp-title" className="ds-display hm-h2">
            {live ? h.mcp.titleLive : h.mcp.titleOff}
          </h2>
          <p className="hm-lead">{live ? h.mcp.bodyLive : h.mcp.bodyOff}</p>
          <Link href="/mcp" className={buttonClass({ variant: "secondary" })}>
            {h.mcp.cta}
            <ArrowRight aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}

function Trust({ t }: { t: Dictionary }) {
  const h = t.landingHome.trust;
  const tr = t.site.trust;
  // Quoted from /trust, not paraphrased: the two pages cannot drift apart (lib/i18n/trust).
  const items = [
    { id: "publishing", title: tr.publishing.title, body: tr.publishing.lead },
    { id: "keys", title: tr.keys.title, body: tr.keys.lead },
    { id: "fallback", title: tr.fallback.title, body: tr.fallback.body },
    { id: "payments", title: tr.payments.title, body: tr.payments.body[0] },
  ];
  return (
    <section aria-labelledby="hm-trust-title" className="hm-section">
      <div className="hm-wrap">
        <h2 id="hm-trust-title" className="ds-display hm-h2">
          {h.title}
        </h2>
        <p className="hm-lead">{h.lead}</p>
        <ul className="hm-trust">
          {items.map((it) => (
            <li key={it.id} className="hm-trust-item" data-trust={it.id}>
              <ShieldCheck aria-hidden className="hm-trust-icon" />
              <h3 className="hm-h3">{it.title}</h3>
              <p className="hm-muted">{it.body}</p>
            </li>
          ))}
        </ul>
        <Link href="/trust" className="hm-link">
          {h.more}
          <ArrowRight aria-hidden />
        </Link>
      </div>
    </section>
  );
}

function Final({ h }: { h: Dictionary["landingHome"] }) {
  return (
    <section aria-labelledby="hm-final-title" className="hm-section hm-final" data-theme-scope="dark">
      <div className="hm-wrap hm-final-body">
        <h2 id="hm-final-title" className="ds-display hm-h2">
          {h.final.title}
        </h2>
        <p className="hm-lead">{h.final.lead}</p>
        <div className="hm-hero-ctas">
          <Link href="/signup" className={buttonClass({ variant: "primary", size: "lg" })}>
            {h.final.cta}
            <ArrowRight aria-hidden />
          </Link>
          <Link href="/pricing" className={buttonClass({ variant: "quiet", size: "lg" })}>
            {h.final.pricing}
          </Link>
        </div>
      </div>
    </section>
  );
}
