import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { fmt } from "@/lib/i18n/core";
import { creditLine } from "@/lib/site/media";
import { modelLeftOut, type ShowcaseEntry } from "@/lib/site/showcase";
import { LoopClip } from "@/components/site/LoopClip";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { SAMPLES, SampleImg, type PlaceMedia } from "@/components/site/samples";

type Site = Dictionary["site"];
/** The words a place needs to label what it shows: the stock labels and credit template, and the sample labels (the public sign-in dictionary carries exactly these, lib/i18n/public.ts). */
export type PlaceCopy = {
  samples: Pick<Site["samples"], "tag" | "frameTag" | "clipTag" | "credit" | "alts">;
  gallery: Pick<Site["gallery"], "badge" | "try" | "tryAria" | "noPrompt" | "altClip" | "altImage">;
};

/**
 * The attributes of the box a place's picture fills. A sample's box is marked as that sample (data-showcase-entry, data-model):
 * it is the one kind of element on the public site that may name a model, because it IS a generation by that model
 * (tests/helpers/brands.ts, tests/helpers/showcase-scope.ts). A stock box says which footage it plays, as before.
 */
export function placeBox(m: PlaceMedia): Record<string, string | undefined> {
  return m.kind === "ai"
    ? { "data-media": "ai", "data-clip": m.moving ? "sample" : undefined, "data-showcase-entry": m.entry.jobId, "data-model": m.entry.modelId }
    : { "data-media": "stock", "data-clip": m.clip ?? undefined };
}

/** The sentence beside a place's picture that says what it is: stock (and that a moving one is footage, looped), or one of our generations. */
export function placeNote(m: PlaceMedia, s: Site): string {
  if (m.kind === "ai") return s.gallery.slotNote;
  return m.clip ? `${s.samples.note} ${s.samples.clipNote}` : s.samples.note;
}

/** A place's picture description: the stock still's, or "AI-generated clip made by {model}". */
export function placeAlt(m: PlaceMedia, s: PlaceCopy): string {
  return m.kind === "ai" ? fmt(m.moving ? s.gallery.altClip : s.gallery.altImage, { model: m.entry.modelName }) : s.samples.alts[m.id];
}

/**
 * A sample's credit where it fills a place: the "AI-generated" badge, the model's registry name, the maker's credit as a link (as
 * its terms ask), and "Try this prompt" (the Studio form with the sample's tool and words; a link, nothing is priced or started).
 * The words themselves are in the page, visually hidden, so the button is described by what it opens. A model only the operator
 * can try yet is not named in the link (lib/site/showcase-link.ts), and the button is then its visible words.
 *
 * The link is built by the caller (components/site/place-try.ts placeTry, on the server): the link builder pulls in the Studio's
 * model tables, which a client page that shows a sample (the sign-in stage) must not ship. No `href`, no button.
 */
export function AiCredit({
  entry,
  g,
  href = null,
  now = new Date(),
  className = "nx-ai-credit",
  scope = "ai",
  badge = true,
}: {
  entry: ShowcaseEntry;
  g: PlaceCopy["gallery"];
  /** "Try this prompt": the Studio form for this sample (placeTry), or null for none. */
  href?: string | null;
  now?: Date;
  className?: string;
  /** Prefix of the words' element id, unique per place, for a page that credits the same sample in two places. */
  scope?: string;
  /** False where the place already prints the "AI-generated" badge on the picture. */
  badge?: boolean;
}) {
  const leftOut = modelLeftOut(entry, now);
  const promptId = `${scope}-prompt-${entry.jobId}`;
  return (
    <span className={className}>
      {badge && <span className="nx-ai-badge">{g.badge}</span>}
      <span className="nx-ai-model">{entry.modelName}</span>
      {entry.attribution && (
        <a href={entry.attribution.url} target="_blank" rel="noopener noreferrer" className="nx-ai-attr">
          {entry.attribution.text}
        </a>
      )}
      {href && (
        <>
          <span id={promptId} className="sr-only">
            {entry.prompt.trim() ? entry.prompt : g.noPrompt}
          </span>
          <Link href={href} prefetch={false} className="nx-ai-try" aria-label={leftOut ? undefined : fmt(g.tryAria, { model: entry.modelName })} aria-describedby={promptId}>
            {g.try}
            <ArrowRight aria-hidden />
          </Link>
        </>
      )}
    </span>
  );
}

/**
 * Everything inside a place's box: its picture (eager on the first screen), its clip when it has one (the usual LoopClip rules:
 * nothing under reduced motion, Save-Data or a slow link, paused with the page's switch), and the labels that say what it is.
 * A stock picture carries the stock badges and its Pexels contributor's credit; a sample carries AiCredit and never a stock word.
 * `labels` false leaves the labels to the caller (a place that prints them beside the box instead of on it).
 */
export function PlaceFill({
  media: m,
  s,
  alt,
  className = "nx-art",
  eager = false,
  early = false,
  compact = false,
  sizes = "100vw",
  labels = true,
  tryHref = null,
}: {
  media: PlaceMedia;
  s: PlaceCopy;
  /** The picture's description; "" where it is decorative (the box is described elsewhere). Default: placeAlt. */
  alt?: string;
  className?: string;
  eager?: boolean;
  early?: boolean;
  compact?: boolean;
  sizes?: string;
  labels?: boolean;
  /** A sample's "Try this prompt" (components/site/place-try.ts placeTry), or null for none. */
  tryHref?: string | null;
}) {
  const description = alt ?? placeAlt(m, s);
  if (m.kind === "ai") {
    const { entry, files } = m;
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={files.poster}
          srcSet={`${files.posterSm} 640w, ${files.poster} 1280w`}
          sizes={sizes}
          width={entry.width}
          height={entry.height}
          alt={description}
          className={className}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          data-sample-job={entry.jobId}
          style={m.position ? { objectPosition: m.position } : undefined}
          {...(eager ? { fetchPriority: "high" as const } : {})}
        />
        {m.moving && <ShowcaseClip jobId={entry.jobId} early={early} compact={compact} position={m.position} />}
        {labels && <span className="nx-result-badge" data-kind="ai">{s.gallery.badge}</span>}
        {labels && <AiCredit entry={entry} g={s.gallery} href={tryHref} className="nx-ai-credit nx-result-ai" badge={false} />}
      </>
    );
  }
  return (
    <>
      <SampleImg id={m.id} alt={description} className={className} eager={eager} position={m.position} sizes={sizes} />
      {m.clip && <LoopClip clip={m.clip} poster={SAMPLES[m.id].sm} early={early} compact={compact} position={m.position} />}
      {labels && (
        <span className="nx-result-badge" data-kind="still">
          {m.footage ? s.samples.frameTag : s.samples.tag}
        </span>
      )}
      {labels && m.clip && (
        <span className="nx-result-badge" data-kind="clip">
          {s.samples.clipTag}
        </span>
      )}
      {labels && <span className="nx-result-credit">{creditLine(m.id, s.samples.credit)}</span>}
    </>
  );
}
