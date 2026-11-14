import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Dictionary, Locale } from "@/lib/i18n";
import { fmt } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { REFERRAL_TERMS_DATE, type ReferralRead, type ReferralTerms } from "@/lib/referrals";

function utcDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * /referral: the referral programme's full terms (migration 0165). The rules are the page's words; every number in them is
 * today's number from the database (referral_terms()), dated by when it last changed. When the numbers cannot be read, the
 * page says so and shows the rules with no number at all, never a remembered or default one. A Server Component; the frame
 * is PublicShell's.
 */
export function ReferralTermsPage({
  t,
  locale,
  read,
  signedIn = false,
}: {
  t: Dictionary;
  locale: Locale;
  read: ReferralRead<ReferralTerms>;
  signedIn?: boolean;
}) {
  const p = t.referral.page;
  const n = read.state === "ok" ? read.value : null;
  const changed = n ? utcDay(n.updatedAt) : null;
  const vars = n
    ? {
        credits: formatCredits(n.credits, locale),
        min: formatCredits(n.minCredits, locale),
        hold: n.holdDays,
        qualify: n.qualifyDays,
        cap: n.monthlyCap,
        daily: n.dailyCap,
        hourly: n.linkHourlyCap,
        days: n.newAccountDays,
      }
    : null;
  // Without the numbers, a sentence that carries one is left out rather than printed with a gap or a guess.
  const lines = (list: readonly string[]) => list.flatMap((line) => (/\{\w+\}/.test(line) ? (vars ? [fmt(line, vars)] : []) : [line]));
  const credits = `/${ALL_CHANNELS_SLUG}/credits#invite`;

  return (
    <article className="mx-auto w-full max-w-3xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12" data-referral-terms-page>
      <h1 className="t-hero">{p.title}</h1>
      <p className="t-lead mt-4">{p.lead}</p>
      <p className="mt-4 text-sm text-[var(--color-muted)]" data-referral-dated>
        {changed ? fmt(p.dated, { date: REFERRAL_TERMS_DATE, changed }) : fmt(p.datedOnly, { date: REFERRAL_TERMS_DATE })}
      </p>

      <p
        className="glass-card mt-6 rounded-2xl border border-[var(--color-border)] p-5 text-sm"
        role={n ? undefined : "status"}
        data-referral-status={read.state === "ok" ? (n?.enabled ? "open" : "closed") : read.state}
      >
        {read.state === "unsupported" ? p.unsupported : !n ? p.unknown : n.enabled ? p.open : p.closed}
      </p>

      {n && vars && (
        <section aria-labelledby="referral-numbers" className="mt-8">
          <h2 id="referral-numbers" className="text-[1.375rem] font-semibold tracking-[-0.015em]">
            {p.numbersTitle}
          </h2>
          <dl className="glass-card mt-4 grid gap-x-6 gap-y-3 rounded-2xl border border-[var(--color-border)] p-5 text-sm sm:grid-cols-2" data-referral-numbers>
            {[
              [p.reward, fmt(p.rewardValue, { n: vars.credits })],
              [p.minimum, fmt(p.minimumValue, { n: vars.min })],
              [p.hold, fmt(p.holdValue, { n: n.holdDays })],
              [p.window, fmt(p.windowValue, { n: n.qualifyDays })],
              [p.monthly, fmt(p.monthlyValue, { n: n.monthlyCap })],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1">
                <dt className="t-label">{label}</dt>
                <dd className="tnum">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <div className="mt-12 flex flex-col gap-12 text-[15px] font-light leading-relaxed text-[var(--color-fg)]">
        <Section id="how" title={p.howTitle}>
          <ol className="flex list-decimal flex-col gap-2 pl-5">
            {lines(p.how).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </Section>
        <Section id="limits" title={p.limitsTitle}>
          <ul className="flex list-disc flex-col gap-2 pl-5">
            {lines(p.limits).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Section>
        <Section id="not" title={p.notTitle}>
          <ul className="flex list-disc flex-col gap-2 pl-5">
            {lines(p.not).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Section>
        <Section id="refund" title={p.refundTitle}>
          <p>{p.refund}</p>
        </Section>
        <Section id="receive" title={p.receiveTitle}>
          <p>{p.receive}</p>
          <p>{p.noIncome}</p>
        </Section>
        <Section id="changes" title={p.changesTitle}>
          <p>{p.changes}</p>
        </Section>
      </div>

      {read.state !== "unsupported" && (
        <div className="mt-12 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {/* Signed out, the page links only public routes; the Credits page is the signed-in person's own. */}
          <Link href={signedIn ? credits : "/signup"} className="st-key inline-flex min-h-12 items-center justify-center gap-2">
            {signedIn ? p.ctaCredits : p.ctaSignedOut}
            <ArrowRight aria-hidden />
          </Link>
        </div>
      )}
    </article>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6">
      <h2 id={`${id}-title`} className="text-[1.375rem] font-semibold tracking-[-0.015em]">
        {title}
      </h2>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}
