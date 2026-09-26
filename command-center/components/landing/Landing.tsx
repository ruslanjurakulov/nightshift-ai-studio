import Link from "next/link";
import { ArrowRight, Check, Clapperboard, FileText, Lock, Mic, ShieldCheck } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";

/**
 * The signed-out homepage. Besides introducing the product it is the page
 * Google's OAuth reviewers read to learn what the app does and why it asks for
 * YouTube access — so it says plainly what is uploaded, that uploads are
 * private by default, and links the Privacy Policy and Google's own
 * permission page.
 *
 * A Server Component with no client JavaScript of its own; the only
 * interactive parts are the shared theme and language controls in the shell.
 */
export function Landing({ t }: { t: Dictionary }) {
  const l = t.landing;
  const features = [
    { icon: FileText, title: l.f1Title, body: l.f1Body },
    { icon: Mic, title: l.f2Title, body: l.f2Body },
    { icon: Clapperboard, title: l.f3Title, body: l.f3Body },
    { icon: ShieldCheck, title: l.f4Title, body: l.f4Body },
  ];
  const steps = [
    { title: l.s1Title, body: l.s1Body },
    { title: l.s2Title, body: l.s2Body },
    { title: l.s3Title, body: l.s3Body },
    { title: l.s4Title, body: l.s4Body },
  ];
  // A picture of what one run does, not a report of one: stage names only, no
  // figures, so nothing here can be mistaken for a measurement.
  const stages = [l.f1Title, l.f2Title, l.f3Title, l.pipeUpload];

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-24 px-4 pb-20 pt-10 sm:px-6 sm:pt-16 lg:gap-32">
      <section className="grid items-center gap-12 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="page-rise">
          <div className="t-label text-[var(--color-primary)]">{l.eyebrow}</div>
          <h1
            className="mt-5 font-display font-semibold tracking-[-0.03em]"
            style={{ fontSize: "clamp(2.5rem, 6vw, 72px)", lineHeight: 1.02, textWrap: "balance" }}
          >
            {l.title}
          </h1>
          <p className="t-lead mt-6">{l.lead}</p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link href="/login" className="btn-sky is-solid pill px-6 py-3 text-sm">
              {t.auth.signIn}
              <ArrowRight className="btn-arrow size-4" aria-hidden />
            </Link>
            <a href="#how" className="btn-sky ghost pill px-6 py-3 text-sm">
              {l.howLink}
            </a>
          </div>
          <p className="mt-4 text-[13px] font-light text-[var(--color-muted)]">{l.invite}</p>
        </div>

        <figure
          aria-label={l.pipeLabel}
          className="glass-card relative rounded-[22px] border border-[var(--color-border)] p-6 sm:p-7"
        >
          <figcaption className="t-label">{l.pipeLabel}</figcaption>
          <ol className="mt-5 flex flex-col">
            {stages.map((stage, i) => (
              <li key={stage} className="relative flex items-center gap-4 py-3">
                {/* The rail between stages: a dashed line that flows downwards. */}
                {i < stages.length - 1 && (
                  <svg className="absolute left-[15px] top-[42px] h-[calc(100%-24px)] w-[2px]" aria-hidden>
                    <line x1="1" y1="0" x2="1" y2="100%" stroke="var(--color-primary)" strokeOpacity="0.45" strokeWidth="2" className="flow-line" />
                  </svg>
                )}
                <span className="grid size-8 shrink-0 place-items-center rounded-full border border-[var(--color-primary)] text-[var(--color-primary)]">
                  <Check className="size-4" aria-hidden />
                </span>
                <span className="text-[15px] font-medium">{stage}</span>
              </li>
            ))}
            <li className="relative mt-2 flex items-center gap-4 rounded-2xl border border-dashed border-[var(--color-primary)] px-3 py-3">
              <span className="glow-dot pulse ml-[9px] size-2.5 shrink-0 rounded-full bg-[var(--color-primary)]" aria-hidden />
              <span className="text-[15px] font-medium text-[var(--color-primary)]">{l.pipeReview}</span>
            </li>
          </ol>
        </figure>
      </section>

      <section aria-labelledby="what">
        <h2 id="what" className="t-section">{l.whatTitle}</h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map(({ icon: Icon, title, body }) => (
            <div key={title} className="panel flex flex-col gap-3 p-6">
              <Icon className="size-5 text-[var(--color-primary)]" aria-hidden />
              <h3 className="t-panel">{title}</h3>
              <p className="text-[14px] font-light leading-relaxed text-[var(--color-muted)]">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" aria-labelledby="how-title" className="scroll-mt-8">
        <h2 id="how-title" className="t-section">{l.howTitle}</h2>
        <ol className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-5">
              <span className="mono text-[13px] text-[var(--color-primary)]">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="t-panel">{s.title}</h3>
              <p className="text-[14px] font-light leading-relaxed text-[var(--color-muted)]">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section
        aria-labelledby="data-title"
        className="glass-card grid gap-6 rounded-[22px] border border-[var(--color-border)] p-6 sm:p-10 lg:grid-cols-[auto_1fr]"
      >
        <span className="grid size-12 place-items-center rounded-2xl border border-[var(--color-primary)] text-[var(--color-primary)]">
          <Lock className="size-5" aria-hidden />
        </span>
        <div>
          <h2 id="data-title" className="text-[1.625rem] font-semibold tracking-[-0.02em]">{l.dataTitle}</h2>
          <p className="t-lead mt-4">{l.dataBody}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/privacy" className="btn-sky pill px-5 py-2.5 text-sm">
              {l.dataPrivacy}
            </Link>
            <a
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-sky ghost pill px-5 py-2.5 text-sm"
            >
              {l.dataRevoke}
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
