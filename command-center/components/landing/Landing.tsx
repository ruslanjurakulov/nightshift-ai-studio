import Link from "next/link";
import { ArrowRight, ArrowUpRight, Lock } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import type { MoneyAnchor, PricingTeaser as PricingTeaserData, ShowcaseItem } from "@/lib/landing";
import { WELCOME_CREDITS } from "@/lib/pricing";
import { formatCredits } from "@/lib/credits";
import { isSolutionId, solutionHref } from "@/lib/solutions";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { Rundown } from "@/components/site/Rundown";
import { EditorPicture } from "@/components/site/EditorPicture";
import { Slug } from "@/components/site/Slug";
import { Showcase } from "@/components/landing/Showcase";
import { PricingTeaser } from "@/components/landing/PricingTeaser";
import { Faq } from "@/components/landing/Faq";

const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";


/** Each rule's state, as the app would show it on its lamp. */
const RULE_TONE: Record<string, LampTone> = { price: "ok", refund: "ok", approval: "run" };

/**
 * The signed-out homepage, drawn as the control room at 03:00 (IDENTITY.md).
 *
 * It leads with the product's promise and its proof in one frame: the headline
 * on the left, and on the right a rundown of one video with the only lit lamp
 * on the page — the approval waiting for its person. Then the three rules the
 * product enforces, how a video moves, the Studio, channels and languages, the
 * Solutions, the money, the questions to settle before paying, and the Google
 * data statement OAuth reviewers read.
 *
 * Every claim on it is one the code backs; the only figures are the welcome
 * grant (WELCOME_CREDITS, pinned to the database by a test) and whatever the
 * pricing source holds. No competitor and no AI provider is named, and there
 * are no testimonials, logos or usage numbers, because there are none to show.
 *
 * A Server Component. The only client code on the page is the header's menu
 * and its theme and language keys; the one animation is the waiting lamp.
 */
export function Landing({
  t,
  locale,
  pricing,
  anchor,
  showcase,
}: {
  t: Dictionary;
  locale: Locale;
  pricing: PricingTeaserData;
  /** The money a visitor can know before signing up (lib/landing.ts moneyAnchor). */
  anchor: MoneyAnchor;
  showcase: ShowcaseItem[];
}) {
  return (
    <div className="lp-root">
      <Hero t={t} locale={locale} />
      <Rules t={t} />
      <How t={t} />
      <Studio t={t} />
      <Desk t={t} locale={locale} />
      {showcase.length > 0 && (
        <div className="st-section">
          <div className="st-wrap">
            <Showcase t={t} items={showcase} hour="02:00" />
          </div>
        </div>
      )}
      <SolutionsTeaser t={t} />
      <PricingTeaser t={t} locale={locale} teaser={pricing} anchor={anchor} />
      <Faq t={t} plansOnSale={pricing.kind === "plans"} aside={<GoogleData t={t} />} />
      <FinalCta t={t} />
    </div>
  );
}

function Hero({ t, locale }: { t: Dictionary; locale: Locale }) {
  const h = t.site.hero;
  return (
    <section aria-labelledby="hero-title" className="st-wrap st-hero">
      <div>
        <p className="st-kicker">{h.kicker}</p>
        <h1 id="hero-title" className="st-h1 mt-5">
          {h.titleA} <span className="st-h1-b">{h.titleB}</span>
        </h1>
        <p className="st-lead mt-7">{h.lead}</p>
        <div className="st-hero-actions">
          <Link href="/signup" className="st-key">
            {h.cta}
            <ArrowRight aria-hidden />
          </Link>
          <Link href="/pricing" className="st-link">
            {h.secondary}
          </Link>
        </div>
        <p className="st-hero-note">
          <span aria-hidden className="ns-lamp" data-tone="ok" />
          {fmt(h.note, { n: formatCredits(WELCOME_CREDITS, locale) })}
        </p>
      </div>
      <Rundown t={t} />
    </section>
  );
}

function Rules({ t }: { t: Dictionary }) {
  const r = t.site.rules;
  return (
    <section id="rules" aria-labelledby="rules-title" className="st-section">
      <div className="st-wrap">
        <Slug>{r.slug}</Slug>
        <h2 id="rules-title" className="st-h2 mt-8 max-w-[26ch]">
          {r.title}
        </h2>
        <ul className="st-rules">
          {r.items.map((item) => (
            <li key={item.id} className="st-rule">
              <StatusLamp tone={RULE_TONE[item.id] ?? "ok"} label={item.state} />
              <h3 className="st-h3">{item.title}</h3>
              <p className="st-body">{item.body}</p>
              <ol className="st-ledger" aria-label={item.title}>
                {item.lines.map((line, i) => {
                  const last = i === item.lines.length - 1;
                  // The refund ledger's middle line is the failure itself.
                  const tone: LampTone = item.id === "refund" && i === 1 ? "fail" : last && item.id === "approval" ? "run" : "ok";
                  return (
                    <li key={line}>
                      <span aria-hidden className="ns-lamp" data-tone={tone} />
                      {line}
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function How({ t }: { t: Dictionary }) {
  const h = t.site.how;
  return (
    // A band of its own: the one section on the console ground, without the
    // slug and hairline the others open with — the rundown read as a strip.
    <section id="how" aria-labelledby="how-title" className="st-section" data-band="true">
      <div className="st-wrap">
        <p className="st-kicker">{h.slug}</p>
        <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] lg:items-end">
          <h2 id="how-title" className="st-h2">
            {h.title}
          </h2>
          <p className="st-lead">{h.lead}</p>
        </div>
        <ol className="st-steps" aria-label={h.slug}>
          {h.steps.map((s, i) => (
            <li key={s.id} className="st-step">
              <span className="st-step-no st-num" aria-hidden>
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="st-step-title">{s.title}</h3>
              {s.id === "approval" && (
                <span className="st-step-lamp">
                  <StatusLamp tone="run" label={t.site.rundown.yours} />
                </span>
              )}
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Studio({ t }: { t: Dictionary }) {
  const s = t.site.studio;
  return (
    <section id="studio" aria-labelledby="studio-title" className="st-section">
      <div className="st-wrap">
        <Slug>{s.slug}</Slug>
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] lg:items-end">
          <h2 id="studio-title" className="st-h2">
            {s.title}
          </h2>
          <p className="st-lead">{s.lead}</p>
        </div>
        <div className="st-split">
          {/* The tools as a patch list, one ruled row each, read like the
              rundown: number, name, what it does, and how it is paid for. */}
          <ol className="st-patch" aria-label={s.slug}>
            {s.tools.map((tool, i) => {
              // The editor and the style library spend nothing; every other
              // tool is a generation, priced on its key before it runs.
              const free = tool.id === "editor" || tool.id === "styles";
              return (
                <li key={tool.id} className="st-patch-row">
                  <span className="st-patch-no st-num" aria-hidden>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="st-patch-name">{tool.title}</h3>
                  <p className="st-patch-body">{tool.body}</p>
                  {/* Priced is the rule (the lead says so), so only the exceptions
                      are marked on screen; a screen reader hears it on every row. */}
                  {free ? <span className="st-patch-cost">{s.free}</span> : <span className="sr-only">{s.priced}</span>}
                </li>
              );
            })}
          </ol>
          <EditorPicture t={t} />
        </div>
      </div>
    </section>
  );
}

function Desk({ t, locale }: { t: Dictionary; locale: Locale }) {
  const d = t.site.desk;
  const codes = ["uz", "ru", "en"] as const;
  return (
    // The one section that opens with its picture: on a wide screen the desk
    // sits on the left (CSS order), the words and the three languages beside
    // it. In the document the heading still comes first.
    <section id="channels" aria-labelledby="desk-title" className="st-section">
      <div className="st-wrap st-desk">
        <div className="st-desk-words">
          <p className="st-kicker">{d.slug}</p>
          <h2 id="desk-title" className="st-h2 mt-5">
            {d.title}
          </h2>
          <p className="st-lead mt-6">{d.lead}</p>
          <ul className="st-langs mt-8" aria-label={d.slug}>
            {d.languages.map((l, i) => (
              <li key={l} lang={codes[i]} aria-current={codes[i] === locale ? "true" : undefined}>
                {l}
                {codes[i] === locale && <span aria-hidden className="ns-lamp" data-tone="run" data-size="md" />}
              </li>
            ))}
          </ul>
        </div>
        <figure className="st-panel st-desk-figure">
          <div className="st-panel-head">
            <b aria-hidden>{d.cols.channel}</b>
            <span className="st-tag">{d.tag}</span>
          </div>
          <div className="st-table-wrap">
            <table className="st-table">
              <caption className="sr-only">{d.figure}</caption>
              <thead>
                <tr>
                  <th scope="col">{d.cols.channel}</th>
                  <th scope="col">{d.cols.language}</th>
                  <th scope="col" className="st-col-voice">
                    {d.cols.voice}
                  </th>
                  <th scope="col">{d.cols.autopublish}</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td>{row.language}</td>
                    <td className="st-col-voice text-[var(--ns-text-dim)]">{row.voice}</td>
                    <td>
                      <StatusLamp tone="idle" label={d.off} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </figure>
      </div>
    </section>
  );
}

function SolutionsTeaser({ t }: { t: Dictionary }) {
  const s = t.site.solutionsTeaser;
  return (
    <section id="solutions" aria-labelledby="solutions-title" className="st-section">
      <div className="st-wrap">
        <Slug>{s.slug}</Slug>
        <div className="mt-8 flex flex-wrap items-end justify-between gap-6">
          <h2 id="solutions-title" className="st-h2">
            {s.title}
          </h2>
          <Link href="/solutions" className="st-link">
            {s.more}
            <ArrowRight aria-hidden />
          </Link>
        </div>
        <SolutionRows pages={t.site.solutions.pages} />
      </div>
    </section>
  );
}

/** The solutions as full-width rows, each one link. Shared with /solutions. */
export function SolutionRows({ pages }: { pages: Dictionary["site"]["solutions"]["pages"] }) {
  return (
    <ul className="st-sol-list">
      {pages.map((p) =>
        isSolutionId(p.id) ? (
          <li key={p.id}>
            <Link href={solutionHref(p.id)} className="st-sol-row">
              <span className="st-kicker">{p.kicker}</span>
              <span className="st-sol-title">{p.title}</span>
              <span className="st-small">{p.lead}</span>
              <span className="st-sol-arrow" aria-hidden>
                <ArrowRight className="size-5" />
              </span>
            </Link>
          </li>
        ) : null,
      )}
    </ul>
  );
}

/** The Google data statement OAuth reviewers read: it sits in the FAQ's left
 *  column, under the questions' title, rather than as a section of its own. */
function GoogleData({ t }: { t: Dictionary }) {
  const d = t.landing.data;
  return (
    <aside id="google-data" aria-labelledby="data-title" className="st-data">
      <div className="flex items-start gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)]">
          <Lock className="size-5" aria-hidden />
        </span>
        <h2 id="data-title" className="st-h3 pt-2">
          {d.title}
        </h2>
      </div>
      <p className="st-body mt-4">{d.body}</p>
      <div className="mt-3 flex flex-wrap gap-x-6">
        <Link href="/privacy" className="st-link">
          {d.privacy}
        </Link>
        <a href={GOOGLE_PERMISSIONS} target="_blank" rel="noopener noreferrer" className="st-link">
          {d.revoke}
          <ArrowUpRight aria-hidden />
        </a>
      </div>
    </aside>
  );
}

function FinalCta({ t }: { t: Dictionary }) {
  const f = t.site.final;
  return (
    <section aria-labelledby="final-title" className="st-section">
      <div className="st-wrap grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:items-end">
        <h2 id="final-title" className="st-h1-page">
          {f.title}
        </h2>
        <div>
          <p className="st-lead">{f.lead}</p>
          <div className="st-hero-actions mt-7">
            <Link href="/signup" className="st-key">
              {f.cta}
              <ArrowRight aria-hidden />
            </Link>
            <Link href="/pricing" className="st-link">
              {t.site.hero.secondary}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
