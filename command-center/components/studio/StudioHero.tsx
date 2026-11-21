import mediaManifest from "@/lib/templates/media-manifest.json";
import { templateMediaUrl, type MediaManifest } from "@/lib/templates/trends";

/**
 * The fan over the Studio start's headline: five posters of our own templates (public/templates/<slug>/poster.webp, made through
 * our own Studio), never stock art. Only a poster the manifest says ships can be named, so a missing file is dropped, not drawn as a
 * broken picture. Decoration: hidden from assistive technology, the headline under it says what the page is.
 */
export const HERO_SLUGS = ["travel-montage", "food-reveal", "cinematic-intro", "product-ad-vertical", "water-revival"] as const;

export function heroPosters(manifest: MediaManifest = mediaManifest as MediaManifest): string[] {
  return HERO_SLUGS.map((s) => templateMediaUrl(manifest, s, "poster")).filter((u): u is string => u !== null);
}

export function StudioHeroFan() {
  const posters = heroPosters();
  if (posters.length === 0) return null;
  return (
    <div className="sh-fan" aria-hidden data-testid="studio-hero-fan" style={{ ["--fan-n" as string]: posters.length }}>
      {posters.map((src, i) => (
        <span key={src} className="sh-fan-card" style={{ ["--i" as string]: i - (posters.length - 1) / 2 }}>
          {/* The outer two are hidden on a phone; lazy, so a hidden one is never fetched there. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- a static poster under /public/templates, already sized. */}
          <img src={src} alt="" decoding="async" loading={i === 0 || i === posters.length - 1 ? "lazy" : undefined} />
        </span>
      ))}
    </div>
  );
}
