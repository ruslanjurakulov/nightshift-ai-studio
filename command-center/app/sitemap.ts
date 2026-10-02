import type { MetadataRoute } from "next";
import { runtimeSiteOrigin } from "@/lib/landing";
import { SITEMAP_PATHS } from "@/lib/public-paths";

export const dynamic = "force-dynamic";

/**
 * /sitemap.xml: the public pages only — the same exact list the auth gate
 * serves signed out (lib/public-paths.ts), minus the sign-in flow. URLs must
 * be absolute, so with no known origin the sitemap is empty rather than a
 * list of localhost addresses.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = runtimeSiteOrigin();
  if (!origin) return [];
  return SITEMAP_PATHS.map((path) => ({
    url: new URL(path, origin).toString(),
    changeFrequency: path === "/" || path === "/pricing" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : path === "/pricing" ? 0.8 : 0.6,
  }));
}
