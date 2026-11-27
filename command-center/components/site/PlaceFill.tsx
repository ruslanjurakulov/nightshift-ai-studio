import type { Dictionary } from "@/lib/i18n";
import { creditLine } from "@/lib/site/media";
import type { ShowcaseEntry } from "@/lib/site/showcase";
import { LoopClip } from "@/components/site/LoopClip";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { SAMPLES, SampleImg, type PlaceMedia } from "@/components/site/samples";
import { posterSrcSet } from "@/lib/site/renditions";
import { AiMark } from "@/components/site/AiMark";

type Site = Dictionary["site"];
/** The words a place needs to label what it shows: the stock labels and credit template, and the sample labels (the public sign-in dictionary carries exactly these, lib/i18n/public.ts). */
export type PlaceCopy = {
  samples: Pick<Site["samples"], "tag" | "frameTag" | "clipTag" | "credit" | "alts">;
  gallery: Pick<Site["gallery"], "badge" | "badgeName" | "bgClip" | "bgImage">;
};

/**
 * The attributes of the box a place's picture fills. A sample's box is marked as that sample (data-showcase-entry, data-model):
 * it is the one kind of element on the public site that may name a model, because it IS a generation by that model
 * (tests/helpers/brands.ts, tests/helpers/showcase-scope.ts). A stock box says which footage it plays, as before.
 */
export function placeBox(m: PlaceMedia, anchor = false): Record<string, string | undefined> {
  return m.kind === "ai"
    ? {
        "data-media": "ai",
        "data-clip": m.moving ? "sample" : undefined,
        "data-showcase-entry": m.entry.jobId,
        "data-model": m.entry.modelId,
        // The landing's model tiles link down to a sample; a sample shown in a slot is reached at its box (one box per page has it).
        id: anchor ? `sample-${m.entry.jobId}` : undefined,
      }
    : { "data-media": "stock", "data-clip": m.clip ?? undefined };
}

/**
 * The sentence beside a place's picture that says what it is: stock (and that a moving one is footage, looped), or null for one of
 * our generations. A place's picture is the page's backdrop, not its content: a footnote naming "the shown model" and "this
 * prompt" under copy about something else read as if the section were about that clip (owner, 2026-11-13), so a sample in a place
 * carries its AI-generated badge and nothing more. Its model and its prompt are on its own card in the gallery.
 */
export function placeNote(m: PlaceMedia, s: Site): string | null {
  if (m.kind === "ai") return null;
  return m.clip ? `${s.samples.note} ${s.samples.clipNote}` : s.samples.note;
}

/** A place's picture description: the stock still's, or "AI-generated clip" (a backdrop: it does not name the model, as the badge on it does not). */
export function placeAlt(m: PlaceMedia, s: PlaceCopy): string {
  return m.kind === "ai" ? (m.moving ? s.gallery.bgClip : s.gallery.bgImage) : s.samples.alts[m.id];
}

/**
 * The label on a sample that fills a place: the "AI-generated" badge and nothing else (the AI disclosure is never dropped). No
 * model name, no "Try this prompt", no maker's credit: a place's picture decorates copy about something else (owner, 2026-11-13).
 * The model and the prompt are on the sample's own card (components/site/ShowcaseGallery.tsx) and on the tool wall (AiCredit).
 */
export function AiBadge({ g, className = "nx-ai-credit" }: { g: Pick<PlaceCopy["gallery"], "badge" | "badgeName">; className?: string }) {
  return (
    <span className={className}>
      <span className="nx-ai-badge"><AiMark short={g.badge} name={g.badgeName} /></span>
    </span>
  );
}

/**
 * A sample's label where the sample IS the content (the tool wall's tiles): the "AI-generated" badge and the model's registry
 * name. No maker's credit: the public site shows the AI-generated label and the model name only, and the maker's required credit
 * is shown in the Studio, where the models are used (components/studio/ModelAttribution.tsx; owner decision 2026-11-13).
 */
export function AiCredit({
  entry,
  g,
  className = "nx-ai-credit",
  badge = true,
}: {
  entry: ShowcaseEntry;
  g: Pick<PlaceCopy["gallery"], "badge" | "badgeName">;
  className?: string;
  /** False where the picture already prints the "AI-generated" badge. */
  badge?: boolean;
}) {
  return (
    <span className={className}>
      {badge && <span className="nx-ai-badge"><AiMark short={g.badge} name={g.badgeName} /></span>}
      <span className="nx-ai-model">{entry.modelName}</span>
    </span>
  );
}

/**
 * Everything inside a place's box: its picture (eager on the first screen), its clip when it has one (the usual LoopClip rules:
 * nothing under reduced motion, Save-Data or a slow link, paused with the page's switch), and the labels that say what it is.
 * A stock picture carries the stock badges and its Pexels contributor's credit; a sample carries the AI-generated badge only, and
 * never a stock word. `labels` false leaves the labels to the caller (a place that prints them beside the box instead of on it).
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
}) {
  const description = alt ?? placeAlt(m, s);
  if (m.kind === "ai") {
    const { entry, files } = m;
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={files.poster}
          srcSet={posterSrcSet(files)}
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
        {labels && <span className="nx-result-badge" data-kind="ai"><AiMark short={s.gallery.badge} name={s.gallery.badgeName} /></span>}
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
