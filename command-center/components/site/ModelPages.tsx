import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { modelLeftOut } from "@/lib/site/showcase";
import { tryHref } from "@/lib/site/showcase-link";
import { MODELS_PATH } from "@/lib/public-paths";
import {
  durationText,
  modelAvailability,
  resolutionText,
  type ModelFacts,
  type ModelPage,
  type ModelSample,
} from "@/lib/site/model-pages";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { ClipTapPause } from "@/components/site/ClipTapPause";
import "@/components/site/model-pages.css";

/**
 * The public model pages: /models (ModelIndexView) and /models/<slug> (ModelDetailView), in the landing's language (the nx-*
 * classes of components/site/site-next.css; model-pages.css only lays them out).
 *
 * What may be on them, and why (lib/site/model-pages.ts): a model is named because its own real samples are on the page; every
 * sample says "AI-generated" and names its model; nothing says the model is on sale, gives it a price or a speed. By the owner's
 * rule of 2026-11-13 no "Powered by" line or link to a maker is shown here (the credit stays in the signed-in Studio), and a clip
 * pauses by touch or a keyboard-only toggle (ClipTapPause), never a visible pause button.
 *
 * Every element that names a model is inside a box marked as that model's (data-showcase-entry on a sample, data-model-page on a
 * page), so tests/model-pages.test.tsx can hold the rest of the frame (header, footer) free of any model or maker name.
 */

/** The day a sample was made, in the page's language (UTC, so the server and every visitor read the same day). */
function madeOn(iso: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function shapeOf(e: { width: number; height: number }): "tall" | "wide" | "square" {
  return e.height > e.width * 1.15 ? "tall" : e.width > e.height * 1.15 ? "wide" : "square";
}

function Crumbs({ t, current }: { t: Dictionary; current: string | null }) {
  const c = t.site.modelPages.crumbs;
  return (
    <nav aria-label={c.label} className="ml-crumbs">
      <ol>
        <li>
          <Link href="/">{c.home}</Link>
        </li>
        <li>
          {current ? (
            <Link href={MODELS_PATH} prefetch={false}>
              {c.models}
            </Link>
          ) : (
            <span aria-current="page">{c.models}</span>
          )}
        </li>
        {current && (
          <li>
            <span aria-current="page">{current}</span>
          </li>
        )}
      </ol>
    </nav>
  );
}

/** A sample's picture (and its loop, for a clip), with the AI-generated badge on it. */
function SampleMedia({
  t,
  s,
  eager = false,
  sizes,
}: {
  t: Dictionary;
  s: ModelSample;
  eager?: boolean;
  sizes: string;
}) {
  const { e, f } = s;
  const g = t.site.gallery;
  const clip = e.kind === "video" && f.clip !== null;
  return (
    <div className="nx-gallery-pic ml-pic" data-clip={clip ? "sample" : undefined} style={{ aspectRatio: `${e.width} / ${e.height}` }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={f.poster}
        srcSet={`${f.posterSm} 640w, ${f.poster} 1280w`}
        sizes={sizes}
        width={e.width}
        height={e.height}
        alt={fmt(clip ? g.altClip : g.altImage, { model: e.modelName })}
        className="nx-art"
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : undefined}
        decoding="async"
      />
      {clip && <ShowcaseClip jobId={e.jobId} compact={!eager} early={eager} together={!eager} />}
      <span className="nx-result-badge" data-kind="ai">
        {g.badge}
      </span>
      {clip && <ClipTapPause label={t.site.fx.pause} />}
    </div>
  );
}

/**
 * One sample's words and its button: the model, the picture it was animated from (when that picture is one of our samples too),
 * the prompt, the day, and "Use this prompt" / "Try this prompt" (lib/site/showcase-link.ts), which only opens the Studio form.
 */
function SampleBody({
  t,
  locale,
  s,
  source,
  signedIn,
  now,
}: {
  t: Dictionary;
  locale: Locale;
  s: ModelSample;
  source: ModelSample | null;
  signedIn: boolean;
  now: Date;
}) {
  const { e } = s;
  const g = t.site.gallery;
  const href = tryHref(e, signedIn, now);
  const leftOut = modelLeftOut(e, now);
  const promptId = `sample-prompt-${e.jobId}`;
  return (
    <div className="nx-gallery-body">
      <p className="nx-gallery-model">
        <span className="nx-gallery-key">{g.model}</span> <strong>{e.modelName}</strong>
      </p>
      {source && (
        <figure className="nx-gallery-source" data-source-entry={source.e.jobId}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={source.f.posterSm}
            width={source.e.width}
            height={source.e.height}
            alt={fmt(g.altSource, { model: source.e.modelName })}
            loading="lazy"
            decoding="async"
          />
          <figcaption>
            <span className="nx-gallery-key">{g.source}</span> <strong>{source.e.modelName}</strong>
          </figcaption>
        </figure>
      )}
      <p className="nx-gallery-key">{g.prompt}</p>
      <p id={promptId} className="nx-gallery-prompt">
        {e.prompt.trim() ? e.prompt : g.noPrompt}
      </p>
      <p className="nx-gallery-date">
        <time dateTime={e.createdAt}>{fmt(g.made, { date: madeOn(e.createdAt, locale) })}</time>
      </p>
      {href && (
        // As on the explore cards: named by the model only where the link opens that model; otherwise "Use this prompt" and a note.
        <Link
          href={href}
          prefetch={false}
          className="nx-btn nx-gallery-try"
          aria-label={leftOut ? undefined : fmt(g.tryAria, { model: e.modelName })}
          aria-describedby={leftOut ? `${promptId} sample-use-${e.jobId}` : promptId}
        >
          {leftOut ? g.use : g.try}
          <ArrowRight aria-hidden />
        </Link>
      )}
      {href && leftOut && (
        <p id={`sample-use-${e.jobId}`} className="nx-gallery-use">
          {g.useNote}
        </p>
      )}
    </div>
  );
}

/** The picture a clip was animated from, when that picture is itself one of our samples (its own card names its model). */
function sourceOf(s: ModelSample, all: readonly ModelSample[]): ModelSample | null {
  const { e } = s;
  if (e.kind !== "video" || e.input.kind !== "operator_job") return null;
  const id = e.input.jobId;
  return all.find((x) => x.e.jobId === id) ?? null;
}

/** The availability line: not in it yet (operator preview), gone (shutdown day has come), or what the Studio shows (not known here). */
function availabilityLine(t: Dictionary, locale: Locale, f: ModelFacts, now: Date): string {
  const a = t.site.modelPages.availability;
  const state = modelAvailability(f, now);
  if (state === "preview") return a.preview;
  if (state === "shut_down") return fmt(a.gone, { date: madeOn(`${f.shutdownOn}T00:00:00Z`, locale) });
  return a.unknown;
}

/** "What it can do": only what the registry lists for our Studio; a row with nothing to say is left out, never filled. */
function Facts({ t, f }: { t: Dictionary; f: ModelFacts }) {
  const c = t.site.modelPages.can;
  const caps = t.site.modelPages.caps as Record<string, string>;
  const tools = f.capabilities.filter((k) => caps[k]);
  const byTool = Object.entries(f.aspectRatiosByCapability).filter(([k, r]) => caps[k] && f.capabilities.includes(k) && r.length > 0);
  const lengths = f.output === "video" ? durationText(f.durationsS, (min, max) => fmt(c.range, { min, max }), (n) => fmt(c.seconds, { n })) : null;
  const inputs = [c.words, ...(f.imageRefsMax > 0 && (f.capabilities.includes("i2v") || f.capabilities.includes("edit")) ? [c.picture] : []), ...(f.endFrame ? [c.endFrame] : [])];
  const rows: { k: string; v: React.ReactNode }[] = [
    { k: c.makes, v: f.output === "video" ? c.video : c.image },
    ...(tools.length ? [{ k: c.tools, v: tools.map((k) => caps[k]).join(", ") }] : []),
    ...(f.aspectRatios.length
      ? [
          {
            k: c.ratios,
            v: (
              <>
                {f.aspectRatios.join(", ")}
                {byTool.map(([k, r]) => (
                  <span key={k} className="ml-fact-note">
                    {fmt(c.ratiosFor, { tool: caps[k], ratios: r.join(", ") })}
                  </span>
                ))}
              </>
            ),
          },
        ]
      : []),
    ...(lengths ? [{ k: c.lengths, v: lengths }] : []),
    ...(f.resolutions.length ? [{ k: c.resolutions, v: f.resolutions.map(resolutionText).join(", ") }] : []),
    { k: c.inputs, v: inputs.join(", ") },
    ...(f.output === "video" ? [{ k: c.sound, v: f.audioOut ? c.soundYes : c.soundNo }] : []),
  ];
  return (
    <dl className="ml-facts">
      {rows.map((r) => (
        <div key={r.k} className="ml-fact">
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A model's tile on the index and under "Other models": its lead sample, name, kind, count and the way to its page. */
function ModelTile({ t, page, heading }: { t: Dictionary; page: ModelPage; heading: "h2" | "h3" }) {
  const x = t.site.modelPages.index;
  const g = t.site.gallery;
  const { e, f } = page.hero;
  const H = heading;
  return (
    <li className="ml-tile" data-showcase-entry={e.jobId} data-model={page.facts.id}>
      <div className="ml-tile-pic">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={f.posterSm}
          width={e.width}
          height={e.height}
          alt={fmt(e.kind === "video" ? g.altClip : g.altImage, { model: e.modelName })}
          loading="lazy"
          decoding="async"
        />
        <span className="nx-result-badge" data-kind="ai">
          {g.badge}
        </span>
      </div>
      <div className="ml-tile-body">
        <H className="ml-tile-name">{page.facts.name}</H>
        <p className="ml-tile-meta">
          {page.facts.output === "video" ? x.video : x.image} · {fmt(x.count, { n: String(page.samples.length) })}
        </p>
        <Link href={page.path} prefetch={false} className="nx-link" aria-label={fmt(x.openAria, { model: page.facts.name })}>
          {x.open}
          <ArrowRight aria-hidden />
        </Link>
      </div>
    </li>
  );
}

function FinalCta({ t }: { t: Dictionary }) {
  const c = t.site.modelPages.final;
  return (
    <section aria-labelledby="models-final-title" className="nx-section ml-final">
      <div className="nx-wrap">
        <h2 id="models-final-title" className="nx-h2">
          {c.title}
        </h2>
        <p className="nx-sub">{c.lead}</p>
        <div className="ml-actions">
          <Link href="/signup" className="nx-btn">
            {c.start}
            <ArrowRight aria-hidden />
          </Link>
          <Link href="/pricing" className="nx-link">
            {c.pricing}
          </Link>
        </div>
      </div>
    </section>
  );
}

/** /models: every model with a page, each as a tile. With none (no sample merged yet) it says so; it never shows a placeholder. */
export function ModelIndexView({ t, pages }: { t: Dictionary; pages: readonly ModelPage[] }) {
  const x = t.site.modelPages.index;
  return (
    <div className="ml-root">
      <section aria-labelledby="models-title" className="nx-section ml-head">
        <div className="nx-wrap">
          <Crumbs t={t} current={null} />
          <p className="nx-label">{x.label}</p>
          <h1 id="models-title" className="nx-h2 ml-h1">
            {x.title}
          </h1>
          <p className="nx-sub">{x.lead}</p>
          {pages.length === 0 ? (
            <p className="ml-empty">{x.empty}</p>
          ) : (
            <ul className="ml-tiles">
              {pages.map((p) => (
                <ModelTile key={p.slug} t={t} page={p} heading="h2" />
              ))}
            </ul>
          )}
        </div>
      </section>
      <FinalCta t={t} />
    </div>
  );
}

/** /models/<slug>: the model's lead sample, what it can do, its other samples, the other models and the way in. */
export function ModelDetailView({
  t,
  locale,
  page,
  pages,
  all,
  signedIn = false,
  now = new Date(),
}: {
  t: Dictionary;
  locale: Locale;
  page: ModelPage;
  /** Every model page, for "Other models". */
  pages: readonly ModelPage[];
  /** Every sample of every model, for a clip's source picture. */
  all: readonly ModelSample[];
  signedIn?: boolean;
  /** Today, for a shutdown day that has come (tests pass a fixed day). */
  now?: Date;
}) {
  const m = t.site.modelPages;
  const f = page.facts;
  const rest = page.samples.filter((s) => s.e.jobId !== page.hero.e.jobId);
  const others = pages.filter((p) => p.slug !== page.slug);
  const state = modelAvailability(f, now);
  const g = t.site.gallery;
  return (
    <div className="ml-root" data-model-page={f.id}>
      <section aria-labelledby="model-title" className="nx-section ml-head">
        <div className="nx-wrap">
          <Crumbs t={t} current={f.name} />
          <div className="ml-hero">
            <div className="ml-hero-copy">
              <p className="nx-label">{m.hero.label}</p>
              <h1 id="model-title" className="nx-h2 ml-h1">
                {f.name}
              </h1>
              <p className="nx-sub">{fmt(m.hero.lead, { model: f.name })}</p>
              <p className="ml-count">{fmt(m.hero.count, { n: String(page.samples.length) })}</p>
              <div className="ml-status" data-state={state}>
                <h2 className="ml-status-t">{m.availability.title}</h2>
                <p>{availabilityLine(t, locale, f, now)}</p>
              </div>
              <div className="ml-actions">
                <Link href="/signup" className="nx-btn">
                  {m.hero.start}
                  <ArrowRight aria-hidden />
                </Link>
                <Link href={MODELS_PATH} prefetch={false} className="nx-link">
                  {m.hero.allModels}
                </Link>
              </div>
            </div>
            <article className="nx-gallery-card ml-hero-card" data-showcase-entry={page.hero.e.jobId} data-model={f.id} data-shape={shapeOf(page.hero.e)}>
              <SampleMedia t={t} s={page.hero} eager sizes="(min-width: 1024px) 560px, 100vw" />
              <SampleBody t={t} locale={locale} s={page.hero} source={sourceOf(page.hero, all)} signedIn={signedIn} now={now} />
            </article>
          </div>
          {/* What every "Use this prompt" on the page does, said once, where the first one is. */}
          <p className="nx-show-note ml-try-note">{signedIn ? g.tryNote : g.tryNoteSignedOut}</p>
        </div>
      </section>

      <section aria-labelledby="model-can-title" className="nx-section" data-tone="raised">
        <div className="nx-wrap ml-can">
          <div>
            <h2 id="model-can-title" className="nx-h2">
              {m.can.title}
            </h2>
            <p className="nx-sub">{m.can.lead}</p>
          </div>
          <Facts t={t} f={f} />
          <div className="ml-price">
            <h3 className="ml-price-t">{m.price.title}</h3>
            {/* No public price exists per model (lib/site/model-pages.ts): a model not on sale has none, any other is priced in the Studio. */}
            <p>{state === "unknown" ? m.price.studio : m.price.none}</p>
            <Link href="/pricing" className="nx-link">
              {m.price.pricing}
            </Link>
          </div>
        </div>
      </section>

      {rest.length > 0 && (
        <section aria-labelledby="model-samples-title" className="nx-section">
          <div className="nx-wrap">
            <h2 id="model-samples-title" className="nx-h2">
              {fmt(m.samples.title, { model: f.name })}
            </h2>
            <p className="nx-sub">{m.samples.lead}</p>
            <ul className="nx-gallery">
              {rest.map((s) => (
                <li key={s.e.jobId} id={`sample-${s.e.jobId}`} className="nx-gallery-card" data-showcase-entry={s.e.jobId} data-model={f.id} data-shape={shapeOf(s.e)}>
                  <SampleMedia t={t} s={s} sizes="(min-width: 1024px) 400px, (min-width: 600px) 50vw, 100vw" />
                  <SampleBody t={t} locale={locale} s={s} source={sourceOf(s, all)} signedIn={signedIn} now={now} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {others.length > 0 && (
        <section aria-labelledby="model-more-title" className="nx-section" data-tone="raised">
          <div className="nx-wrap">
            <h2 id="model-more-title" className="nx-h2">
              {m.more.title}
            </h2>
            <p className="nx-sub">{m.more.lead}</p>
            <ul className="ml-tiles">
              {others.map((p) => (
                <ModelTile key={p.slug} t={t} page={p} heading="h3" />
              ))}
            </ul>
          </div>
        </section>
      )}
      <FinalCta t={t} />
    </div>
  );
}
