import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The link-preview image (og:image and twitter:image) of every public page: the owner-supplied
 * picture, the Nightshift wordmark centred on a black ground of white ribbon waves, served as it
 * is. It replaces the card this route used to draw (the hero line and the rundown); nothing is
 * drawn here any more, and nothing is fetched: the file is read from brand/og/og-card.png while
 * the static route is built. To change the picture, replace that file (brand/README.md says how).
 *
 * Why a route at /og.png and not the app/opengraph-image.tsx convention: that convention serves
 * at /opengraph-image (no extension), which the auth gate in middleware.ts sends to /login for a
 * signed-out visitor, and every crawler that unfurls a link is signed out. The middleware matcher
 * skips exactly `/og.png` (anchored, BR-H-001), so this picture is reachable without widening the
 * public surface in lib/public-paths.ts. lib/landing.ts OG_IMAGE points og:image here.
 */
export const dynamic = "force-static";

/**
 * The URL stays /og.png when the picture is replaced, so it must not be cached as immutable: the
 * drawn card used to go out under next/og's default of one year, immutable, and a crawler or CDN
 * that saw it would never look again. An hour, then a day of stale-while-revalidate, lets a new
 * picture reach link previews within a day without every unfurl hitting the server.
 */
const CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";

export async function GET() {
  const png = await readFile(join(process.cwd(), "brand", "og", "og-card.png"));
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": CACHE_CONTROL,
    },
  });
}
