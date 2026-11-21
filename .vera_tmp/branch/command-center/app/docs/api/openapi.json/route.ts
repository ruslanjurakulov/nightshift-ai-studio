import { openApiSpec } from "@/lib/api/openapi";
import { docsOrigin } from "@/lib/api/docs-origin";

/**
 * The public API's OpenAPI 3.1 document, linked from /docs/api (public by
 * lib/public-paths.ts INFO_PATHS). It is built from the same constants the
 * routes use (lib/api/openapi.ts) and names no price: the only prices are the
 * live list on /docs/api#pricing. Nothing per visitor is in it, so a short
 * public cache is fine.
 */
export function GET(): Response {
  return Response.json(openApiSpec(docsOrigin()), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
