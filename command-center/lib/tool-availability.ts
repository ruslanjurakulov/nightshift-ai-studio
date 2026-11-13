/**
 * Which Studio tools have something on sale behind them, for the places that
 * LINK to a tool before its form is open: the sidebar's desks, Home's quick
 * tiles, the desk bar, the overview's kinds and examples, and the Presets page.
 *
 * Before this, a tool with no sold model looked exactly like a working one
 * everywhere except inside its own form ("Nothing to pick yet"): a customer
 * found out only after clicking. On a database where every model row is still
 * `hidden`, that was every tool.
 *
 * The answer is computed once per request on the server
 * (lib/server/tool-availability.ts) from the same list the Studio's form
 * offers (lib/server/creative readStudioModels: sellable_models(), the owner's
 * switch, the country rule, and the operator's previews), so a tool marked
 * available here is one the form can actually pick a model for.
 *
 * Pure and client-safe (tests/tool-availability.test.ts).
 */
import { DESK_TOOLS, type Desk } from "@/lib/creative/desks";

export type ToolAvailability =
  /** The models were read: `sold` is every capability at least one offered model has. */
  | { state: "known"; sold: readonly string[] }
  /**
   * The read failed, or there is no organization to read for. Unknown is not
   * "unavailable" (CLAUDE.md rule 5): every tool is drawn as before and the
   * form says what it finds.
   */
  | { state: "unknown" };

export const UNKNOWN_TOOLS: ToolAvailability = { state: "unknown" };

/** The availability of a model list as read; null = the read failed. */
export function availabilityFromModels(models: readonly { capabilities: readonly string[] }[] | null): ToolAvailability {
  if (models === null) return UNKNOWN_TOOLS;
  const sold = new Set<string>();
  for (const m of models) for (const c of m.capabilities) if (typeof c === "string" && c) sold.add(c);
  return { state: "known", sold: [...sold].sort() };
}

/**
 * Can this tool be used today? Unknown answers yes on purpose: the tool is
 * then drawn as it always was, never marked unavailable on a guess.
 */
export function toolOpen(av: ToolAvailability, capability: string): boolean {
  return av.state === "unknown" || av.sold.includes(capability);
}

/** Known, and this tool has nothing on sale: draw it as "Not available yet". */
export function toolClosed(av: ToolAvailability, capability: string): boolean {
  return !toolOpen(av, capability);
}

/**
 * Is a desk worth opening? The overview and the YouTube video desk do not
 * depend on a model on sale (the overview points elsewhere, the YouTube video
 * is the channel pipeline); a media desk is open while any one of its tools is.
 */
export function deskOpen(av: ToolAvailability, desk: Desk): boolean {
  if (desk === "overview" || desk === "youtube") return true;
  return DESK_TOOLS[desk].some((c) => toolOpen(av, c));
}

/** A desk's tools that are known to have nothing on sale, in the desk's order. */
export function closedTools<T extends string>(av: ToolAvailability, tools: readonly T[]): T[] {
  return tools.filter((c) => toolClosed(av, c));
}

/** Known, and not one picture, clip or voice tool is on sale: say so plainly and point at what does work. */
export function nothingOnSale(av: ToolAvailability): boolean {
  // Only the Studio's own tools count: a model sold for captions or music alone opens none of these screens.
  return av.state === "known" && !Object.values(DESK_TOOLS).some((tools) => tools.some((c) => av.sold.includes(c)));
}

