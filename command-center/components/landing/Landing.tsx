import Link from "next/link";
import { ArrowRight, ArrowUpRight, Lock } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import type { MoneyAnchor, PricingTeaser as PricingTeaserData, ShowcaseItem } from "@/lib/landing";
import { WELCOME_CREDITS } from "@/lib/pricing";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";
import { packExpiry, type PackExpiry } from "@/lib/plans";
import { formatCredits } from "@/lib/credits";
import { isSolutionId, solutionHref } from "@/lib/solutions";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { Rundown } from "@/components/site/Rundown";
import { EditorPicture } from "@/components/site/EditorPicture";
import { Slug } from "@/components/site/Slug";
import { Showcase } from "@/components/landing/Showcase";
import { PricingTeaser } from "@/components/landing/PricingTeaser";
import { Faq } from "@/components/landing/Faq";
import reviewEnLight from "@/components/site/shots/review-en-light.webp";
import reviewEnDark from "@/components/site/shots/review-en-dark.webp";
import reviewRuLight from "@/components/site/shots/review-ru-light.webp";
import reviewRuDark from "@/components/site/shots/review-ru-dark.webp";
import reviewUzLight from "@/components/site/shots/review-uz-light.webp";
import reviewUzDark from "@/components/site/shots/review-uz-dark.webp";
import reviewEnLightPhone from "@/components/site/shots/review-en-light-phone.webp";
import reviewEnDarkPhone from "@/components/site/shots/review-en-dark-phone.webp";
import reviewRuLightPhone from "@/components/site/shots/review-ru-light-phone.webp";
import reviewRuDarkPhone from "@/components/site/shots/review-ru-dark-phone.webp";
import reviewUzLightPhone from "@/components/site/shots/review-uz-light-phone.webp";
import reviewUzDarkPhone from "@/components/site/shots/review-uz-dark-phone.webp";

type Shot = { src: string; width: number; height: number };
/** The video page of the real Command Center with a finished video waiting
 *  for approval — signed in, every value sample data — in each language: the
 *  desktop page, and the same panel as a phone shows it (a 1600px screen
 *  shrunk to a phone's width was unreadable). */
const REVIEW_SHOTS: Record<Locale, Record<"light" | "dark", { desk: Shot; phone: Shot }>> = {
  en: { light: { desk: reviewEnLight, phone: reviewEnLightPhone }, dark: { desk: reviewEnDark, phone: reviewEnDarkPhone } },
  ru: { light: { desk: reviewRuLight, phone: reviewRuLightPhone }, dark: { desk: reviewRuDark, phone: reviewRuDarkPhone } },
  uz: { light: { desk: reviewUzLight, phone: reviewUzLightPhone }, dark: { desk: reviewUzDark, phone: reviewUzDarkPhone } },
};

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
  expiry = packExpiry(null, CREDIT_EXPIRY_MONTHS),
}: {
  t: Dictionary;
  locale: Locale;
  pricing: PricingTeaserData;
  /** The money a visitor can know before signing up (lib/landing.ts moneyAnchor). */
  anchor: MoneyAnchor;
  showcase: ShowcaseItem[];
  /** How long top-up credits last (lib/plans.ts packExpiry): the catalog's policy, the env, or unknown. */
  expiry?: PackExpiry;
}) {
  return (
    <div className="lp-root">
      <Hero t={t} locale={locale} />
      <Rules t={t} />
      <How t={t} locale={locale} />
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
      <PricingTeaser t={t} locale={locale} teaser={pricing} anchor={anchor} expiry={expiry} />
      <Faq t={t} plansOnSale={pricing.kind === "plans"} expiry={expiry} aside={<GoogleData t={t} />} />
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

/** Where each step stands on the rail: done, the one waiting for its person, not yet. */
const HOW_STATE: Record<string, "done" | "yours" | "next"> = {
  channel: "done",
  topic: "done",
  script: "done",
  video: "done",
  approval: "yours",
  youtube: "next",
};

function How({ t, locale }: { t: Dictionary; locale: Locale }) {
  const h = t.site.how;
  const shot = REVIEW_SHOTS[locale] ?? REVIEW_SHOTS.en;
  return (
    // The one full-bleed band: a single heading line (no slug, no lede beside
    // a big title — the formula every other section opens with), then the six
    // steps as one strip ruled edge to edge with a rail on top, the way a
    // rundown reads across a wall. Step 05 is then shown on the real screen.
    <section id="how" aria-labelledby="how-title" className="st-section st-how" data-band="true">
      <div className="st-wrap st-how-head">
        <p className="st-kicker">{h.slug}</p>
        <h2 id="how-title" className="st-how-title">
          {h.title}
        </h2>
        <p className="st-small">{h.lead}</p>
      </div>
      <ol className="st-how-strip" aria-label={h.slug}>
        {h.steps.map((s, i) => (
          <li key={s.id} className="st-how-step" data-state={HOW_STATE[s.id] ?? "next"}>
            <span aria-hidden className="st-how-rail" />
            <span className="st-how-no st-num" aria-hidden>
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3 className="st-step-title">{s.title}</h3>
            {s.id === "approval" && <StatusLamp tone="run" label={t.site.rundown.yours} />}
            <p>{s.body}</p>
            {/* On a phone the steps are one column, so the screen of step 05
                sits in step 05 itself, before step 06 — not after the list. */}
            {s.id === "approval" && (
              <div className="st-how-shot-inline">
                <h4 className="st-h4">{h.shotTitle}</h4>
                <ReviewShot t={t} shot={shot} />
              </div>
            )}
          </li>
        ))}
      </ol>
      {/* Wider than a phone: the screen sits under the strip, as step 05's callout. */}
      <div className="st-wrap st-how-shot">
        <div>
          <p className="st-kicker">05 · {h.shotTag}</p>
          <h3 className="st-h3 mt-4">{h.shotTitle}</h3>
          <p className="st-body mt-4">{h.shotBody}</p>
        </div>
        <ReviewShot t={t} shot={shot} />
      </div>
    </section>
  );
}

/** The real page, photographed: light and dark, desktop and phone are
 *  separate captures; only the one matching the theme and the width is shown
 *  (the others, lazy and display:none, are never fetched). Served from
 *  /_next/static like any build asset. */
function ReviewShot({ t, shot }: { t: Dictionary; shot: (typeof REVIEW_SHOTS)[Locale] }) {
  const h = t.site.how;
  return (
    <figure className="st-shot">
      {(["light", "dark"] as const).flatMap((theme) =>
        (["desk", "phone"] as const).map((size) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${theme}-${size}`}
            src={shot[theme][size].src}
            width={shot[theme][size].width}
            height={shot[theme][size].height}
            alt={h.shotAlt}
            loading="lazy"
            decoding="async"
            data-shot-theme={theme}
            data-shot-size={size}
          />
        )),
      )}
      <figcaption>
        <span className="st-tag">{h.shotTag}</span>
        {h.shotCaption}
      </figcaption>
    </figure>
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
        </div>
        <div className="st-desk-figure">
          <figure className="st-panel">
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
          <ul className="st-langs mt-10" aria-label={d.slug}>
            {d.languages.map((l, i) => (
              // The page's own language reads in full ink, the other two dimmed;
              // no lamp: a lit amber dot here meant nothing the page explained.
              <li key={l} lang={codes[i]} aria-current={codes[i] === locale ? "true" : undefined}>
                {l}
              </li>
            ))}
          </ul>
        </div>
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
