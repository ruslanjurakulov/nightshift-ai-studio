import Link from "next/link";
import { ArrowRight, X } from "lucide-react";
import type { Dictionary, Locale } from "@/lib/i18n";
import type { CreditRates } from "@/lib/pricing";
import type { SolutionId } from "@/lib/solutions";
import { Slug } from "@/components/site/Slug";
import { HeroFx } from "@/components/site/HeroFx";
import { MotionToggle } from "@/components/site/MotionToggle";
import { ApiPicture, ComposerPicture } from "@/components/site/SolutionPictures";
import { SolutionRows } from "@/components/landing/Landing";
import { PillarControl, PillarFaq, PillarHero, PillarStages } from "@/components/site/AutopilotPillar";

type Page = Dictionary["site"]["solutions"]["pages"][number];

/**
 * One Solutions page: who it is for, what the product does for them, what it
 * will not do (said as plainly as the rest — those are the product's rules),
 * where to start, and the other ways in. The picture is the product's own
 * state for that job: the composer for the Studio, the endpoint list for
 * developers.
 *
 * The channels page is also the YouTube Autopilot pillar (components/site/AutopilotPillar.tsx): its hero is the promise, the
 * composer and the sample script, and the run's stages, "You stay in control" and the questions sit around the same lists. It
 * is the page the landing's approvals card already links to (components/landing/Showcases.tsx APPROVALS_HREF), so the pillar
 * extends it instead of adding a second page on the same subject.
 */
export function SolutionView({
  t,
  id,
  page,
  locale = "en",
  rates = null,
}: {
  t: Dictionary;
  id: SolutionId;
  page: Page;
  locale?: Locale;
  /** The published credit rates (public_video_rates(), 0089) for the pillar's price line; null reads "not published". */
  rates?: CreditRates | null;
}) {
  const s = t.site.solutions;
  const others = s.pages.filter((p) => p.id !== id);
  const docs = "docs" in page ? page.docs : null;
  if (id === "youtube-channels") {
    return (
      <>
        <div className="nx-lit">
          <HeroFx />
          <PillarHero t={t} locale={locale} crumb={{ label: s.slug, current: page.kicker }} />
        </div>
        <PillarStages t={t} locale={locale} rates={rates} />
        <PillarControl t={t} />
        <What t={t} page={page} />
        <Nots t={t} page={page} />
        <PillarFaq t={t} />
        <Start t={t} page={page} />
        <Others t={t} others={others} />
      </>
    );
  }
  return (
    <>
      <div className="nx-lit">
        <HeroFx />
        <section aria-labelledby="solution-title" className="st-wrap st-hero">
          <div>
            <nav aria-label={s.breadcrumb} className="st-kicker flex flex-wrap items-center gap-2">
              <Link
                href="/solutions"
                className="inline-flex min-h-11 min-w-11 items-center underline decoration-[var(--ns-rule-strong)] underline-offset-4 hover:text-[var(--ns-text)]"
              >
                {s.slug}
              </Link>
              <span aria-hidden>/</span>
              <span aria-current="page">{page.kicker}</span>
            </nav>
            <h1 id="solution-title" className="st-h1-page mt-6">
              {page.title}
            </h1>
            <p className="st-lead mt-7">{page.lead}</p>
            <div className="st-hero-actions">
              <Link href="/signup" className="st-key">
                {s.cta}
                <ArrowRight aria-hidden />
              </Link>
              {docs ? (
                <Link href="/docs/api" className="st-link">
                  {docs}
                </Link>
              ) : (
                <Link href="/pricing" className="st-link">
                  {s.secondary}
                </Link>
              )}
            </div>
            <MotionToggle pause={t.site.fx.pause} />
          </div>
          {id === "creative-studio" ? <ComposerPicture t={t} /> : <ApiPicture t={t} />}
        </section>
      </div>
      <What t={t} page={page} />
      <Nots t={t} page={page} />
      <Start t={t} page={page} />
      <Others t={t} others={others} />
    </>
  );
}

function What({ t, page }: { t: Dictionary; page: Page }) {
  const s = t.site.solutions;
  return (
    <section aria-labelledby="what-title" className="st-section" data-size="sm">
      <div className="st-wrap">
        <Slug>{s.whatLabel}</Slug>
        <h2 id="what-title" className="sr-only">
          {s.whatLabel}
        </h2>
        {/* A ruled list, one row each: any count reads whole, with no empty cell. */}
        <ul className="st-ruled mt-10">
          {page.what.map((w) => (
            <li key={w.title}>
              <h3 className="st-h3">{w.title}</h3>
              <p className="st-body">{w.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Nots({ t, page }: { t: Dictionary; page: Page }) {
  return (
    <section aria-labelledby="not-title" className="st-section" data-size="sm" data-tone="raised">
      <div className="st-wrap">
        <h2 id="not-title" className="st-h2">
          {t.site.solutions.notLabel}
        </h2>
        <ul className="nx-nots">
          {page.not.map((line) => (
            <li key={line}>
              <span className="grid size-8 shrink-0 place-items-center rounded-full border border-[var(--ns-rule-strong)]">
                <X className="size-4" aria-hidden />
              </span>
              <p>{line}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Start({ t, page }: { t: Dictionary; page: Page }) {
  const s = t.site.solutions;
  return (
    <section id="start" aria-labelledby="start-title" className="st-section" data-size="sm">
      <div className="st-wrap">
        <Slug>{s.startLabel}</Slug>
        <h2 id="start-title" className="sr-only">
          {s.startLabel}
        </h2>
        <ol className="st-steps" data-cols="3" aria-label={s.startLabel}>
          {page.start.map((step, i) => (
            <li key={step} className="st-step">
              <span className="st-step-no st-num" aria-hidden>
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="st-step-title" data-case="sentence">
                {step}
              </h3>
            </li>
          ))}
        </ol>
        <div className="st-hero-actions">
          <Link href="/signup" className="st-key">
            {s.cta}
            <ArrowRight aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}

function Others({ t, others }: { t: Dictionary; others: Page[] }) {
  const s = t.site.solutions;
  return (
    <section aria-labelledby="others-title" className="st-section" data-size="sm">
      <div className="st-wrap">
        <Slug>{s.others}</Slug>
        <h2 id="others-title" className="sr-only">
          {s.others}
        </h2>
        <SolutionRows pages={others} />
      </div>
    </section>
  );
}
