import { Plug } from "lucide-react";
import { BRAND_ART } from "@/lib/dev/brand-logos-art";
import { brandLogo, logoShown, shownSymbols } from "@/lib/dev/brand-logos";

/**
 * The logos of the assistants /mcp connects to (lib/dev/brand-logos.ts says why
 * each one may be shown). One hidden sprite per page holds every mark that is
 * shown, once; each place a logo appears is a tiny <use> of it, so the page
 * carries about 20 KB of drawings however many times a mark is repeated, and
 * asks no other origin for anything.
 *
 * The sprite is 0 x 0 and clipped, never display:none: a gradient or mask inside
 * a display:none <svg> does not render in Chromium.
 */
export function BrandSprite({ ids }: { ids: readonly string[] }) {
  const symbols = shownSymbols(ids);
  return (
    <svg aria-hidden focusable="false" width="0" height="0" className="st-sprite" xmlns="http://www.w3.org/2000/svg">
      {symbols.map((s) => (
        <symbol key={s} id={`nl-${s}`} viewBox={BRAND_ART[s].viewBox} dangerouslySetInnerHTML={{ __html: BRAND_ART[s].markup }} />
      ))}
    </svg>
  );
}

/**
 * The client's logo, or its neutral monogram where the mark may not be shown.
 * Where the owner provides a mark for a light page and one for a dark page,
 * both are in the markup and the theme picks one (site.css); a mark that exists
 * in one drawing is shown as it is, on the tile its owner's rules need.
 *
 * Decorative: the client's name is always in the text beside it (a tab's label,
 * the "Works with" line for the tile row), so the mark has no name of its own.
 */
export function BrandLogo({ id, mono }: { id: string; mono: string }) {
  const entry = brandLogo(id);
  if (id === "other") return <Plug className="st-logo-glyph" aria-hidden />;
  if (!logoShown(entry)) return <span className="st-logo-mono">{mono}</span>;
  const s = entry.symbols;
  return (
    <svg className="st-logo" data-tile={entry.tile} aria-hidden focusable="false" xmlns="http://www.w3.org/2000/svg">
      {"any" in s ? (
        <use href={`#nl-${s.any}`} />
      ) : (
        <>
          <use href={`#nl-${s.light}`} data-v="light" />
          <use href={`#nl-${s.dark}`} data-v="dark" />
        </>
      )}
    </svg>
  );
}

/** Does this client's tile need the light "paper" surface (a single black mark)? */
export function logoTile(id: string): "theme" | "paper" {
  const e = brandLogo(id);
  return logoShown(e) ? e.tile : "theme";
}
