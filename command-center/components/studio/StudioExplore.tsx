"use client";

import Link from "next/link";
import { useId, useMemo, useRef, type CSSProperties, type ReactNode, type Ref } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { LOGIN_PATH } from "@/lib/public-paths";
import { templateCreateHref, type TemplateDto } from "@/lib/templates/trends";
import { TEMPLATE_ROWS, exploreTemplates, type ExploreSample, type OnSale, type TemplateRow } from "@/lib/creative/explore";
import { useTemplates } from "@/components/trends/useTemplates";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { LoopClip } from "@/components/site/LoopClip";
import { TapReveal } from "@/components/site/TapReveal";
import { AiMark } from "@/components/site/AiMark";
import "@/components/site/media-card.css";
import "@/components/studio/studio-explore.css";

/** A template's box shape from its aspect (0183's CHECK: one of three). */
const ASPECT: Record<TemplateDto["aspect"], [number, number]> = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1] };

/**
 * Below the fold of the Studio home: the shipped samples, then the trend templates in three rows (trending, videos by topic,
 * brand-style pictures), media first as on the landing (components/site/media-card.css, #935). At rest a card is its picture or
 * clip and the small "AI" mark; its title and one grey line show on hover, keyboard focus, or a first tap on a phone (TapReveal),
 * and the card is one link to this channel's Studio form with that prompt and model. No text, alt, aria or data attribute on a
 * card names a model: the model travels in the link alone, and the Studio says which model and price it will use.
 *
 * Nothing here writes. The samples arrive from the server already filtered to the models on sale to this workspace
 * (lib/creative/explore.ts exploreSamples); the templates are one read of /api/templates, kept to those whose model both the route
 * and the server's catalogue (`onSale`) call on sale. Loading, failed (with a retry), not switched on, session ended and "none on
 * sale" each say so and offer the way on; a row with nothing to show is not drawn, never filled with placeholders.
 */
export function StudioExplore({ samples, onSale }: { samples: readonly ExploreSample[]; onSale: OnSale }) {
  const { t, locale } = useI18n();
  const x = t.studioHome.explore;
  const g = t.site.gallery;
  const path = useChannelPath();
  const uid = useId();
  const noteId = `${uid}-note`;
  const formatsRef = useRef<HTMLHeadingElement>(null);
  const { state, retry } = useTemplates(locale);
  const rows = useMemo(() => (state.phase === "ok" ? exploreTemplates(state.templates, onSale) : null), [state, onSale]);
  const shownRows = rows ? TEMPLATE_ROWS.filter((r) => rows[r].length > 0) : [];

  const sampleCards = samples.map((s) => (
    <MediaCard
      key={s.id}
      id={`${uid}-s-${s.id}`}
      width={s.width}
      height={s.height}
      // eslint-disable-next-line @next/next/no-img-element -- the sample's own sized posters (640 and 1280 wide), as the landing's grid draws them.
      poster={<img src={s.poster} srcSet={s.srcSet} sizes="(min-width: 1280px) 420px, (min-width: 768px) 45vw, 90vw" width={s.width} height={s.height} alt={s.clip ? g.bgClip : g.bgImage} className="sx-art" loading="lazy" decoding="async" />}
      clip={s.clip ? <ShowcaseClip jobId={s.id} together /> : null}
      title={s.title}
      line={s.line}
      href={path(s.href)}
      action={x.use}
      noteId={noteId}
      badge={{ short: g.badge, name: g.badgeName }}
      kind="sample"
    />
  ));

  const templateCards = (list: readonly TemplateDto[]) =>
    list.map((tpl) => {
      const [w, h] = ASPECT[tpl.aspect];
      return (
        <MediaCard
          key={tpl.slug}
          id={`${uid}-t-${tpl.slug}`}
          width={w}
          height={h}
          poster={
            // eslint-disable-next-line @next/next/no-img-element -- a static poster under /public/templates, already sized; nothing for next/image to do.
            <img src={tpl.poster_url} alt={tpl.preview_url ? g.bgClip : g.bgImage} className="sx-art" loading="lazy" decoding="async" />
          }
          clip={tpl.preview_url && tpl.poster_url ? <LoopClip sources={{ mp4: tpl.preview_url, smMp4: tpl.preview_url }} poster={tpl.poster_url} together /> : null}
          title={tpl.title}
          line={{ text: tpl.description, lang: locale }}
          href={path(templateCreateHref(tpl.slug))}
          action={x.useTemplate}
          noteId={noteId}
          badge={{ short: g.badge, name: g.badgeName }}
          kind="template"
        />
      );
    });

  const head = (id: string, title: string, more: boolean, ref?: Ref<HTMLHeadingElement>) => (
    <div className="sx-head">
      <h2 id={id} ref={ref} tabIndex={ref ? -1 : undefined} className="sx-h2">
        {title}
      </h2>
      {more && (
        <Link href={path("/trends")} className="tap-link sx-more">
          {x.seeAll}
        </Link>
      )}
    </div>
  );

  // The formats' states other than "some to show": one heading and one line, each with its way on.
  let formats: ReactNode = null;
  if (state.phase === "loading") {
    formats = (
      <section className="sx-row" aria-labelledby={`${uid}-formats`} data-testid="explore-loading">
        {head(`${uid}-formats`, x.formats, false)}
        {/* Outside the busy part: a screen reader holds back what is inside an aria-busy region, the "loading" too. */}
        <p className="sr-only" role="status">
          {x.loading}
        </p>
        <ul className="sx-grid" data-row="topics" aria-busy="true" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="sx-card sx-skel skeleton" style={{ "--ar": 9 / 16 } as CSSProperties} />
          ))}
        </ul>
      </section>
    );
  } else if (state.phase !== "ok") {
    const [line, action] =
      state.phase === "error"
        ? [x.error, <button key="r" type="button" className="btn-quiet tap" onClick={() => { retry(); formatsRef.current?.focus(); }} data-testid="explore-retry">{x.retry}</button>]
        : state.phase === "not_enabled"
          ? [x.notEnabled, <Link key="a" href={path("/trends")} className="tap-link sx-more">{x.seeAll}</Link>]
          : [x.signedOut, <Link key="s" href={LOGIN_PATH} className="tap-link sx-more">{x.signIn}</Link>];
    formats = (
      <section className="sx-row" aria-labelledby={`${uid}-formats`} data-testid={`explore-${state.phase}`}>
        {head(`${uid}-formats`, x.formats, false, formatsRef)}
        <div className="sx-state" role={state.phase === "error" ? "alert" : undefined}>
          <p>{line}</p>
          {action}
        </div>
      </section>
    );
  } else if (shownRows.length === 0 && samples.length === 0) {
    // Nothing on sale here has an example yet (Atlas, 27 Nov: the strict rule stays, no previews, no placeholders). One honest
    // line, and the way on is the box at the top of this page (id="prompt" on both the Studio home and the Create screen).
    formats = (
      <section className="sx-row" aria-labelledby={`${uid}-soon`} data-testid="explore-empty">
        {head(`${uid}-soon`, x.soonTitle, false)}
        <div className="sx-state">
          <p>{x.soon}</p>
          <a href="#prompt" className="tap-link sx-more">
            {x.soonAction}
          </a>
        </div>
      </section>
    );
  }
  // Samples on sale but no format: the format rows are simply not drawn (a row with nothing in it is never drawn).

  return (
    <section className="sx" aria-label={x.label} data-testid="studio-explore">
      {samples.length > 0 && (
        <section className="sx-row" aria-labelledby={`${uid}-samples`} data-row="samples">
          {head(`${uid}-samples`, x.samples, false)}
          <ul className="sx-grid" data-row="samples">
            {sampleCards}
          </ul>
        </section>
      )}
      {formats}
      {rows &&
        shownRows.map((r: TemplateRow, i) => (
          <section key={r} className="sx-row" aria-labelledby={`${uid}-${r}`} data-row={r}>
            {head(`${uid}-${r}`, x[r], i === 0)}
            <ul className="sx-grid" data-row={r}>
              {templateCards(rows[r])}
            </ul>
          </section>
        ))}
      {/* Said once for every card, not under each one, and only under cards: what a card does, and that nothing starts until the Studio's own key. */}
      {(samples.length > 0 || shownRows.length > 0) && (
        <p id={noteId} className="sx-note">
          {x.note}
        </p>
      )}
      {/* One listener for every grid here: a tap in one row hides a caption another row showed. */}
      <TapReveal />
    </section>
  );
}

/**
 * One media-first card (media-card.css's layers: media 0, the stretched link 1, the caption 2, the mark 3, the focus ring 4, a
 * clip's own controls 5+). The caption is aria-hidden: the link's own name says the same words once.
 */
function MediaCard({
  id,
  width,
  height,
  poster,
  clip,
  title,
  line,
  href,
  action,
  noteId,
  badge,
  kind,
}: {
  id: string;
  width: number;
  height: number;
  poster: ReactNode;
  clip: ReactNode;
  title: string | null;
  line: { text: string; lang: string };
  href: string;
  action: string;
  noteId: string;
  badge: { short: string; name: string };
  kind: "sample" | "template";
}) {
  const { locale } = useI18n();
  const aiId = `${id}-ai`;
  return (
    <li className="sx-card mf-card" data-mf-card="" data-explore={kind} style={{ "--ar": width / height } as CSSProperties}>
      <div className="sx-pic" style={{ aspectRatio: `${width} / ${height}` }}>
        {poster}
        {clip}
      </div>
      <span id={aiId} className="mf-ai">
        <AiMark short={badge.short} name={badge.name} />
      </span>
      <span className="mf-cap" data-title={title ? undefined : "none"} aria-hidden>
        {title && (
          <span className="mf-title" lang={locale}>
            {title}
          </span>
        )}
        {line.text && (
          <span className="mf-desc" lang={line.lang}>
            {line.text}
          </span>
        )}
      </span>
      <Link href={href} prefetch={false} className="mf-card-link" aria-describedby={`${aiId} ${noteId}`}>
        <span className="sr-only">
          {title && <>{title}. </>}
          {line.text && <span lang={line.lang}>{line.text} </span>}
          {action}
        </span>
      </Link>
    </li>
  );
}
