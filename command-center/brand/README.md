# Nightshift brand assets

The Nightshift mark is the folded-ribbon **N**: a rounded left pillar, a broad
diagonal ribbon that folds over the left pillar and then over the right one,
and a right pillar. It was supplied by the owner as a 1254 x 1254 raster
(`logo/source/owner-supplied-N-1254.png`) and traced to vector; the SVGs below
are the masters and everything else is rendered from them.

## Files (`logo/`)

| File | Use |
| --- | --- |
| `nightshift-app-icon.svg` | **The owner's picture as vector**: the N centred on a black rounded square, framing identical to the supplied image (the N is 37.9% of the tile's width). What the UI mark draws. |
| `nightshift-maskable.svg` | The same, as a plain square (iOS touch icon, maskable / any-purpose PNGs). Pixel-for-pixel the owner's framing. |
| `nightshift-mark.svg` | The white mark with the soft fold shading, transparent background, no tile. For dark grounds. |
| `nightshift-mark-dark.svg` | Near-black mark with the fold adapted (a lightening, since near-black cannot get darker). For light grounds when no tile can be used. |
| `nightshift-wordmark.svg` | **The lettering**: NIGHTSHIFT in the owner's wide, bold, rounded-square capitals, vector-traced from `logo/source/owner-supplied-wordmark-1842.png` (ten letters, one path, `currentColor`, under 5 KB). The product's wordmark is this beside the bare N: see below. |
| `nightshift-mark-mono.svg` | One colour, `currentColor`, no gradients: the fold is a half-opacity band. A simplification kept for single-colour print or embroidery; **the UI does not use it**. |
| `png/nightshift-app-icon-{1024,512,256,180,64,32,16}.png` | Rounded app icon rasters. |
| `png/nightshift-maskable-{512,192}.png` | Square tile rasters for a web app manifest (the app has none today). |
| `png/nightshift-mark-1024.png` | White mark, transparent. |

## Where it is wired

- `components/site/Wordmark.tsx` is the product's wordmark: the **bare N** (no tile) and the lettering, as the owner's `owner-supplied-wordmark-1842.png` has them (N 2.05 times the cap height, gap 0.62 of it, one centre line). One inline SVG in `currentColor`, so it follows the theme; the N's fold shades with `var(--ns-fold)` (black on the cream N of dark mode, white on the near-black N of light mode) so it reads grey in both. Sized by one number, the N's height (`--wm-h`). Decorative: the link around it is named by `aria-label`. Public header and footer, sign-in / sign-up, OAuth, the app sidebar (full lockup open, the bare N on the collapsed rail), the signed-in top bar, the operator bar, the mobile nav drawer and the welcome card. The lettering's path is the generated `components/site/wordmarkArt.ts`.
- `components/site/BrandMark.tsx` draws the owner's tile (black square with the shaded white N, unique gradient ids per instance, hairline ring on a dark page), now only as the avatar of the demo chat's reply on the landing page. It also exports `MarkDefs` and `MarkBody`, the shaded N that the wordmark reuses. Pass `title` for an accessible name when it stands alone. Its numbers come from the generated `components/site/brandMarkArt.ts`.
- `app/icon.png` (512) and `app/apple-icon.png` (180) are the owner's square picture itself. `app/icon.svg` and `app/favicon.ico` (16/32/48) are the browser-tab composition: same tile, the N set larger (72% of the tile) because at 37.9% it would be 6 px wide in a 16 px tab. Change `app_icon(512, 0.72, True)` in `tools/brand/build_logo.py` to 0.379 to make them exact too.
- `public/pwa-{192,512}.png` (rounded tile, purpose any) and `public/pwa-maskable-{192,512}.png` (square tile) are the web app manifest's icons (`app/manifest.ts`), written by `tools/brand/build_rasters.mjs` and named in the `middleware.ts` matcher. There is deliberately no service worker.
- `app/og.png/route.tsx` draws the social card: the bare N (`logo/nightshift-mark.svg`) and the lettering (`logo/nightshift-wordmark.svg`) as the header sets them, no tile. Pure function of the masters, Onest and `lib/i18n/en.ts`, so rebuilding it reproduces the file. File names of the favicon set are exempted from the auth gate by name in `middleware.ts`; do not rename them.

## Regenerating

```
python3 tools/brand/trace_logo.py          # raster -> outline (needs numpy, pillow, scipy, scikit-image)
python3 tools/brand/build_logo.py           # outline -> SVG masters + app/icon.svg
python3 tools/brand/trace_wordmark.py       # lockup raster -> nightshift-wordmark.svg + wordmarkArt.ts (same deps)
node tools/brand/build_rasters.mjs          # SVG masters -> PNG / ICO
```

`build_logo.py` also writes `components/site/brandMarkArt.ts`, so the inline mark
cannot drift from the SVGs (`tests/brand-mark.test.tsx` holds them equal, and
`tests/brand-icons-framing.test.ts` compares the square icons with the owner's
image). `node tools/brand/verify_placements.mjs --base <url>` measures every
rendered tile in Chromium at 2x against the owner's image (the wordmark has no tile; it is
compared by eye with the lockup image and by `tests/wordmark.test.tsx`).

## Rights

The artwork was supplied by the owner. The repository carries it as a
reference, not as a licence: the owner should confirm they hold the rights to
it and that it is not confusingly close to another company's mark before it is
used as a trademark.
