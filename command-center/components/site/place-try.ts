import { tryHref } from "@/lib/site/showcase-link";
import type { PlaceMedia } from "@/components/site/samples";

/**
 * "Try this prompt" for the sample a place shows (lib/site/showcase-link.ts), or null for a stock picture or a tool the Studio has
 * no form for. Called by the Server Components that render a place; kept out of components/site/PlaceFill.tsx because the link
 * builder pulls in the Studio's model tables, and the sign-in stage (a Client Component) renders PlaceFill too.
 */
export function placeTry(m: PlaceMedia, signedIn = false): string | null {
  return m.kind === "ai" ? tryHref(m.entry, signedIn) : null;
}
