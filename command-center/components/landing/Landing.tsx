import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  CalendarClock,
  Check,
  Clapperboard,
  Compass,
  Gauge,
  KeyRound,
  Lightbulb,
  ListVideo,
  Lock,
  PauseCircle,
  Radar,
  Receipt,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  Workflow,
} from "lucide-react";
import type { Dictionary, Locale } from "@/lib/i18n";
import type { PricingTeaser as PricingTeaserData, ShowcaseItem } from "@/lib/landing";
import { LiveRun } from "@/components/landing/LiveRun";
import { Showcase } from "@/components/landing/Showcase";
import { PricingTeaser } from "@/components/landing/PricingTeaser";
import { Faq } from "@/components/landing/Faq";
import { Eyebrow, SectionHead } from "@/components/landing/SectionHead";

const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

/**
 * The signed-out homepage. Every section answers one question a visitor has
 * — what is it, how does it work, what stays in my hands, what does it cost —
 * and every claim on it is one the code in this repository backs. Where a thing
 * is not true yet (no public results, no published price), the section says
 * so or is left out; nothing is filled in to look busy.
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
    <main className="lp-root mx-auto flex w-full max-w-6xl flex-col gap-24 px-4 pb-24 pt-8 sm:px-6 sm:pt-14 lg:gap-36">
      <Hero t={t} />
      <TrustStrip t={t} />
      <LoopSection t={t} />
      <HowSection t={t} />
      <AutonomySection t={t} />
      <SeriesSection t={t} />
      <CapabilitiesSection t={t} />
      {showcase.length > 0 && <Showcase t={t} items={showcase} hour="03:30" />}
      <PricingTeaser t={t} locale={locale} teaser={pricing} hour="04:00" />
      <Faq t={t} hour="05:00" />
      <GoogleData t={t} />
      <FinalCta t={t} />
    </main>
  );
}

function Hero({ t }: { t: Dictionary }) {
  const h = t.landing.hero;
  return (
    <section aria-labelledby="hero-title" className="grid items-center gap-12 lg:grid-cols-[1.12fr_0.88fr] lg:gap-14">
      <div className="page-rise min-w-0">
        <Eyebrow hour="22:00">{h.eyebrow}</Eyebrow>
        <h1
          id="hero-title"
          className="mt-6 font-display font-semibold tracking-[-0.035em]"
          style={{ fontSize: "clamp(2.375rem, 5.2vw, 66px)", lineHeight: 1.02, textWrap: "balance" }}
        >
          {h.title}
        </h1>
        <p className="t-lead mt-6">{h.lead}</p>
        <div className="mt-9 flex flex-col gap-3 min-[420px]:flex-row min-[420px]:flex-wrap min-[420px]:items-center">
          <Link href="/signup" className="btn-sky is-solid pill min-h-12 px-7 text-[15px]">
            {h.ctaPrimary}
            <ArrowRight className="btn-arrow size-4" aria-hidden />
          </Link>
          <a href="#how" className="btn-sky ghost pill min-h-12 px-7 text-[15px]">
            {h.ctaSecondary}
          </a>
        </div>
        <p className="mt-5 text-[13px] font-light text-[var(--color-muted)]">{h.note}</p>
      </div>
      <LiveRun t={t} />
    </section>
  );
}

function TrustStrip({ t }: { t: Dictionary }) {
  const tr = t.landing.trust;
  const icons = [Lock, ShieldCheck, BadgeCheck, Gauge, KeyRound];
  return (
    <section aria-label={tr.label} className="-mt-8 border-y border-[var(--color-border)] py-6 lg:-mt-16">
      <ul className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-5">
        {tr.items.map((item, i) => {
          const Icon = icons[i] ?? Check;
          return (
            <li key={item} className="flex items-start gap-3 text-[13px] leading-snug">
              <Icon className="mt-px size-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
              <span>{item}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function LoopSection({ t }: { t: Dictionary }) {
  const lp = t.landing.loop;
  const icons = [Radar, Compass, Clapperboard, Send, TrendingUp];
  return (
    <section id="product" aria-labelledby="loop-title" className="scroll-mt-24">
      <SectionHead hour="23:00" eyebrow={lp.eyebrow} title={lp.title} lead={lp.lead} id="loop-title" />

      <div className="relative mt-14">
        {/* The signal line joining the stages, desktop only; on a phone the
            list's own left rail carries it. */}
        <svg className="pointer-events-none absolute left-[10%] top-6 hidden h-[2px] w-[80%] lg:block" aria-hidden>
          <line x1="0" y1="1" x2="100%" y2="1" stroke="var(--color-primary)" strokeOpacity="0.5" strokeWidth="1.5" className="flow-line" />
        </svg>
        <ol className="relative grid gap-8 border-l border-[var(--color-border)] pl-6 lg:grid-cols-5 lg:gap-6 lg:border-l-0 lg:pl-0">
          {lp.nodes.map((node, i) => {
            const Icon = icons[i] ?? Sparkles;
            return (
              <li key={node.name} className="relative flex flex-col gap-3 lg:items-center lg:text-center">
                <span className="absolute -left-[28.5px] top-5 size-2 rounded-full bg-[var(--color-primary)] lg:hidden" aria-hidden />
                <span className="grid size-12 place-items-center rounded-2xl border border-[var(--color-primary)] bg-[var(--color-bg)] text-[var(--color-primary)] shadow-[0_0_24px_var(--glow-primary)]">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="mono text-[11px] text-[var(--color-muted)]" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="t-panel -mt-1">{node.name}</h3>
                <p className="text-[14px] font-light leading-relaxed text-[var(--color-muted)] lg:max-w-[22ch]">{node.body}</p>
              </li>
            );
          })}
        </ol>

        {/* The way back: what was learned returns to the start of the loop. */}
        <div className="mt-10 flex items-center gap-3 lg:mt-12">
          <span className="hidden h-6 flex-1 -translate-y-3 rounded-bl-2xl border-b border-l border-dashed border-[var(--color-primary)] opacity-60 lg:block" aria-hidden />
          <span className="pill inline-flex items-center gap-2 border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-[13px]">
            <RotateCcw className="size-3.5 text-[var(--color-primary)]" aria-hidden />
            {lp.back}
          </span>
          <span className="hidden h-6 flex-1 -translate-y-3 rounded-br-2xl border-b border-r border-dashed border-[var(--color-primary)] opacity-60 lg:block" aria-hidden />
        </div>
      </div>
    </section>
  );
}

function HowSection({ t }: { t: Dictionary }) {
  const h = t.landing.how;
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-24">
      <SectionHead hour="00:00" eyebrow={h.eyebrow} title={h.title} lead={h.lead} id="how-title" />
      <ol className="mt-12">
        {h.steps.map((s, i) => (
          <li
            key={s.title}
            className="grid gap-3 border-t border-[var(--color-border)] py-7 md:grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)] md:gap-8"
          >
            <span className="mono text-[13px] text-[var(--color-primary)]">{String(i + 1).padStart(2, "0")}</span>
            <h3 className="text-[1.25rem] font-semibold tracking-[-0.02em]">{s.title}</h3>
            <div>
              <div className="t-label">{h.whatLabel}</div>
              <p className="mt-2 text-[14px] font-light leading-relaxed">{s.what}</p>
            </div>
            <div>
              <div className="t-label">{h.whyLabel}</div>
              <p className="mt-2 text-[14px] font-light leading-relaxed text-[var(--color-muted)]">{s.why}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AutonomySection({ t }: { t: Dictionary }) {
  const a = t.landing.autonomy;
  const controlIcons = [ShieldCheck, Users, Gauge, Receipt, CalendarClock, PauseCircle];
  return (
    <section id="autonomy" aria-labelledby="autonomy-title" className="scroll-mt-24">
      <SectionHead hour="01:00" eyebrow={a.eyebrow} title={a.title} lead={a.lead} id="autonomy-title" />

      {/* Three levels read as one dial: each adds automation, none removes a safeguard. */}
      <ol className="mt-12 grid gap-4 md:grid-cols-3">
        {a.modes.map((m, i) => (
          <li key={m.name} className="panel flex flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
              <h3 className="t-panel text-[1.125rem]">{m.name}</h3>
              <span className="flex items-end gap-1" aria-hidden>
                {[0, 1, 2].map((b) => (
                  <span
                    key={b}
                    className="w-1.5 rounded-full"
                    style={{
                      height: `${8 + b * 5}px`,
                      background: b <= i ? "var(--color-primary)" : "var(--color-border)",
                    }}
                  />
                ))}
              </span>
            </div>
            <p className="text-[14px] font-light leading-relaxed text-[var(--color-muted)]">{m.body}</p>
          </li>
        ))}
      </ol>

      <p className="mt-5 flex items-start gap-3 rounded-2xl border border-dashed border-[var(--color-primary)] px-5 py-4 text-[14px] leading-relaxed">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
        <span>{a.defaultNote}</span>
      </p>

      <h3 className="t-label mt-14">{a.controlsTitle}</h3>
      <ul className="mt-5 grid gap-px overflow-hidden rounded-[18px] border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-3">
        {a.controls.map((c, i) => {
          const Icon = controlIcons[i] ?? Check;
          return (
            <li key={c.title} className="flex flex-col gap-2.5 bg-[var(--color-panel)] p-6">
              <span className="flex items-center gap-2.5">
                <Icon className="size-4 text-[var(--color-primary)]" aria-hidden />
                <span className="text-[15px] font-medium">{c.title}</span>
              </span>
              <p className="text-[13.5px] font-light leading-relaxed text-[var(--color-muted)]">{c.body}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** How far along each example episode is drawn, top to bottom. */
const EPISODE_PROGRESS = [100, 86, 64, 36, 0];

function SeriesSection({ t }: { t: Dictionary }) {
  const s = t.landing.series;
  return (
    <section id="series" aria-labelledby="series-title" className="scroll-mt-24">
      <SectionHead hour="02:00" eyebrow={s.eyebrow} title={s.title} lead={s.lead} id="series-title" />

      <div className="mt-12 grid items-center gap-6 lg:grid-cols-[minmax(0,0.9fr)_auto_minmax(0,1.1fr)]">
        <div className="glass-card rounded-[22px] border border-[var(--color-border)] p-6">
          <div className="flex items-center gap-2.5">
            <Workflow className="size-4 text-[var(--color-primary)]" aria-hidden />
            <span className="t-label">{s.example}</span>
          </div>
          <dl className="mt-5 flex flex-col">
            {s.inputs.map((inp) => (
              <div key={inp.label} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 border-t border-[var(--color-border)] py-3.5">
                <dt className="text-[13px] font-light text-[var(--color-muted)]">{inp.label}</dt>
                <dd className="text-[14px]">{inp.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <ArrowRight className="mx-auto size-5 rotate-90 text-[var(--color-primary)] lg:rotate-0" aria-hidden />

        <div className="min-w-0">
          {/* Illustrative, like the series card: episode numbers and stage names only. */}
          <ol className="flex flex-col gap-2.5">
            {s.states.map((state, i) => {
              const progress = EPISODE_PROGRESS[i] ?? 0;
              const done = progress === 100;
              const idle = progress === 0;
              return (
                <li
                  key={state}
                  className="flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-3 sm:gap-4"
                  style={{ opacity: idle ? 0.7 : 1 }}
                >
                  <span className="mono shrink-0 text-[12px] text-[var(--color-muted)]">
                    {s.episode} {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="h-1 min-w-6 flex-1 overflow-hidden rounded-full bg-[var(--color-panel-2)]" aria-hidden>
                    <span
                      className="block h-full rounded-full bg-[var(--color-primary)]"
                      style={{ width: `${progress}%`, opacity: done ? 1 : 0.7 }}
                    />
                  </span>
                  <span
                    className="shrink-0 text-right text-[12px]"
                    style={{ color: idle ? "var(--color-muted)" : done ? "var(--color-fg)" : "var(--color-primary)" }}
                  >
                    {state}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="mt-4 flex items-start gap-2.5 text-[13px] font-light text-[var(--color-muted)]">
            <ListVideo className="mt-0.5 size-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
            {s.note}
          </p>
        </div>
      </div>
    </section>
  );
}

function CapabilitiesSection({ t }: { t: Dictionary }) {
  const c = t.landing.caps;
  const icons = [Lightbulb, Clapperboard, Send, TrendingUp, Workflow];
  return (
    <section id="capabilities" aria-labelledby="caps-title" className="scroll-mt-24">
      <SectionHead hour="03:00" eyebrow={c.eyebrow} title={c.title} id="caps-title" />
      <div className="mt-12">
        {c.groups.map((g, i) => {
          const Icon = icons[i] ?? Sparkles;
          return (
            <div key={g.title} className="grid gap-4 border-t border-[var(--color-border)] py-7 md:grid-cols-[15rem_minmax(0,1fr)] md:gap-10">
              <h3 className="flex items-center gap-3 self-start text-[1.125rem] font-semibold tracking-[-0.015em]">
                <Icon className="size-[18px] shrink-0 text-[var(--color-primary)]" aria-hidden />
                {g.title}
              </h3>
              <ul className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
                {g.items.map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-[14px] font-light leading-relaxed">
                    <Check className="mt-1 size-3.5 shrink-0 text-[var(--color-primary)]" aria-hidden />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
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
