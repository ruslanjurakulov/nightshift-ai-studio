import { expect } from "vitest";

/**
 * The resolved-href half of the "into the editor by a full load" guard (lib/editor-nav.ts): every link actually
 * rendered whose address is an editor project page must be a plain anchor, never a Next `<Link>`. The test files that
 * use it mock `next/link` with an anchor marked `data-next-link`. The shape here is looser than the server's (any
 * project id, not only a uuid) so a test's short ids are covered too; the image editor is not the project page.
 */
const INTO_PROJECT = /^\/[^/]+\/editor\/(?!image(?:\/|$))[^/?#]+\/?(?:[?#].*)?$/;

export function clientLinksIntoEditor(root: ParentNode = document): string[] {
  return [...root.querySelectorAll("a[href]")]
    .filter((a) => a.hasAttribute("data-next-link") && INTO_PROJECT.test(a.getAttribute("href") ?? ""))
    .map((a) => a.getAttribute("href") ?? "");
}

/** At least one project link was rendered (so the check saw something), and none of them is a client-side Link. */
export function expectEditorLinksAreFullLoads(root: ParentNode = document): void {
  const into = [...root.querySelectorAll("a[href]")].filter((a) => INTO_PROJECT.test(a.getAttribute("href") ?? ""));
  expect(into.length, "no link into an editor project was rendered").toBeGreaterThan(0);
  expect(clientLinksIntoEditor(root)).toEqual([]);
}
