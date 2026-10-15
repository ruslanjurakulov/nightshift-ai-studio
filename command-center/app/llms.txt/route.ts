import { runtimeSiteOrigin } from "@/lib/landing";
import { devPagesEnabled } from "@/lib/dev-pages";
import { llmsTxt } from "@/lib/llms";

// The origin and the developer-pages flag are read at request time (a
// self-hosted box sets them in the container, not at build), like the sitemap.
export const dynamic = "force-dynamic";

/**
 * /llms.txt: the public pages as Markdown for language-model crawlers
 * (lib/llms.ts). Public to everyone, signed in or out (lib/public-paths.ts
 * CRAWLER_PATHS). It is the same for every visitor, so an hour of caching is
 * safe; a flag flipped on the server shows within the hour.
 */
export function GET(): Response {
  return new Response(llmsTxt(runtimeSiteOrigin(), devPagesEnabled()), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
