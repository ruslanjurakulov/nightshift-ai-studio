import Link from "next/link";
import {
  ArrowRight,
  Check,
  Clapperboard,
  Coins,
  FileText,
  ImagePlus,
  Languages,
  Lightbulb,
  Lock,
  Mic,
  Play,
  RotateCcw,
  Scissors,
  Send,
  ShieldCheck,
  Sparkles,
  Tv,
  Wand2,
  X,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import { fmt, LOCALES, type Dictionary, type Locale } from "@/lib/i18n";
import type { PricingTeaser as PricingTeaserData, ShowcaseItem } from "@/lib/landing";
import { WELCOME_CREDITS } from "@/lib/pricing";
import { HOME_FORMATS } from "@/lib/home";
import { FormatArt } from "@/components/home/FormatArt";
import { StudioMock } from "@/components/landing/StudioMock";
import { Showcase } from "@/components/landing/Showcase";
import { PricingTeaser } from "@/components/landing/PricingTeaser";
import { Faq } from "@/components/landing/Faq";
import { Eyebrow, SectionHead } from "@/components/landing/SectionHead";

const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

/** The video flow, in the order a video moves through it (same as Home's). */
const FLOW = ["channel", "topic", "script", "video", "approval", "youtube"] as const;
const FLOW_ICON: Record<(typeof FLOW)[number], LucideIcon> = {
  channel: Tv,
  topic: Lightbulb,
  script: FileText,
  video: Clapperboard,
  approval: ShieldCheck,
  youtube: Send,
};

/** The Studio's single-result tools, in the order the Studio lists them. */
const TOOLS = ["image", "video", "voice", "edit", "animate", "upscale", "cutout"] as const;
const TOOL_ICON: Record<(typeof TOOLS)[number], LucideIcon> = {
  image: ImagePlus,
  video: Clapperboard,
  voice: Mic,
  edit: Wand2,
  animate: Play,
  upscale: ZoomIn,
  cutout: Scissors,
};
/** Each tool's mark on its own painted square — the same hues as Home's quick tools. */
const TOOL_HUE: Record<(typeof TOOLS)[number], string> = {
  image: "linear-gradient(135deg,#ff7a59,#ffb35c)",
  video: "linear-gradient(135deg,#7b5cff,#d65cff)",
  voice: "linear-gradient(135deg,#2bb3a3,#5ad1e6)",
  edit: "linear-gradient(135deg,#3f7bff,#69b4ff)",
  animate: "linear-gradient(135deg,#5b3cc4,#e2559f)",
  upscale: "linear-gradient(135deg,#ffb020,#ff6a3d)",
  cutout: "linear-gradient(135deg,#e2559f,#ff8fb1)",
};

/**
 * The signed-out homepage. It leads with the product itself — the Studio as
 * it looks signed in, and the channel → topic → script → video → approval →
 * YouTube flow — then what you can make, how a video gets made, the five
 * rules that set Nightshift apart, the money, and the questions to settle
 * before paying.
 *
 * Every claim on it is one the code in this repository backs; where something
 * is not true yet (no public results, no published price) the section says so
 * or is left out. No competitor and no AI provider is named: the comparison
 * is with patterns common in the market. The only figure it states is the
 * welcome grant, read from WELCOME_CREDITS (which a test pins to the database).
 *
 * It is also the page Google's OAuth reviewers read to learn why the app asks
 * for YouTube access, which is why "Your Google data" stays on it with links to
 * the Privacy Policy and Google's own permissions page.
 *
 * A Server Component. The only client code on the page is the shell's mobile
 * menu and its theme and language controls; all motion is CSS.
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
    <div className="lp-root mx-auto flex w-full max-w-6xl flex-col gap-24 px-4 pb-24 pt-10 sm:px-6 sm:pt-16 lg:gap-32">
      <Hero t={t} />
      <MakeSection t={t} />
      <HowSection t={t} />
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
    <section aria-labelledby="hero-title" className="flex flex-col gap-10 sm:gap-12">
      <div className="lp-in max-w-3xl">
        <Eyebrow hour="22:00">{h.eyebrow}</Eyebrow>
        <h1
          id="hero-title"
          className="mt-6 font-display font-semibold tracking-[-0.03em]"
          style={{ fontSize: "clamp(2.25rem, 4.6vw, 58px)", lineHeight: 1.05, textWrap: "balance" }}
        >
          {h.title}
        </h1>
        <p className="mt-5 max-w-[60ch] text-[16.5px] font-light leading-relaxed text-[var(--color-muted)] sm:text-[18px]">
          {h.lead}
        </p>
        <div className="mt-8 flex flex-col gap-3 min-[420px]:flex-row min-[420px]:flex-wrap min-[420px]:items-center">
          <Link href="/signup" className="btn-sky is-solid pill min-h-12 px-7 text-[15px]">
            {h.ctaPrimary}
            <ArrowRight className="btn-arrow size-4" aria-hidden />
          </Link>
          <Link href="/pricing" className="btn-sky ghost pill min-h-12 px-7 text-[15px]">
            {h.ctaSecondary}
          </Link>
        </div>
        <p className="mt-4 flex items-center gap-2 text-[13px] text-[var(--color-muted)]">
          <Coins className="size-3.5 shrink-0 text-[var(--color-primary)]" aria-hidden />
          {fmt(h.note, { n: WELCOME_CREDITS })}
        </p>
      </div>

      <Flow t={t} />

      <div className="lg:pb-6">
        <StudioMock t={t} />
      </div>
    </section>
  );
}

/** The hero's flow strip: a real ordered list (it is the product's promise, not decoration). */
function Flow({ t }: { t: Dictionary }) {
  const f = t.landing.flow;
  return (
    <ol aria-label={t.landing.hero.flowLabel} className="flex flex-wrap items-center gap-x-2 gap-y-2.5 sm:gap-x-1">
      {FLOW.map((id, i) => {
        const Icon = FLOW_ICON[id];
        const you = id === "approval";
        const next = id === "youtube";
        return (
          <li key={id} className="flex items-center gap-1">
            <span
              className={`lp-flow-step ${you ? "is-you" : ""} ${next ? "is-next" : ""}`}
              style={{ "--i": i } as React.CSSProperties}
            >
              {you || next ? (
                <Icon className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <Check className="size-3.5 shrink-0 text-[var(--color-ok)]" aria-hidden />
              )}
              {f[id]}
            </span>
            {i < FLOW.length - 1 && (
              <span className="lp-flow-link hidden sm:block" style={{ "--i": i } as React.CSSProperties} aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function MakeSection({ t }: { t: Dictionary }) {
  const m = t.landing.make;
  return (
    <section id="product" aria-labelledby="make-title" className="scroll-mt-24">
      <SectionHead hour="23:00" eyebrow={m.eyebrow} title={m.title} lead={m.lead} id="make-title" />

      <h3 className="t-label mt-12">{m.formatsLabel}</h3>
      <ul className="mt-4 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3">
        {HOME_FORMATS.map((f) => {
          const copy = m.formats[f.id];
          return (
            <li
              key={f.id}
              className="lp-tile group overflow-hidden rounded-[18px] border border-[var(--color-border)] bg-[var(--color-panel)]"
            >
              <div className="relative aspect-[16/10] overflow-hidden">
                <FormatArt id={f.id} className="absolute inset-0 size-full" />
              </div>
              <div className="flex flex-col gap-0.5 p-3 sm:p-4">
                <h4 className="text-[14.5px] font-medium sm:text-[15px]">{copy.title}</h4>
                <p className="text-[12.5px] leading-snug text-[var(--color-muted)] sm:text-[13px]">{copy.who}</p>
              </div>
            </li>
          );
        })}
      </ul>

      <h3 className="t-label mt-12">{m.toolsLabel}</h3>
      <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {TOOLS.map((id) => {
          const Icon = TOOL_ICON[id];
          const copy = m.tools[id];
          return (
            <li
              key={id}
              className="flex items-center gap-3 rounded-[16px] border border-[var(--color-border)] bg-[var(--color-panel)] p-3 last:col-span-2 sm:p-3.5 sm:last:col-span-1 lg:flex-col lg:items-start"
            >
              <span
                className="grid size-9 shrink-0 place-items-center rounded-[10px] text-white shadow-[0_6px_18px_rgba(0,0,0,0.18)]"
                style={{ background: TOOL_HUE[id] }}
              >
                <Icon className="size-[18px]" aria-hidden />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[14px] font-medium">{copy.title}</span>
                <span className="text-[12px] leading-snug text-[var(--color-muted)]">{copy.sub}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function HowSection({ t }: { t: Dictionary }) {
  const h = t.landing.how;
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-24">
      <SectionHead hour="00:00" eyebrow={h.eyebrow} title={h.title} lead={h.lead} id="how-title" />
      <ol className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {h.steps.map((s, i) => {
          const Icon = FLOW_ICON[s.id as (typeof FLOW)[number]] ?? Sparkles;
          const yours = s.id === "approval";
          return (
            <li key={s.id} className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-5">
              <div className="flex items-center gap-3">
                <span
                  className={`grid size-9 place-items-center rounded-xl ${
                    yours
                      ? "bg-[var(--color-primary)] text-[var(--color-on-accent)]"
                      : "bg-[var(--color-accent-soft)] text-[var(--color-primary)]"
                  }`}
                >
                  <Icon className="size-[18px]" aria-hidden />
                </span>
                <span className="mono text-[12px] text-[var(--color-muted)]" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="t-panel">{s.title}</h3>
              <p className="text-[14.5px] font-light leading-relaxed text-[var(--color-muted)]">{s.body}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const WHY_ICON: Record<string, LucideIcon> = {
  price: Coins,
  refund: RotateCcw,
  approval: ShieldCheck,
  channels: Tv,
  languages: Languages,
};

/**
 * The five differences, each with the market pattern it answers — never a
 * named product. Every card carries a small piece of the real interface as
 * its picture, drawn from the same strings the app uses.
 */
function WhySection({ t }: { t: Dictionary }) {
  const w = t.landing.why;
  return (
    <section id="why" aria-labelledby="why-title" className="scroll-mt-24">
      <SectionHead hour="01:00" eyebrow={w.eyebrow} title={w.title} lead={w.lead} id="why-title" />
      <ul className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-6">
        {w.items.map((item, i) => {
          const Icon = WHY_ICON[item.id] ?? Sparkles;
          const span = i < 2 ? "lg:col-span-3" : i === w.items.length - 1 ? "md:col-span-2 lg:col-span-2" : "lg:col-span-2";
          return (
            <li
              key={item.id}
              className={`glass-card flex min-w-0 flex-col gap-4 rounded-[22px] border border-[var(--color-border)] p-6 ${span}`}
            >
              <div className="flex min-w-0 items-start justify-between gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-primary)]">
                  <Icon className="size-5" aria-hidden />
                </span>
                <WhyVisual id={item.id} t={t} />
              </div>
              <h3 className="text-[1.15rem] font-semibold tracking-[-0.015em]">{item.title}</h3>
              <p className="text-[14.5px] font-light leading-relaxed text-[var(--color-muted)]">{item.body}</p>
              <p className="mt-auto flex items-start gap-2 border-t border-[var(--color-border)] pt-4 text-[13px] text-[var(--color-muted)]">
                <X className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  <span className="sr-only">{w.elsewhere}: </span>
                  <span aria-hidden className="font-medium text-[var(--color-fg)]">
                    {w.elsewhere}:{" "}
                  </span>
                  {item.typical}
                </span>
              </p>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-[12.5px] font-light text-[var(--color-muted)]">{w.note}</p>
    </section>
  );
}

/** A small, decorative slice of the interface for each difference. */
function WhyVisual({ id, t }: { id: string; t: Dictionary }) {
  const m = t.landing.mock;
  const base = "pill min-w-0 items-center gap-1.5 truncate whitespace-nowrap border border-[var(--color-border)] px-2.5 py-1 text-[11px]";
  const chip = `${base} inline-flex`;
  if (id === "price")
    return (
      <span aria-hidden className={`${base} hidden text-[var(--color-muted)] min-[420px]:inline-flex`}>
        <Coins className="size-3 text-[var(--color-primary)]" />
        {m.priceNote}
      </span>
    );
  if (id === "refund")
    return (
      <span aria-hidden className={`${chip} text-[var(--color-ok)]`}>
        <RotateCcw className="size-3" />
        {m.returned}
      </span>
    );
  if (id === "approval")
    return (
      <span aria-hidden className={`${chip} border-[var(--color-primary)] text-[var(--color-primary)]`}>
        <Lock className="size-3" />
        {m.approve}
      </span>
    );
  if (id === "channels")
    return (
      <span aria-hidden className="flex -space-x-2">
        {["#7b5cff", "#2bb3a3", "#ff7a59"].map((c) => (
          <span key={c} className="grid size-7 place-items-center rounded-full border-2 border-[var(--color-panel)] text-white" style={{ background: c }}>
            <Tv className="size-3.5" />
          </span>
        ))}
      </span>
    );
  if (id === "languages")
    return (
      <span aria-hidden className="flex flex-wrap justify-end gap-1">
        {[...LOCALES].reverse().map((l) => (
          <span key={l.code} className={`${chip} px-2 py-0.5`}>
            {l.label}
          </span>
        ))}
      </span>
    );
  return null;
}

function GoogleData({ t }: { t: Dictionary }) {
  const d = t.landing.data;
  return (
    <section
      id="google-data"
      aria-labelledby="data-title"
      className="grid scroll-mt-24 gap-6 rounded-[22px] border border-[var(--color-border)] bg-[var(--color-panel)] p-6 sm:p-8 lg:grid-cols-[auto_1fr]"
    >
      <span className="grid size-11 place-items-center rounded-2xl bg-[var(--color-accent-soft)] text-[var(--color-primary)]">
        <Lock className="size-5" aria-hidden />
      </span>
      <div>
        <h2 id="data-title" className="text-[1.375rem] font-semibold tracking-[-0.02em]">
          {d.title}
        </h2>
        <p className="mt-3 max-w-[70ch] text-[15px] font-light leading-relaxed text-[var(--color-muted)]">{d.body}</p>
        <div className="mt-6 flex flex-wrap gap-3">
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
      className="lp-horizon relative overflow-hidden rounded-[28px] border border-[var(--color-border)] px-5 pb-14 pt-16 text-center sm:px-12 sm:pb-20 sm:pt-20"
    >
      <div className="flex justify-center">
        <Eyebrow hour="06:00">{t.brand.name}</Eyebrow>
      </div>
      <h2
        id="final-title"
        className="mx-auto mt-6 max-w-2xl font-display font-semibold tracking-[-0.03em]"
        style={{ fontSize: "clamp(1.875rem, 3.8vw, 46px)", lineHeight: 1.08, textWrap: "balance" }}
      >
        {f.title}
      </h2>
      <p className="mx-auto mt-4 max-w-[52ch] text-[16px] font-light leading-relaxed text-[var(--color-muted)] sm:text-[17px]">
        {f.lead}
      </p>
      <div className="mt-8 flex flex-col justify-center gap-3 min-[420px]:flex-row">
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
