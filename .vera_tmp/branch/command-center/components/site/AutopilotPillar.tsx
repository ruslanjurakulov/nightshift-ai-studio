import "./autopilot-pillar.css";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, CircleHelp, Lock, ShieldCheck, Volume2 } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { creditUnit, formatCredits } from "@/lib/credits";
import { defaultLanguage } from "@/lib/home";
import type { CreditRates } from "@/lib/pricing";
import type { FaqEntry } from "@/lib/studio-page";
import { DEMO_SCRIPT, SCRIPT_FILE } from "@/lib/site/autopilot-artifacts";
import { APPROVAL_HOURS, PILLAR_STAGES } from "@/lib/site/autopilot-pillar";
import { Slug } from "@/components/site/Slug";
import { AutopilotComposer } from "@/components/site/AutopilotComposer";
import { MotionToggle } from "@/components/site/MotionToggle";

/**
 * The YouTube Autopilot pillar: the parts of /solutions/youtube-channels that explain the operator end to end. The Solutions
 * page around it (components/site/SolutionView.tsx) keeps its own lists (what it does, what it will not do, where to start).
 *
 * Every artifact shown is the repository's sample script (samples/demo_script.json, held word for word to the file by
 * tests/autopilot-demo.test.tsx), labelled as such; the only number that is not from a file is the published per-minute rate,
 * read by the page from public_video_rates() and left out ("not published") when it cannot be read. Nothing here spends: the
 * composer is a link that fills the run form (components/site/AutopilotComposer.tsx).
 */

/** Where the landing's walk-through of the same stages lives, with a real file for each one (components/site/AutopilotDemo.tsx). */
export const STAGE_FILES_HREF = "/#autopilot";
/** YouTube Help, "YouTube channel monetization policies" (inauthentic content, renamed from repetitious content in July 2025). */
export const YT_MONETIZATION_URL = "https://support.google.com/youtube/answer/1311392";
/** YouTube Help, "Disclosing use of altered or synthetic content" (docs/AI_DISCLOSURE.md, read 2026-10-19). */
export const YT_DISCLOSURE_URL = "https://support.google.com/youtube/answer/14328491";

type Pillar = Dictionary["site"]["autopilot"]["pillar"];
type Breadcrumb = { label: string; current: string };

export function PillarHero({ t, locale, crumb }: { t: Dictionary; locale: Locale; crumb: Breadcrumb }) {
  const p = t.site.autopilot.pillar;
  return (
    <section aria-labelledby="solution-title" className="st-wrap st-hero nx-pl-hero">
      <div>
        <nav aria-label={t.site.solutions.breadcrumb} className="st-kicker flex flex-wrap items-center gap-2">
          <Link
            href="/solutions"
            className="inline-flex min-h-11 min-w-11 items-center underline decoration-[var(--ns-rule-strong)] underline-offset-4 hover:text-[var(--ns-text)]"
          >
            {crumb.label}
          </Link>
          <span aria-hidden>/</span>
          <span aria-current="page">{crumb.current}</span>
        </nav>
        <p className="nx-pl-kicker">{p.hero.kicker}</p>
        <h1 id="solution-title" className="st-h1-page mt-3">
          {p.hero.title}
        </h1>
        <p className="st-lead mt-6">{p.hero.lead}</p>
        <AutopilotComposer copy={p.composer} language={defaultLanguage(locale)} />
        <MotionToggle pause={t.site.fx.pause} />
      </div>
      <SampleCard p={p} />
    </section>
  );
}

/** The sample script, as the script stage writes it: topic, the two titles, the opening line and the planned sections. */
function SampleCard({ p }: { p: Pillar }) {
  const s = p.sample;
  return (
    <figure className="nx-pl-sample" aria-labelledby="pl-sample-title">
      <figcaption className="nx-pl-sample-head">
        <span className="nx-pl-sample-label">{s.label}</span>
        <span className="nx-pl-tag">{s.tag}</span>
      </figcaption>
      <dl className="nx-pl-sample-rows">
        <div>
          <dt>{s.topic}</dt>
          <dd id="pl-sample-title" lang="en">
            {DEMO_SCRIPT.topic}
          </dd>
        </div>
        <div>
          <dt>{s.titleA}</dt>
          <dd lang="en">{DEMO_SCRIPT.title}</dd>
        </div>
        <div>
          <dt>{s.titleB}</dt>
          <dd lang="en">{DEMO_SCRIPT.titleAb}</dd>
        </div>
        <div>
          <dt>{s.hook}</dt>
          <dd lang="en">{DEMO_SCRIPT.hookSentence}</dd>
        </div>
      </dl>
      <p className="nx-pl-sample-sub">{s.sections}</p>
      <ol className="nx-pl-sections">
        {DEMO_SCRIPT.sections.map((sec) => (
          <li key={sec.name}>
            <code lang="en">{sec.name}</code>
            <span>{fmt(s.seconds, { n: sec.durationHint })}</span>
          </li>
        ))}
      </ol>
      <p className="nx-pl-source">
        {s.source} <code>{SCRIPT_FILE}</code>. {s.note}
      </p>
      <Link href={STAGE_FILES_HREF} className="st-link">
        {s.more}
        <ArrowRight aria-hidden />
      </Link>
    </figure>
  );
}

/** The run's price line: the published per-minute rate, or that none is published. Never a default. */
function priceLines(p: Pillar, t: Dictionary, locale: Locale, rates: CreditRates | null): string[] {
  const st = p.stages;
  if (!rates || rates.perMinute === null || rates.perMinute <= 0) return [st.priceUnknown];
  const unit = (n: number) => creditUnit(n, locale, t.shell.creditUnit);
  const lines = [fmt(st.price, { n: formatCredits(rates.perMinute, locale), unit: unit(rates.perMinute) })];
  if (rates.jobMinimum !== null && rates.jobMinimum > 0) lines.push(fmt(st.minimum, { n: formatCredits(rates.jobMinimum, locale), unit: unit(rates.jobMinimum) }));
  return lines;
}

export function PillarStages({ t, locale, rates }: { t: Dictionary; locale: Locale; rates: CreditRates | null }) {
  const st = t.site.autopilot.pillar.stages;
  const lines = priceLines(t.site.autopilot.pillar, t, locale, rates);
  return (
    <section id="stages" aria-labelledby="stages-title" className="st-section" data-size="sm">
      <div className="st-wrap">
        <Slug>{st.slug}</Slug>
        <h2 id="stages-title" className="st-h2 mt-6">
          {st.title}
        </h2>
        <p className="st-lead mt-4">{st.lead}</p>
        <div className="nx-pl-price" data-known={rates?.perMinute ? "true" : "false"}>
          {lines.map((l) => (
            <p key={l} className="nx-pl-price-main">
              {l}
            </p>
          ))}
          <p className="nx-pl-price-sub">{st.refund}</p>
        </div>
        <ol className="nx-pl-stages">
          {PILLAR_STAGES.map((stage, i) => {
            const copy = st.items.find((x) => x.id === stage.id)!;
            return (
              <li key={stage.id} className="nx-pl-stage" data-stage={stage.id} data-paid={stage.paid ? "true" : "false"}>
                <span className="nx-pl-stage-no" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="nx-pl-stage-body">
                  <h3 className="st-h3">{copy.name}</h3>
                  <p className="st-body">{copy.does}</p>
                  <p className="nx-pl-cost">
                    <span className="nx-pl-cost-label">{st.costLabel}:</span> {stage.paid ? st.inPrice : st.noCharge}
                    {stage.meters && <> {fmt(st.measures, { what: st.ledger[stage.meters] })}</>}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
        <Link href={STAGE_FILES_HREF} className="st-link mt-8">
          {st.more}
          <ArrowRight aria-hidden />
        </Link>
      </div>
    </section>
  );
}

export function PillarControl({ t }: { t: Dictionary }) {
  const c = t.site.autopilot.pillar.control;
  return (
    <section id="control" aria-labelledby="control-title" className="st-section" data-tone="raised">
      <div className="st-wrap">
        <Slug>{c.slug}</Slug>
        <h2 id="control-title" className="st-h2 mt-6">
          {c.title}
        </h2>
        <p className="st-lead mt-4">{c.lead}</p>

        <div className="nx-pl-flow">
          <ol className="nx-pl-flow-steps" aria-label={c.diagram}>
            {c.steps.map((s, i) => (
              <li key={s.id} className="nx-pl-flow-step" data-step={s.id}>
                <span className="nx-pl-flow-state">
                  {s.id === "public" ? <ArrowUpRight aria-hidden /> : s.id === "check" ? <ShieldCheck aria-hidden /> : <Lock aria-hidden />}
                  {s.state}
                </span>
                <h3 className="st-h3">
                  <span className="nx-pl-flow-no" aria-hidden>
                    {i + 1}
                  </span>
                  {s.title}
                </h3>
                <p className="st-body">{fmt(s.body, { hours: APPROVAL_HOURS })}</p>
              </li>
            ))}
          </ol>
          <div className="nx-pl-branch">
            <h3 className="st-h3">{c.branch.title}</h3>
            <ol>
              {c.branch.items.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          </div>
        </div>

        <div className="nx-pl-rules">
          <div className="nx-pl-rule">
            <Volume2 aria-hidden />
            <h3 className="st-h3">{c.fallback.title}</h3>
            <p className="st-body">{c.fallback.body}</p>
          </div>
          <div className="nx-pl-rule">
            <CircleHelp aria-hidden />
            <h3 className="st-h3">{c.unknown.title}</h3>
            <ul>
              {c.unknown.items.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Where each answer points, beside it (never inside it: the structured answer is the plain text, lib/studio-page faqPageJsonLd). */
function faqLinks(id: string, f: Pillar["faq"]): { href: string; label: string; external: boolean }[] {
  if (id === "monetize")
    return [
      { href: YT_MONETIZATION_URL, label: f.links.monetization, external: true },
      { href: YT_DISCLOSURE_URL, label: f.links.disclosure, external: true },
    ];
  if (id === "disclosure") return [{ href: YT_DISCLOSURE_URL, label: f.links.disclosure, external: true }];
  if (id === "fails") return [{ href: "/terms#credits", label: f.links.terms, external: false }];
  return [];
}

/** The questions exactly as the page prints them, for the FAQPage structured data. */
export function pillarFaqEntries(t: Dictionary): FaqEntry[] {
  return t.site.autopilot.pillar.faq.items.map((i) => ({ id: i.id, q: i.q, a: i.a }));
}

export function PillarFaq({ t }: { t: Dictionary }) {
  const f = t.site.autopilot.pillar.faq;
  return (
    <section id="faq" aria-labelledby="pl-faq-title" className="st-section" data-tone="raised">
      <div className="st-wrap grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
        <div>
          <Slug>{f.slug}</Slug>
          <h2 id="pl-faq-title" className="st-h2 mt-6">
            {f.title}
          </h2>
        </div>
        {/* The landing's FAQ markup (components/landing/Faq.tsx FaqList), with room for two links under one answer. */}
        <div className="st-faq">
          {f.items.map((item, i) => {
            const links = faqLinks(item.id, f);
            return (
              <details key={item.id} open={i === 0}>
                <summary>
                  <h3>{item.q}</h3>
                  <span className="st-faq-mark" aria-hidden />
                </summary>
                <div className="st-faq-body">
                  <p className="st-body">{item.a}</p>
                  {links.length > 0 && (
                    <ul className="nx-pl-faq-links" aria-label={links[0].external ? f.sources : undefined}>
                      {links.map((l) =>
                        l.external ? (
                          <li key={l.href}>
                            <a href={l.href} className="st-link" target="_blank" rel="noopener noreferrer">
                              {l.label}
                              <ArrowUpRight aria-hidden />
                            </a>
                          </li>
                        ) : (
                          <li key={l.href}>
                            <Link href={l.href} className="st-link">
                              {l.label}
                              <ArrowRight aria-hidden />
                            </Link>
                          </li>
                        ),
                      )}
                    </ul>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </div>
    </section>
  );
}
