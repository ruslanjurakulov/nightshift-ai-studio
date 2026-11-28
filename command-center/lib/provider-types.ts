/**
 * The shape of a provider card, for the Providers board in the browser. Types and the category order only: the list itself
 * (which vendors we hold keys with, which are live, each one's secret name and console page) is lib/providers.ts, which is
 * server-only because a static chunk can be downloaded by anyone, signed in or not. The Providers page reads the list on
 * the server and hands the board its cards as props.
 */

export type ProviderCategory = "llm" | "research" | "voice" | "video" | "image";

export const PROVIDER_CATEGORIES: ProviderCategory[] = ["llm", "research", "voice", "video", "image"];

export interface ProviderDef {
  /** Stable slug, used as a key and in the DOM. */
  id: string;
  /** Display name, the provider's own brand — not localized. */
  name: string;
  category: ProviderCategory;
  /** The GitHub Actions secret this key is sealed into. Must be allow-listed. */
  secretName: string;
  /** The provider's own API-key / console page (opens in a new tab). */
  consoleUrl: string;
  /** true = the pipeline already uses this key; false = opt-in adapter, off until set. */
  live: boolean;
}

/** The pipeline's routing defaults (config.py): which video provider runs when none is named, which one is the b-roll
 *  generator gated by its own flag, and which image generator runs when none is named. */
export interface RoutingDefaults {
  video: string;
  image: string;
  broll: string;
}

/** The GitHub Actions variables the routing panel reads and writes (lib/server/github-variables.ts allowlists them). */
export interface RoutingVariables {
  videoProvider: string;
  videoGen: string;
  broll: string;
  imageProvider: string;
  imageGen: string;
  autopilot: string;
}

/** A generator the operator's routing panel can switch the pipeline to: what it shows, and the key it warns about. */
export interface RoutingOption {
  id: string;
  name: string;
  secretName: string;
}
