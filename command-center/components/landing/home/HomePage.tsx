import Link from "next/link";
import { preload } from "react-dom";
import { ArrowRight, Download, Lightbulb, ShieldCheck, Sparkles } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n/core";
import type { PricingTeaser } from "@/lib/landing";
import type { PriceRates } from "@/lib/site/price-check";
import type { PublicModel } from "@/lib/public-models";
import { posterSrcSet } from "@/lib/site/renditions";
import { buttonClass } from "@/components/ds/button-class";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { MotionToggle } from "@/components/site/MotionToggle";
import { PriceBlock } from "@/components/landing/PriceBlock";
import { HERO_JOB, reelItem, reelItems } from "@/components/landing/home/home-reel";
import "@/components/landing/home/home.css";

/** The hero picture's widths, as the browser should choose them: the whole screen. */
const HERO_SIZES = "100vw";

/**
 * The public landing page "/" (S4 sprint): a cinematic first screen, the Studio's own clips, how it works in three steps, the
 * models on sale today, MCP, a pricing teaser and an honest trust section. The footer is PublicShell's.
 *
 * Performance (LCP < 2.5 s on mobile 4G, no layout shift): the first screen's largest thing is the hero STILL, preloaded with
 * a phone-sized candidate in its srcset; its clip is fetched only after load and idle, and never under reduced motion, Save-Data
 * or a slow link (components/site/LoopClip.tsx). Every other clip waits until it is near the screen. Every picture box has its
 * size before anything loads. The display face is preloaded only here (components/site/fonts.ts preloadDisplayFont).
 */
export function HomePage({
  t,
  locale,
  pricing,
  rates,
  models,
  oauthLive,
}: {
  t: Dictionary;
  locale: Locale;
  pricing: PricingTeaser;
  rates: PriceRates | null;
  /** null: the list could not be read (or 0187 is not applied); the strip is then not drawn at all. */
  models: PublicModel[] | null;
  /** MCP_OAUTH_LIVE: whether Claude and ChatGPT can connect today (lib/mcp-oauth.ts). */
  oauthLive: boolean;
}) {
  const h = t.landingHome;
  const hero = reelItem(HERO_JOB);
  if (hero) preload(hero.f.posterSm, { as: "image", imageSrcSet: posterSrcSet(hero.f), imageSizes: HERO_SIZES, fetchPriority: "high" });
  return (
    <div className="hm-root">
      <Hero t={t} />
      <Reel t={t} />
      <How t={t} />
      {models && models.length > 0 && <Models h={h} models={models} />}
      <Mcp h={h} live={oauthLive} />
      <section id="pricing" aria-label={t.site.pricingTeaser.title} className="hm-pricing">
        <PriceBlock t={t} locale={locale} teaser={pricing} rates={rates} />
      </section>
      <Trust t={t} />
      <Final h={h} />
    </div>
  );
}

function Hero({ t }: { t: Dictionary }) {
  const h = t.landingHome.hero;
  const item = reelItem(HERO_JOB);
  return (
    // Dark whatever the page's theme: the words sit on a moving picture, and the picture is night.
    <section aria-labelledby="hm-hero-title" className="hm-hero" data-theme-scope="dark">
      {item && (
        <div className="hm-hero-media" data-clip="sample" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.f.posterSm}
            srcSet={posterSrcSet(item.f)}
            sizes={HERO_SIZES}
            width={item.e.width}
            height={item.e.height}
            alt=""
            className="hm-hero-still"
            fetchPriority="high"
            decoding="async"
          />
          <ShowcaseClip jobId={item.e.jobId} compact={false} early />
        </div>
      )}
      <div className="hm-hero-veil" aria-hidden="true" />
      <div className="hm-wrap hm-hero-body">
        <p className="hm-eyebrow">{h.eyebrow}</p>
        <h1 id="hm-hero-title" className="ds-display hm-hero-title">
          {h.title}
        </h1>
        <p className="hm-hero-lead">{h.lead}</p>
        <div className="hm-hero-ctas">
          <Link href="/signup" className={buttonClass({ variant: "primary", size: "lg" })}>
            {h.primary}
            <ArrowRight aria-hidden />
          </Link>
          <a href="#how" className={buttonClass({ variant: "secondary", size: "lg", className: "hm-ghost" })}>
            {h.secondary}
          </a>
        </div>
      </div>
      {item && (
        <p className="hm-hero-credit">
          <span className="hm-badge">{h.ai}</span> {h.reelLabel}
        </p>
      )}
      <MotionToggle pause={t.site.fx.pause} />
    </section>
  );
}

function Reel({ t }: { t: Dictionary }) {
  const h = t.landingHome.hero;
  const items = reelItems();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="hm-reel-title" className="hm-section hm-reel">
      <div className="hm-wrap">
        <h2 id="hm-reel-title" className="hm-h2-sm">
          {h.reelLabel}
        </h2>
        <p className="hm-muted">{h.reelNote}</p>
      </div>
      <ul className="hm-reel-row" aria-label={h.reelLabel}>
        {items.map(({ e, f }) => (
          <li key={e.jobId} className="hm-reel-card">
            <div className="hm-reel-pic" data-clip="sample" style={{ aspectRatio: `${e.width} / ${e.height}` }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={f.posterSm}
                width={e.width}
                height={e.height}
                alt={t.site.gallery.bgClip}
                loading="lazy"
                decoding="async"
                className="hm-reel-still"
              />
              <ShowcaseClip jobId={e.jobId} together />
              <span className="hm-badge hm-reel-badge">{h.ai}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
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

function Models({ h, models }: { h: Dictionary["landingHome"]; models: PublicModel[] }) {
  return (
    <section aria-labelledby="hm-models-title" className="hm-section hm-models">
      <div className="hm-wrap">
        <h2 id="hm-models-title" className="ds-display hm-h2">
          {h.models.title}
        </h2>
        <p className="hm-lead">{h.models.lead}</p>
        <ul className="hm-model-list" aria-label={h.models.listLabel}>
          {models.map((m) => (
            <li key={m.name} className="hm-model">
              <span className="hm-model-name">{m.name}</span>
              {m.kinds.length > 0 && (
                <span className="hm-model-kinds">
                  {m.kinds.map((k) => (
                    <span key={k} className="hm-kind" data-kind={k}>
                      {h.models.kinds[k]}
                    </span>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
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
