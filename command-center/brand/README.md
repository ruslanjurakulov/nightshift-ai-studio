# Nightshift brand assets

The Nightshift mark is the folded-ribbon **N**: a rounded left pillar, a broad
diagonal ribbon that folds over the left pillar and then over the right one,
and a right pillar. It was supplied by the owner as a 1254 x 1254 raster
(`logo/source/owner-supplied-N-1254.png`) and traced to vector; the SVGs below
are the masters and everything else is rendered from them.

## Files (`logo/`)

| File | Use |
| --- | --- |
| `nightshift-mark.svg` | White mark with the soft fold shading, transparent background. For dark grounds (social, decks, video end cards). |
| `nightshift-mark-dark.svg` | Near-black mark with the fold shading adapted (a lightening, since near-black cannot get darker). For light grounds. |
| `nightshift-mark-mono.svg` | One colour, `currentColor`, no gradients: the fold is the same shape at half opacity. For UI in any theme. Inlined by `components/site/BrandMark.tsx`. |
| `nightshift-app-icon.svg` | The mark centred on a black rounded-square tile (mark = 55% of the tile). |
| `nightshift-maskable.svg` | Full-bleed black square, mark = 46% of the tile, inside the maskable safe zone. |
| `nightshift-apple-touch.svg` | Full-bleed black square for iOS (it rounds the corners itself), mark = 58%. |
| `png/nightshift-app-icon-{1024,512,256,180,64,32,16}.png` | Raster app icon. |
| `png/nightshift-maskable-{512,192}.png` | Maskable PNGs for a web app manifest (the app has none today). |
| `png/nightshift-mark-1024.png` | White mark, transparent. |

## Where it is wired

- `app/icon.svg` (browser tab; a bigger mark so 16 px stays legible), `app/icon.png` (512), `app/apple-icon.png` (180, opaque), `app/favicon.ico` (16/32/48) are served by the Next.js file convention. Their file names are exempted from the auth gate by name in `middleware.ts`; do not rename them.
- `app/og.png/route.tsx` draws the mark beside the wordmark on the social card.
- `components/site/BrandMark.tsx` is the one place the mark is drawn in the UI (public header and footer, sign-in / sign-up, the app sidebar and top bar, the operator bar, the welcome card). Decorative beside the wordmark; pass `title` for an accessible name when it stands alone.

## Regenerating

```
python3 tools/brand/trace_logo.py          # raster -> outline (needs numpy, pillow, scipy, scikit-image)
python3 tools/brand/build_logo.py           # outline -> SVG masters + app/icon.svg
node tools/brand/build_rasters.mjs          # SVG masters -> PNG / ICO
```

After a re-trace, update `BRAND_MARK_OUTLINE` / `BRAND_MARK_FOLDS` in
`components/site/BrandMark.tsx` from `nightshift-mark-mono.svg`;
`tests/brand-mark.test.tsx` fails until they match.

## Rights

The artwork was supplied by the owner. The repository carries it as a
reference, not as a licence: the owner should confirm they hold the rights to
it and that it is not confusingly close to another company's mark before it is
used as a trademark.
