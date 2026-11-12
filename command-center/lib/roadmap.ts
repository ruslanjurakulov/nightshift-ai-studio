/**
 * The public /roadmap page ("Kutilayotgan yangiliklar", What's coming): the owner's approved list, in order.
 *
 * The words live in lib/i18n/roadmap/{en,ru,uz}.ts under the same ids; Uzbek is the master copy the owner approved.
 * The page carries no status, date, number, model or maker name: it is read by the model makers we have written to
 * and by competitors alike.
 *
 * `names` / `nameable`: an item MAY carry the names of the models or makers behind it, but a name is shown only when
 * `nameable` is true, and every item ships with `nameable: false` and no names. Before any name is shown, the owner
 * must have that maker's permission (some makers require prior written permission for any use of their name), and the
 * name must be removed from the banned provider lists (docs/news/banned-claims.json, lib/marketing-banned.ts,
 * tests/helpers/brands.ts) in the same pull request: tests/roadmap-page.test.tsx fails a nameable name that is still
 * on any of them.
 */

export const ROADMAP_ITEM_IDS = ["editor", "videoModels", "create", "ads", "gallery", "social"] as const;
export type RoadmapItemId = (typeof ROADMAP_ITEM_IDS)[number];

export interface RoadmapItem {
  id: RoadmapItemId;
  /** Show `names` on the page. False unless the owner has the maker's permission (see the module note). */
  nameable: boolean;
  /** Model or maker names behind the item. Empty today; never rendered while `nameable` is false. */
  names: readonly string[];
}

export const ROADMAP_ITEMS: readonly RoadmapItem[] = ROADMAP_ITEM_IDS.map((id) => ({ id, nameable: false, names: [] }));

/** The names an item may show: none unless it is marked nameable. The only way the page reads `names`. */
export function shownNames(item: Pick<RoadmapItem, "nameable" | "names">): readonly string[] {
  return item.nameable === true ? item.names : [];
}
