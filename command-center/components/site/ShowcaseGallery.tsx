import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { SHOWCASE_ENTRIES, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { tryHref } from "@/lib/site/showcase-link";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { ClipPause } from "@/components/site/ClipPause";

/** The day a sample was made, in the page's language (UTC, so the server and every visitor read the same day). */
function madeOn(iso: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** The entries the page can show: those whose files are here (an entry without its files is never shown as a gap). */
export function showcaseItems(
  entries: readonly ShowcaseEntry[] = SHOWCASE_ENTRIES,
  files: Readonly<Record<string, ShowcaseFiles>> = SHOWCASE_FILES,
): { e: ShowcaseEntry; f: ShowcaseFiles }[] {
  return entries.flatMap((e) => (files[e.jobId] ? [{ e, f: files[e.jobId] }] : []));
}

/**
 * The model samples (lib/site/showcase.ts): real generations from the operator's Studio, each in its own card with an
 * "AI-generated" badge, the model that made it and its maker's credit (a link, as the maker's terms ask), the words it was
 * given, the day, and "Try it", which opens the Studio form with that tool, model and words (lib/site/showcase-link.ts).
 *
 * With no entry, or none whose files are here, it renders nothing: never a placeholder that looks like ours. A model is named
 * only inside its own card (data-showcase-entry), because that card is a generation by it; tests/site-showcase.test.tsx pins it.
 */
export function ShowcaseGallery({
  t,
  locale,
  signedIn = false,
  entries = SHOWCASE_ENTRIES,
  files = SHOWCASE_FILES,
}: {
  t: Dictionary;
  locale: Locale;
  signedIn?: boolean;
  entries?: readonly ShowcaseEntry[];
  files?: Readonly<Record<string, ShowcaseFiles>>;
}) {
  const items = showcaseItems(entries, files);
  if (items.length === 0) return null;
  const g = t.site.gallery;
  return (
    <section id="samples" aria-labelledby="samples-title" className="nx-section" data-tone="raised">
      <div className="nx-wrap">
        <p className="nx-label">{g.label}</p>
        <h2 id="samples-title" className="nx-h2">
          {g.title}
        </h2>
        <p className="nx-sub">{g.lead}</p>
        <ul className="nx-gallery">
          {items.map(({ e, f }) => {
            const href = tryHref(e, signedIn);
            const clip = e.kind === "video" && f.clip !== null;
            return (
              <li key={e.jobId} className="nx-gallery-card" data-showcase-entry={e.jobId} data-model={e.modelId}>
                <div className="nx-gallery-pic" data-clip={clip ? "sample" : undefined}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={f.poster}
                    srcSet={`${f.posterSm} 640w, ${f.poster} 1280w`}
                    sizes="(min-width: 860px) 560px, 100vw"
                    width={e.width}
                    height={e.height}
                    alt={fmt(clip ? g.altClip : g.altImage, { model: e.modelName })}
                    className="nx-art"
                    loading="lazy"
                    decoding="async"
                  />
                  {clip && <ShowcaseClip jobId={e.jobId} />}
                  <span className="nx-result-badge">{g.badge}</span>
                  {clip && <ClipPause label={t.site.fx.pause} />}
                </div>
                <div className="nx-gallery-body">
                  <p className="nx-gallery-model">
                    <span className="nx-gallery-key">{g.model}</span> <strong>{e.modelName}</strong>
                  </p>
                  {e.attribution && (
                    <a href={e.attribution.url} target="_blank" rel="noopener noreferrer" className="nx-gallery-attr">
                      {e.attribution.text}
                    </a>
                  )}
                  <p className="nx-gallery-key">{g.prompt}</p>
                  <p className="nx-gallery-prompt">{e.prompt.trim() ? e.prompt : g.noPrompt}</p>
                  <p className="nx-gallery-date">
                    <time dateTime={e.createdAt}>{fmt(g.made, { date: madeOn(e.createdAt, locale) })}</time>
                  </p>
                  {href && (
                    <Link href={href} prefetch={false} className="nx-btn nx-gallery-try" aria-label={fmt(g.tryAria, { model: e.modelName })}>
                      {g.try}
                      <ArrowRight aria-hidden />
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="nx-show-note">{signedIn ? g.tryNote : g.tryNoteSignedOut}</p>
      </div>
    </section>
  );
}
