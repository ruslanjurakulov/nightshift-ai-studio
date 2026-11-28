/**
 * The page's `ns:` timing marks (tools/visual-qa/timing/README.md): read by the timing harness through
 * performance.getEntriesByType("mark"), and by no one else. A mark carries no data (no ids, prompts or numbers), and each fires at
 * most once per document: the harness asks "when did this first become visible", and a mark repeated on every re-render would only
 * move that answer to whichever render the sampler happened to see.
 */
export type NsMarkName = `ns:${string}:${string}`;

const fired = new Set<string>();

/** Marks `name` once for this document. Never throws: a measurement must never break the page (no `performance`, a refused mark). */
export function nsMarkOnce(name: NsMarkName): void {
  if (fired.has(name)) return;
  fired.add(name);
  try {
    if (typeof performance !== "undefined" && typeof performance.mark === "function") performance.mark(name);
  } catch {
    /* timing only */
  }
}

/** Tests only: a fresh document. */
export function resetNsMarks(): void {
  fired.clear();
}
