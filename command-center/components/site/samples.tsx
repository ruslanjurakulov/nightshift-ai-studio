import silkroad from "@/components/site/samples/silkroad.webp";
import library from "@/components/site/samples/library.webp";
import moon from "@/components/site/samples/moon.webp";
import nightmarket from "@/components/site/samples/nightmarket.webp";
import valley from "@/components/site/samples/valley.webp";
import lighthouse from "@/components/site/samples/lighthouse.webp";

/**
 * The example frames on the public pages: six AI-generated stills, made on
 * 2026-10-05 for demonstration (see docs/design/SITE_ENGAGE.md for their
 * provenance). They stand in where a finished result would be, and every place
 * that shows one says "Example" next to it; none is output of a real account,
 * a customer's work or a claim about what the product produces.
 *
 * Imported statically, so each is a hashed file served from this origin
 * (img-src 'self' already allows it) with its real width and height.
 */
export const SAMPLES = { silkroad, library, moon, nightmarket, valley, lighthouse } as const;
export type SampleId = keyof typeof SAMPLES;

/**
 * One example frame as an <img> that fills its aspect-ratio box (the box, not
 * the picture, decides the layout, so nothing shifts when it loads). Lazy by
 * default; the one on the first screen is eager (the hero card). `alt` is empty when
 * the surrounding picture is hidden from assistive tech and already described.
 */
export function SampleImg({ id, alt = "", className, eager = false }: { id: SampleId; alt?: string; className?: string; eager?: boolean }) {
  const s = SAMPLES[id];
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={s.src} width={s.width} height={s.height} alt={alt} className={className} loading={eager ? "eager" : "lazy"} decoding="async" data-sample={id} {...(eager ? { fetchPriority: "high" as const } : {})} />
  );
}
