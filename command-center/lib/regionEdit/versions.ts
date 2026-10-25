/**
 * Version history of a picture: each region edit is a NEW library file whose `parent_asset_id` is the picture it was
 * made from (media_assets, migration 0038; nothing here writes it, nothing ever overwrites a file). Undo is "go to the
 * parent"; the original is the root. Pure so it is tested without a database.
 */

export interface VersionRow {
  id: string;
  parentId: string | null;
  version: number;
  createdAt: string | null;
  width: number | null;
  height: number | null;
}

/** Most links followed in either direction: a cycle or a runaway chain stops here, never loops. */
export const MAX_CHAIN = 25;

export interface Chain {
  /** Oldest (the original) first, newest last. */
  items: VersionRow[];
  /** Where the picture being looked at sits in `items`. */
  at: number;
}

/**
 * The chain through `currentId`: its ancestors up to the original, then the newest child at each step downward.
 * `null` when the current picture is not among the rows.
 */
export function buildChain(rows: readonly VersionRow[], currentId: string): Chain | null {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const current = byId.get(currentId);
  if (!current) return null;
  const up: VersionRow[] = [current];
  const seen = new Set<string>([current.id]);
  for (let at = current; at.parentId && up.length < MAX_CHAIN; ) {
    const parent = byId.get(at.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    up.unshift(parent);
    at = parent;
  }
  const down: VersionRow[] = [];
  for (let at = current; down.length < MAX_CHAIN; ) {
    const kids = rows.filter((r) => r.parentId === at.id && !seen.has(r.id));
    if (kids.length === 0) break;
    const next = kids.reduce((a, b) => ((b.createdAt ?? "") > (a.createdAt ?? "") ? b : a));
    seen.add(next.id);
    down.push(next);
    at = next;
  }
  return { items: [...up, ...down], at: up.length - 1 };
}

/** The picture to go to for "undo", or null at the original. */
export function previousId(chain: Chain): string | null {
  return chain.at > 0 ? chain.items[chain.at - 1].id : null;
}

/** The picture to go to for "redo", or null at the newest. */
export function nextId(chain: Chain): string | null {
  return chain.at < chain.items.length - 1 ? chain.items[chain.at + 1].id : null;
}

/** The original of the chain (what before/after compares against). */
export function originalId(chain: Chain): string {
  return chain.items[0].id;
}

/** Library rows (snake_case, as PostgREST sends them) -> VersionRow; a malformed row is dropped, never guessed. */
export function coerceVersionRows(rows: unknown): VersionRow[] {
  if (!Array.isArray(rows)) return [];
  const out: VersionRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    if (typeof row.id !== "string") continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    out.push({
      id: row.id,
      parentId: typeof row.parent_asset_id === "string" ? row.parent_asset_id : null,
      version: num(row.version) ?? 1,
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
      width: num(row.width),
      height: num(row.height),
    });
  }
  return out;
}
