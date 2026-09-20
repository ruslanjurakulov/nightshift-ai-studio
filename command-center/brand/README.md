# Nightshift brand assets

The Nightshift "N" mark — a bold monogram with diagonal-cut, rounded
terminals and a faint diagonal sheen, in near-black on a light rounded
squircle.

## Files

| File | Use |
| --- | --- |
| `nightshift-N.svg` | Vector master — scales to any size without loss |
| `nightshift-N-1024.png` | Master raster / high-res profile picture |
| `nightshift-N-512.png` | Profile picture (YouTube, Telegram, web) |
| `nightshift-N-256.png` | Profile / small avatar |
| `nightshift-N-180.png` | `apple-touch-icon` |
| `nightshift-N-64.png` / `-32` / `-16` | Favicon sizes |

## Where it's wired

The Command Center serves its favicon and Apple touch icon through the
Next.js App Router file convention:

- `app/icon.png` — browser tab favicon
- `app/apple-icon.png` — iOS home-screen icon

Regenerate the raster sizes from the SVG with the vector master as the
single source of truth.
