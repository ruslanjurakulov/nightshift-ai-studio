import Link from "next/link";
import { ArrowRight, X } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import type { SolutionId } from "@/lib/solutions";
import { Slug } from "@/components/site/Slug";
import { Rundown } from "@/components/site/Rundown";
import { ApiPicture, ComposerPicture } from "@/components/site/SolutionPictures";
import { SolutionRows } from "@/components/landing/Landing";

type Page = Dictionary["site"]["solutions"]["pages"][number];

/**
 * One Solutions page: who it is for, what the product does for them, what it
 * will not do (said as plainly as the rest — those are the product's rules),
 * where to start, and the other ways in. The picture is the product's own
 * state for that job: the rundown for channels, the composer for the Studio,
 * the endpoint list for developers.
 */
export function SolutionView({ t, id, page }: { t: Dictionary; id: SolutionId; page: Page }) {
  const s = t.site.solutions;
  const others = s.pages.filter((p) => p.id !== id);
  const docs = "docs" in page ? page.docs : null;
  return (
    <>
      <section aria-labelledby="solution-title" className="st-wrap st-hero">
        <div>
          <nav aria-label={s.breadcrumb} className="st-kicker flex flex-wrap items-center gap-2">
            <Link href="/solutions" className="underline decoration-[var(--ns-rule-strong)] underline-offset-4 hover:text-[var(--ns-text)]">
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
        </div>
        {id === "youtube-channels" ? <Rundown t={t} /> : id === "creative-studio" ? <ComposerPicture t={t} /> : <ApiPicture t={t} />}
      </section>

      <section aria-labelledby="what-title" className="st-section" data-size="sm">
        <div className="st-wrap">
          <Slug>{s.whatLabel}</Slug>
          <h2 id="what-title" className="sr-only">
            {s.whatLabel}
          </h2>
          <ul className="mt-10 grid gap-x-10 md:grid-cols-2 lg:grid-cols-3">
            {page.what.map((w) => (
              <li key={w.title} className="flex flex-col gap-2 border-t border-[var(--ns-rule)] py-6">
                <h3 className="st-h3">{w.title}</h3>
                <p className="st-body">{w.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="not-title" className="st-section" data-size="sm">
        <div className="st-wrap grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
          <h2 id="not-title" className="st-h2">
            {s.notLabel}
          </h2>
          <ul className="flex flex-col border-t border-[var(--ns-rule-strong)]">
            {page.not.map((line) => (
              <li key={line} className="flex items-start gap-4 border-b border-[var(--ns-rule)] py-5">
                <span className="grid size-8 shrink-0 place-items-center rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)]">
                  <X className="size-4" aria-hidden />
                </span>
                <p className="pt-1 text-[16.5px] leading-relaxed">{line}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="start-title" className="st-section" data-size="sm">
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
                <h3 className="st-step-title">{step}</h3>
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

      <section aria-labelledby="others-title" className="st-section" data-size="sm">
        <div className="st-wrap">
          <Slug>{s.others}</Slug>
          <h2 id="others-title" className="sr-only">
            {s.others}
          </h2>
          <SolutionRows pages={others} />
        </div>
      </section>
    </>
  );
}

