import type { MetadataRoute } from "next";
import { runtimeSiteOrigin } from "@/lib/landing";

// The origin is read at request time (a self-hosted box sets APP_ORIGIN in the
// container, not at build), so this is served per request.
export const dynamic = "force-dynamic";

/**
 * /robots.txt: the public pages may be crawled; the API is not a page. The app
 * itself is behind the sign-in, so a crawler meets /login or the 404 there
 * anyway — nothing is listed that would name a private path. The sitemap line
 * appears only when the site knows its own origin (lib/landing.ts siteOrigin).
 */
export default function robots(): MetadataRoute.Robots {
  const origin = runtimeSiteOrigin();
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }],
    ...(origin ? { sitemap: `${origin}/sitemap.xml`, host: origin } : {}),
  };
}
