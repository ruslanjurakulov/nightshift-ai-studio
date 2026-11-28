"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useMemo, useRef, type CSSProperties, type ReactNode, type Ref } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { templateCreateHref, type TemplateDto } from "@/lib/templates/trends";
import {
  TEMPLATE_ASPECT,
  TEMPLATE_ROWS,
  exploreTemplates,
  nothingOnSale,
  templatesUnread,
  type ExploreData,
  type ExploreSample,
  type OnSale,
  type TemplateRow,
} from "@/lib/creative/explore";
import { useTemplates } from "@/components/trends/useTemplates";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { LoopClip } from "@/components/site/LoopClip";
import { ClipPause } from "@/components/site/ClipPause";
import { TapReveal } from "@/components/site/TapReveal";
import { AiMark } from "@/components/site/AiMark";
import { focusPrompt } from "@/components/shell/SkipLink";
import { LOGIN_PATH } from "@/lib/public-paths";
import "@/components/site/media-card.css";
import "@/components/studio/studio-explore.css";

/**
 * Below the fold of the customer's Create screen: the shipped samples, then the trend templates in three rows (trending, videos by
 * topic, brand-style pictures), media first as on the landing (components/site/media-card.css, #935). At rest a card is its picture
 * or clip and the small "AI" mark; its title and one grey line show on hover, keyboard focus, or a first tap on a phone (TapReveal),
 * and the card is one link to this channel's Studio form with that prompt and model. No text, alt, aria or data attribute on a card
 * names a model: the model travels in the link alone, and the Studio says which model and price it will use.
 *
 * Nothing here writes. The samples and the catalogue arrive from the server (app/(app)/[channel]/create/page.tsx): the models on sale
 * to this workspace, priced and buyable. The templates are one read of /api/templates, kept to those whose model both the route and
 * that catalogue call on sale; with nothing on sale at all the read is not even made. "Could not check" (the registry or the route
 * could not say) and "nothing on sale yet" are different sentences (CLAUDE.md rule 5), each one quiet line with a way on; loading,
 * failed (with a retry that keeps the keyboard's place), not switched on and session ended each say so. A row with nothing to show
 * is not drawn, never filled with placeholders.
 *
 * Moving clips stop with the page's pause key (ClipPause, shown when a keyboard reaches it while a clip is here), and do not play
 * at all under reduced motion or Save-Data, or while off screen (components/site/LoopClip.tsx). There is no tap-to-pause here: the
 * card's link covers the clip, so a tap opens or reveals the card instead (the clip boxes carry no data-clip on purpose).
 */
export function StudioExplore({ data }: { data: ExploreData }) {
  const { t } = useI18n();
  const x = t.studioHome.explore;
  // Unread on the server (the registry or the price list could not be read): no retry from here would read it again, so the way on
  // is the composer.
  if (data.state === "unread") return <Quiet testId="explore-unread" line={x.unread} action={<WriteOwn />} />;
  // Nothing on sale for any tool here: said at once; reading the templates could only end in the same line.
  if (nothingOnSale(data.samples, data.onSale)) return <Soon />;
  return <ExploreGrid samples={data.samples} onSale={data.onSale} />;
}

/** One body-size line in the grid's place (no display heading over nothing), and a way on when there is one. */
function Quiet({ testId, line, action, focusRef }: { testId: string; line: string; action?: ReactNode; focusRef?: Ref<HTMLDivElement> }) {
  return (
    <div className="sx" data-testid="studio-explore">
      <div className="sx-quiet" data-testid={testId} ref={focusRef} tabIndex={focusRef ? -1 : undefined}>
        <p>{line}</p>
        {action}
      </div>
    </div>
  );
}

/** The way on from every "nothing to show": the composer at the top of the page, focused in its field (SkipLink's own helper). */
function WriteOwn() {
  const { t } = useI18n();
  return (
    <a href="#prompt" onClick={focusPrompt} className="tap-link sx-more" data-testid="explore-write-own">
      {t.studioHome.explore.soonAction}
    </a>
  );
}

function Soon({ focusRef }: { focusRef?: Ref<HTMLDivElement> }) {
  const { t } = useI18n();
  return <Quiet testId="explore-empty" line={t.studioHome.explore.soon} action={<WriteOwn />} focusRef={focusRef} />;
}

function ExploreGrid({ samples, onSale }: { samples: readonly ExploreSample[]; onSale: OnSale }) {
  const { t, locale } = useI18n();
  const x = t.studioHome.explore;
  const g = t.site.gallery;
  const path = useChannelPath();
  const here = usePathname();
  const uid = useId();
  const noteId = `${uid}-note`;
  // The formats heading is one element through loading, failed and the rest, so a retry keeps the keyboard on it; a read that then
  // succeeds hands focus to the first row (or the line said in its place), never to the page's top.
  const formatsRef = useRef<HTMLHeadingElement>(null);
  const firstRowRef = useRef<HTMLHeadingElement>(null);
  const quietRef = useRef<HTMLDivElement>(null);
  const retried = useRef(false);
  const { state, retry } = useTemplates(locale);
  const rows = useMemo(() => (state.phase === "ok" ? exploreTemplates(state.templates, onSale) : null), [state, onSale]);
  const shownRows = rows ? TEMPLATE_ROWS.filter((r) => rows[r].length > 0) : [];
  const unread = state.phase === "ok" && templatesUnread(state.templates);

  useEffect(() => {
    // A retry pressed where its key then goes away (the unread line replaced by the loading section): the heading keeps the place.
    if (retried.current && state.phase === "loading" && document.activeElement === document.body) formatsRef.current?.focus();
    if (!retried.current || state.phase !== "ok") return;
    retried.current = false;
    (firstRowRef.current ?? quietRef.current)?.focus();
  }, [state]);

  // The route answered, but could not say for any template whether its model is on sale: "could not load", with a retry (it may
  // answer next time) and the composer.
  const retryKey = (
    <button
      type="button"
      className="btn-quiet tap"
      onClick={() => {
        retried.current = true;
        retry();
        // The key goes away with the line it answers: the heading keeps the place (it stays through the loading).
        formatsRef.current?.focus();
      }}
      data-testid="explore-retry"
    >
      {x.retry}
    </button>
  );
  const unreadAction = (
    <>
      {retryKey}
      <WriteOwn />
    </>
  );

  if (state.phase === "ok" && shownRows.length === 0 && samples.length === 0) {
    return unread ? <Quiet testId="explore-unread" line={x.unread} action={unreadAction} focusRef={quietRef} /> : <Soon focusRef={quietRef} />;
  }

  const sampleCards = samples.map((s) => (
    <MediaCard
      key={s.id}
      id={`${uid}-s-${s.id}`}
      width={s.width}
      height={s.height}
      poster={
        // eslint-disable-next-line @next/next/no-img-element -- the sample's own sized posters (640 and 1280 wide), as the landing's grid draws them.
        <img src={s.poster} srcSet={s.srcSet} sizes="(min-width: 1280px) 420px, (min-width: 768px) 45vw, 90vw" width={s.width} height={s.height} alt={s.clip ? g.bgClip : g.bgImage} className="sx-art" loading="lazy" decoding="async" />
      }
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
      const [w, h] = TEMPLATE_ASPECT[tpl.aspect];
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
      <h2 id={id} ref={ref} tabIndex={-1} className="sx-h2">
        {title}
      </h2>
      {more && (
        <Link href={path("/trends")} className="tap-link sx-more">
          {x.seeAll}
        </Link>
      )}
    </div>
  );

  // The read's states other than "some to show": one section, the same heading element in each.
  let formats: ReactNode = null;
  if (state.phase !== "ok") {
    let body: ReactNode;
    if (state.phase === "loading") {
      body = (
        <>
          {/* Outside the busy part: a screen reader holds back what is inside an aria-busy region, the "loading" too. */}
          <p className="sr-only" role="status">
            {x.loading}
          </p>
          <ul className="sx-grid" data-row="topics" aria-busy="true" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="sx-card sx-skel skeleton" style={{ "--ar": 9 / 16 } as CSSProperties} />
            ))}
          </ul>
        </>
      );
    } else if (state.phase === "error") {
      body = (
        <div className="sx-state" role="alert">
          <p>{x.error}</p>
          {retryKey}
        </div>
      );
    } else if (state.phase === "not_enabled") {
      body = (
        <div className="sx-state">
          <p>{x.notEnabled}</p>
          <WriteOwn />
        </div>
      );
    } else {
      body = (
        <div className="sx-state">
          <p>{x.signedOut}</p>
          <a className="btn-quiet tap" href={`${LOGIN_PATH}?next=${encodeURIComponent(here)}`} data-testid="explore-sign-in">
            {x.signIn}
          </a>
        </div>
      );
    }
    formats = (
      <section key="formats" className="sx-row" aria-labelledby={`${uid}-formats`} data-testid={`explore-${state.phase}`}>
        {head(`${uid}-formats`, x.formats, false, formatsRef)}
        {body}
      </section>
    );
  } else if (unread && shownRows.length === 0) {
    // Samples to show, and the formats unreadable: said in the formats' place, not dropped as if there were none (rule 5).
    formats = (
      <section key="formats" className="sx-row" aria-labelledby={`${uid}-formats`} data-testid="explore-unread">
        {head(`${uid}-formats`, x.formats, false, formatsRef)}
        <div className="sx-state">
          <p>{x.unread}</p>
          {unreadAction}
        </div>
      </section>
    );
  }

  const hasClip = samples.some((s) => s.clip) || (rows !== null && shownRows.some((r) => rows[r].some((tpl) => tpl.preview_url)));
  const hasCards = samples.length > 0 || shownRows.length > 0;
  return (
    <div role="group" aria-label={x.label} className="sx" data-testid="studio-explore">
      {/* WCAG 2.2.2: the keyboard's way to stop every moving clip here, first in the grid and shown above the rows only while focused. */}
      {hasClip && <ClipPause label={t.site.fx.pause} />}
      {samples.length > 0 && (
        <section className="sx-row" aria-labelledby={`${uid}-samples`} data-row="samples">
          {head(`${uid}-samples`, x.samples, false, firstRowRef)}
          <ul className="sx-grid" data-row="samples">
            {sampleCards}
          </ul>
        </section>
      )}
      {formats}
      {rows &&
        shownRows.map((r: TemplateRow, i) => (
          <section key={r} className="sx-row" aria-labelledby={`${uid}-${r}`} data-row={r}>
            {head(`${uid}-${r}`, x[r], i === 0, i === 0 && samples.length === 0 ? firstRowRef : undefined)}
            <ul className="sx-grid" data-row={r}>
              {templateCards(rows[r])}
            </ul>
          </section>
        ))}
      {/* Said once for every card, not under each one, and only under cards: what a card does, and that nothing starts until the
          Studio's own key. */}
      {hasCards && (
        <p id={noteId} className="sx-note">
          {x.note}
        </p>
      )}
      {/* One listener for every grid here: a tap in one row hides a caption another row showed. */}
      <TapReveal />
    </div>
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
