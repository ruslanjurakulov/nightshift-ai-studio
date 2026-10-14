import type { MetadataRoute } from "next";

/**
 * The web app manifest: what "Add to Home Screen" / "Install" reads. Served at
 * /manifest.webmanifest, public like the icons it names (middleware.ts matcher: a
 * browser fetches both before it has any say in the sign-in, and a manifest that
 * 307s to /login is not a manifest).
 *
 * No service worker, on purpose. Chromium installs a page from the manifest alone,
 * and a worker's only job here would be an offline cache, which for a signed-in
 * dashboard means keeping one person's private pages and API answers on a device
 * that may be shared. Nothing here can serve stale or another person's data.
 *
 * Colours are the page's own ground: the control room's ink (the dark token) for
 * the splash, because a manifest has one value and Nightshift is a night product;
 * once the page runs, the per-scheme `theme-color` metas of app/layout.tsx win
 * (light #f3f3f1, dark #131210). The icons come from tools/brand/build_rasters.mjs.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Nightshift",
    short_name: "Nightshift",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#131210",
    theme_color: "#131210",
    categories: ["productivity", "video"],
    icons: [
      { src: "/pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
