/**
 * What client code may know about a sample (components/site/showcase-assets.ts SHOWCASE_CARDS, written by tools/export_showcase.py
 * with the files): its key, the model id a link and an effect match on, the tool, the kind, the size, the slot it was exported for,
 * and for an animation the sample picture it was made from. A subset of ShowcaseEntry (lib/site/showcase.ts, server-only) by
 * construction, so every helper typed on a card takes a full entry on the server unchanged. Nothing here names a vendor, a cost or
 * a hash.
 *
 * Its own module, free of the data file, because client code needs showcaseCard as a value: a structural subset is not a copy, and
 * a full entry passed where a card is typed would carry every private field into a client prop.
 */
export interface ShowcaseCard {
  jobId: string;
  modelId: string;
  capability: string;
  kind: "video" | "image";
  width: number;
  height: number;
  slot: string | null;
  /** Only an `operator_job` input names anything (the source sample's job); the site art's file and hash stay on the server. */
  input: { kind: "operator_job"; jobId: string } | { kind: "none" | "site_art" };
}

/**
 * A copy holding exactly a card's fields: what tools/export_showcase.py writes into SHOWCASE_CARDS for an entry (pinned equal to
 * SHOWCASE_ENTRIES.map(showcaseCard) in tests/showcase-cards.test.ts), and what a helper returns for a client prop, so a full
 * entry handed to it on the server never crosses whole. A test that stands in its own data file builds its slice with this.
 */
export function showcaseCard(e: ShowcaseCard): ShowcaseCard {
  const input: ShowcaseCard["input"] = e.input.kind === "operator_job" ? { kind: "operator_job", jobId: e.input.jobId } : { kind: e.input.kind };
  return { jobId: e.jobId, modelId: e.modelId, capability: e.capability, kind: e.kind, width: e.width, height: e.height, slot: e.slot, input };
}
