import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  Check,
  Coins,
  Languages,
  Library,
  Lock,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Tv,
  X,
} from "lucide-react";
import type { Dictionary, Locale } from "@/lib/i18n";
import type { PricingTeaser as PricingTeaserData, ShowcaseItem } from "@/lib/landing";
import { StudioMock } from "@/components/landing/StudioMock";
import { Showcase } from "@/components/landing/Showcase";
import { PricingTeaser } from "@/components/landing/PricingTeaser";
import { Faq } from "@/components/landing/Faq";
import { Eyebrow, SectionHead } from "@/components/landing/SectionHead";

const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

/**
 * The signed-out homepage: Nightshift as a creative studio for YouTube — make
 * images, video and voice, keep them in one library, publish through an
 * approval step — and the money rules that come with it (the price before
 * every generation, credits back on failure).
 *
 * Every claim on it is one the code in this repository backs; where something
 * is not true yet (no public results, no published price) the section says so
 * or is left out. No competitor is named: the comparison is with "typical
 * tools", described as market patterns.
 *
 * It is also the page Google's OAuth reviewers read to learn why the app asks
 * for YouTube access, which is why "Your Google data" stays on it with links to
 * the Privacy Policy and Google's own permissions page.
 *
 * A Server Component. The only client code on the page is the shell's mobile
 * menu and its theme and language controls; the hero's motion is CSS.
 */
export function Landing({
  t,
  locale,
  pricing,
  showcase,
}: {
  t: Dictionary;
  locale: Locale;
  pricing: PricingTeaserData;
  showcase: ShowcaseItem[];
}) {
  return (
    <div className="lp-root mx-auto flex w-full max-w-6xl flex-col gap-24 px-4 pb-24 pt-8 sm:px-6 sm:pt-14 lg:gap-32">
      <Hero t={t} />
      <Promises t={t} />
      <HowSection t={t} />
      <FeaturesSection t={t} />
      <WhySection t={t} />
      {showcase.length > 0 && <Showcase t={t} items={showcase} hour="02:00" />}
      <PricingTeaser t={t} locale={locale} teaser={pricing} hour="03:00" />
      <Faq t={t} hour="04:00" />
      <GoogleData t={t} />
      <FinalCta t={t} />
    </div>
  );
}

function Hero({ t }: { t: Dictionary }) {
  const h = t.landing.hero;
  return (
    <section aria-labelledby="hero-title" className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
      <div className="page-rise min-w-0">
        <Eyebrow hour="22:00">{h.eyebrow}</Eyebrow>
        <h1
          id="hero-title"
          className="mt-6 font-display font-semibold tracking-[-0.035em]"
          style={{ fontSize: "clamp(2.375rem, 5.2vw, 64px)", lineHeight: 1.03, textWrap: "balance" }}
        >
          {h.title}
        </h1>
        <p className="t-lead mt-6">{h.lead}</p>
        <div className="mt-9 flex flex-col gap-3 min-[420px]:flex-row min-[420px]:flex-wrap min-[420px]:items-center">
          <Link href="/signup" className="btn-sky is-solid pill min-h-12 px-7 text-[15px]">
            {h.ctaPrimary}
            <ArrowRight className="btn-arrow size-4" aria-hidden />
          </Link>
          <Link href="/pricing" className="btn-sky ghost pill min-h-12 px-7 text-[15px]">
            {h.ctaSecondary}
          </Link>
        </div>
        <p className="mt-5 text-[13px] font-light text-[var(--color-muted)]">{h.note}</p>
      </div>
      <div className="min-w-0 lg:pb-8">
        <StudioMock t={t} />
      </div>
    </section>
  );
}

function Promises({ t }: { t: Dictionary }) {
  const p = t.landing.promises;
  const icons = [Coins, RotateCcw, ShieldCheck, Tv, Languages];
  return (
    <section aria-label={p.label} className="-mt-6 border-y border-[var(--color-border)] py-6 lg:-mt-10">
      <ul className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-5">
        {p.items.map((item, i) => {
          const Icon = icons[i] ?? Check;
          return (
            <li key={item} className="flex items-start gap-3 text-[13.5px] leading-snug">
              <Icon className="mt-px size-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
              <span>{item}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function HowSection({ t }: { t: Dictionary }) {
  const h = t.landing.how;
  const icons = [Sparkles, Library, ShieldCheck];
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-24">
      <SectionHead hour="23:00" eyebrow={h.eyebrow} title={h.title} lead={h.lead} id="how-title" />
      <ol className="mt-12 grid gap-4 md:grid-cols-3">
        {h.steps.map((s, i) => {
          const Icon = icons[i] ?? Sparkles;
          return (
            <li key={s.title} className="panel flex flex-col gap-4 p-6">
              <div className="flex items-center justify-between">
                <span className="grid size-11 place-items-center rounded-2xl border border-[var(--color-primary)] text-[var(--color-primary)] shadow-[0_0_24px_var(--glow-primary)]">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="mono text-[13px] text-[var(--color-muted)]" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="text-[1.25rem] font-semibold tracking-[-0.02em]">{s.title}</h3>
              <p className="text-[14.5px] font-light leading-relaxed text-[var(--color-muted)]">{s.body}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const FEATURE_ICONS: Record<string, typeof Sparkles> = {
  studio: Sparkles,
  library: Library,
  publish: ShieldCheck,
  channels: Tv,
  credits: Coins,
};

function FeaturesSection({ t }: { t: Dictionary }) {
  const f = t.landing.features;
  return (
    <section id="product" aria-labelledby="features-title" className="scroll-mt-24">
      <SectionHead hour="00:00" eyebrow={f.eyebrow} title={f.title} lead={f.lead} id="features-title" />
      <ul className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {f.items.map((item, i) => {
          const Icon = FEATURE_ICONS[item.id] ?? Sparkles;
          // The Studio leads, twice as wide: it is where every result starts.
          const wide = i === 0;
          return (
            <li
              key={item.id}
              className={`glass-card flex flex-col gap-5 rounded-[22px] border border-[var(--color-border)] p-6 sm:p-7 ${
                wide ? "md:col-span-2" : ""
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)] text-[var(--color-primary)]">
                  <Icon className="size-5" aria-hidden />
                </span>
                <h3 className="text-[1.2rem] font-semibold tracking-[-0.02em]">{item.title}</h3>
              </div>
              <p className="max-w-prose text-[14.5px] font-light leading-relaxed text-[var(--color-muted)]">{item.body}</p>
              <ul className={`mt-auto grid gap-2.5 ${wide ? "sm:grid-cols-3 sm:gap-4" : ""}`}>
                {item.points.map((pt) => (
                  <li key={pt} className="flex items-start gap-2.5 text-[13.5px] leading-snug">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--color-primary)]" aria-hidden />
                    <span>{pt}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Nightshift against the patterns common in the market — never a named
 * product. A real table for assistive tech; below `md` each row folds into a
 * card whose cells carry their column name (globals.css, .lp-compare).
 */
function WhySection({ t }: { t: Dictionary }) {
  const w = t.landing.why;
  return (
    <section id="why" aria-labelledby="why-title" className="scroll-mt-24">
      <SectionHead hour="01:00" eyebrow={w.eyebrow} title={w.title} lead={w.lead} id="why-title" />
      <div className="mt-12 overflow-hidden rounded-[22px] border border-[var(--color-border)]">
        <table className="lp-compare w-full border-collapse text-left">
          <caption className="sr-only">{w.title}</caption>
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-panel)]">
              <th scope="col" className="t-label px-5 py-4 font-normal">
                {w.topic}
              </th>
              <th scope="col" className="t-label px-5 py-4 font-normal">
                {w.typical}
              </th>
              <th scope="col" className="px-5 py-4 text-[13px] font-semibold text-[var(--color-primary)]">
                {w.ours}
              </th>
            </tr>
          </thead>
          <tbody>
            {w.rows.map((r) => (
              <tr key={r.topic} className="border-b border-[var(--color-border)] last:border-b-0">
                <th scope="row" className="px-5 py-4 align-top text-[15px] font-medium">
                  {r.topic}
                </th>
                <td data-label={w.typical} className="px-5 py-4 align-top text-[14px] font-light text-[var(--color-muted)]">
                  <span className="flex items-start gap-2.5">
                    <X className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>{r.typical}</span>
                  </span>
                </td>
                <td
                  data-label={w.ours}
                  className="lp-compare-ours px-5 py-4 align-top text-[14px]"
                >
                  <span className="flex items-start gap-2.5">
                    <BadgeCheck className="mt-0.5 size-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
                    <span>{r.ours}</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-[12.5px] font-light text-[var(--color-muted)]">{w.note}</p>
    </section>
  );
}

function GoogleData({ t }: { t: Dictionary }) {
  const d = t.landing.data;
  return (
    <section
      id="google-data"
      aria-labelledby="data-title"
      className="glass-card grid scroll-mt-24 gap-6 rounded-[22px] border border-[var(--color-border)] p-6 sm:p-10 lg:grid-cols-[auto_1fr]"
    >
      <span className="grid size-12 place-items-center rounded-2xl border border-[var(--color-primary)] text-[var(--color-primary)]">
        <Lock className="size-5" aria-hidden />
      </span>
      <div>
        <h2 id="data-title" className="text-[1.625rem] font-semibold tracking-[-0.02em]">
          {d.title}
        </h2>
        <p className="t-lead mt-4">{d.body}</p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link href="/privacy" className="btn-sky pill min-h-11 px-5 text-sm">
            {d.privacy}
          </Link>
          <a
            href={GOOGLE_PERMISSIONS}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-sky ghost pill min-h-11 px-5 text-sm"
          >
            {d.revoke}
          </a>
        </div>
      </div>
    </section>
  );
}

function FinalCta({ t }: { t: Dictionary }) {
  const f = t.landing.final;
  return (
    <section
      aria-labelledby="final-title"
      className="lp-horizon relative overflow-hidden rounded-[28px] border border-[var(--color-border)] px-5 pb-14 pt-16 text-center sm:px-12 sm:pb-20 sm:pt-24"
    >
      <div className="flex justify-center">
        <Eyebrow hour="06:00">{t.brand.name}</Eyebrow>
      </div>
      <h2
        id="final-title"
        className="mx-auto mt-6 max-w-3xl font-display font-semibold tracking-[-0.03em]"
        style={{ fontSize: "clamp(2rem, 4.6vw, 56px)", lineHeight: 1.06, textWrap: "balance" }}
      >
        {f.title}
      </h2>
      <p className="t-lead mx-auto mt-5">{f.lead}</p>
      <div className="mt-9 flex flex-col justify-center gap-3 min-[420px]:flex-row">
        <Link href="/signup" className="btn-sky is-solid pill min-h-12 px-7 text-[15px]">
          {f.ctaPrimary}
          <ArrowRight className="btn-arrow size-4" aria-hidden />
        </Link>
        <Link href="/pricing" className="btn-sky ghost pill min-h-12 px-7 text-[15px]">
          {f.ctaSecondary}
        </Link>
      </div>
      <span className="lp-horizon-line absolute inset-x-[12%] bottom-0 h-px" aria-hidden />
    </section>
  );
}
