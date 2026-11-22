/**
 * A public animation sample's "Try this prompt" (lib/site/showcase-link.ts) opens the Studio's picture-to-video form with the
 * sample's words, its model, and `sample=<the i2v entry's job id>`: a REFERENCE to the picture the sample was animated from, never a
 * URL or a path. The create page resolves it here, on the server, against the shipped showcase data only (lib/site/showcase.json and
 * components/site/showcase-assets.ts): it must be a known i2v entry whose input picture is itself a shipped sample picture. Anything
 * else is refused, and the form says the sample's picture could not be loaded instead of opening as if it had a source (CLAUDE.md
 * #5). The address can therefore never make the Studio fetch an arbitrary file: the only URLs this returns are the site's own
 * hashed posters.
 *
 * The browser then puts that picture into the person's library through the library's ordinary upload (lib/creative/attach.ts
 * uploadAttachment, the path a file attached on the home page takes) and sets it as the form's source. Nothing is priced, held or
 * started: the person still presses Generate and sees the price (CLAUDE.md #3).
 *
 * Kept free of file imports (the files map is passed in), so the tests can give it their own.
 */
import type { ShowcaseEntry } from "@/lib/site/showcase";

/** The link's parameter. */
export const SAMPLE_PARAM = "sample";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A shipped poster as Next serves it: one same-origin absolute path to a WebP (`/_next/static/media/poster.<hash>.webp`). Checked
 * again here so that even a malformed generated assets file cannot turn the resolver into a loader of another origin
 * (`//host`, `/\host`) or of something that is not a picture.
 */
const SHIPPED_PICTURE = /^\/(?![/\\])[A-Za-z0-9._~/-]+\.webp$/;

export type SampleSource =
  /** The sample's own source picture, as this deployment ships it, and the name the library file gets. */
  | { state: "ready"; sampleId: string; src: string; name: string }
  /** The link named a sample, and it is not one whose picture we ship: no picture is loaded and the form says so. */
  | { state: "refused" };

type Files = Readonly<Record<string, { poster?: unknown } | undefined>>;

/** Whether `src` is a picture path this resolver may hand to the browser. */
export function isShippedPicture(src: unknown): src is string {
  return typeof src === "string" && SHIPPED_PICTURE.test(src) && !src.split("/").includes("..");
}

/**
 * The picture an i2v sample started from, or null: the entry must be an i2v sample, its input another sample of ours (an
 * `operator_job` input whose job is itself a shipped PICTURE entry), and that entry's poster must ship. A `site_art` input is not
 * resolved yet (no i2v sample uses one, and the site art has no generated files map to look it up in): it reads as refused.
 */
export function sampleSourcePicture(sampleId: string, entries: readonly ShowcaseEntry[], files: Files): { src: string; sourceJobId: string } | null {
  const entry = entries.find((e) => e.jobId === sampleId);
  if (!entry || entry.capability !== "i2v" || entry.input.kind !== "operator_job") return null;
  const sourceJobId = entry.input.jobId;
  const source = entries.find((e) => e.jobId === sourceJobId);
  if (!source || source.kind !== "image") return null;
  // Own keys only: `__proto__` or `constructor` must never read as a shipped file.
  if (!Object.prototype.hasOwnProperty.call(files, sourceJobId)) return null;
  const src = files[sourceJobId]?.poster;
  return isShippedPicture(src) ? { src, sourceJobId } : null;
}

/**
 * The create page's reading of `sample=`: null when there is nothing to do (no `sample` in the address, a form that is not
 * picture-to-video, or one that already has a source the person chose), else the picture or a refusal. A repeated parameter
 * (`sample=a&sample=b`) is refused, not narrowed to one of them.
 */
export function resolveSampleSource(
  raw: unknown,
  form: { capability?: string; sourceId?: string | null } | null | undefined,
  entries: readonly ShowcaseEntry[],
  files: Files,
): SampleSource | null {
  if (raw === undefined) return null;
  if (!form || form.capability !== "i2v" || form.sourceId) return null;
  if (typeof raw !== "string" || !UUID.test(raw)) return { state: "refused" };
  const pic = sampleSourcePicture(raw, entries, files);
  if (!pic) return { state: "refused" };
  return { state: "ready", sampleId: raw, src: pic.src, name: `sample-${pic.sourceJobId.slice(0, 8)}.webp` };
}
