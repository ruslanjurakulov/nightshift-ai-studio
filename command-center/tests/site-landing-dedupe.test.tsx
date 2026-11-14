// @vitest-environment jsdom
/**
 * No sample on the landing twice (components/site/landing-samples.tsx landingSplit). The live page broke it: every one of the
 * carousel's 16 clips was in the explore grid under it as well, five of them were also the Effects section's previews, and one
 * clip was in five sections. What would break if these failed: a visitor scrolling past the same clip again and again, and a
 * gallery 27 phone screens long.
 *
 * Read on the rendered landing over the real data file: every sample surface (the explore grid, each data-sample-section, the
 * Effects section, and each other section that shows one in a place) is a set of job ids, and no job is in two of them. Pointers
 * to a sample shown elsewhere are not showings of it: the model tiles (#models) and the models strip (.nx-marquee), names only.
 *
 * One exception, named and counted rather than hidden: a sample that is an effect's preview AND the one its model's tile links
 * to is in the Effects section and in the grid, because the tile's link needs a `#sample-` box and the Effects section's frames
 * carry none. It goes away when they do (or the tiles link elsewhere); the test then holds with no exception.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, replace: _r, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; replace?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries } from "@/lib/i18n";
import { Landing } from "@/components/landing/Landing";
import { gridSpan, showcaseItems } from "@/components/site/ShowcaseGallery";
import { levelOrder } from "@/lib/site/gallery-plan";
import { LANDING_GALLERY_MAX, effectPreviewJobs, landingGalleryExclude, landingGalleryJobs, landingTileJobs, sampleSectionJobs } from "@/components/site/landing-samples";
import { landingExcludedJobs } from "@/components/site/slots";
import type { MoneyAnchor } from "@/lib/landing";

afterEach(cleanup);

const NO_MONEY: MoneyAnchor = { pack: { kind: "none" }, api: null, site: null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Which surface an element showing a sample belongs to (null: a pointer to it, not a showing). */
function surfaceOf(el: Element): string | null {
  if (el.closest("#models, .nx-marquee")) return null;
  // The approval screen is drawn twice on purpose, as the same screen: the third step's live piece and the Approvals showcase both
  // show the one video awaiting approval (lib/site/tool-samples.ts). One surface.
  if (el.closest(".nx-step-live[data-step='approve'], .nx-approve-art")) return "approval-screen";
  const sampleSection = el.closest("[data-sample-section]");
  if (sampleSection) return `sample-section:${sampleSection.id || sampleSection.className}`;
  const section = el.closest("section[id]");
  if (section) return `section:${section.id}`;
  return `place:${el.closest("section, header, footer, aside")?.className ?? "page"}`;
}

/** The samples an effect previews that a model tile links to: the one known overlap (see the header). */
function tiledPreviews(): string[] {
  const tiles = landingTileJobs(landingExcludedJobs());
  return effectPreviewJobs().filter((j) => tiles.includes(j) && landingGalleryJobs(landingExcludedJobs()).includes(j));
}

describe("the landing shows each sample once", () => {
  it("no job id is shown by two surfaces of the rendered landing (but the named exception)", () => {
    const { container } = render(<Landing t={dictionaries.en} locale="en" pricing={{ kind: "announced" }} anchor={NO_MONEY} showcase={[]} />);
    const where = new Map<string, Set<string>>();
    for (const el of container.querySelectorAll("[data-showcase-entry], [data-sample], [data-sample-job]")) {
      const job = el.getAttribute("data-showcase-entry") ?? el.getAttribute("data-sample-job") ?? el.getAttribute("data-sample") ?? "";
      if (!UUID.test(job)) continue; // a stock picture's id (data-sample="desert") is not a sample
      const surface = surfaceOf(el);
      if (!surface) continue;
      if (!where.has(job)) where.set(job, new Set());
      where.get(job)!.add(surface);
    }
    const allowed = new Set(tiledPreviews());
    const twice = [...where]
      .filter(([job, s]) => s.size > 1 && !(allowed.has(job) && [...s].sort().join() === "section:effects,section:samples"))
      .map(([job, s]) => `${job.slice(0, 8)} in ${[...s].join(", ")}`);
    expect(twice).toEqual([]);
    // The exception stays small: at most one per model.
    expect(allowed.size).toBeLessThanOrEqual(new Set(showcaseItems().map(({ e }) => e.modelId)).size);
    // And the grid is there, with its share in the data file's order: not an empty section, and not every sample again.
    const grid = [...container.querySelectorAll("section#samples [data-showcase-entry]")].map((c) => c.getAttribute("data-showcase-entry"));
    // The grid's share, in the order its level plan lays it out (lib/site/gallery-plan.ts).
    const share = landingGalleryJobs(landingExcludedJobs());
    const byJob = new Map(showcaseItems().map(({ e }) => [e.jobId, e]));
    const spans = share.map((j) => gridSpan(byJob.get(j)!.width, byJob.get(j)!.height));
    expect(grid).toEqual(levelOrder(spans).map((i) => share[i]));
  });

  it("the grid's share is the samples the model tiles link to plus a few more, never a section's, and the landing hands its gallery exactly that", () => {
    const leftOut = landingExcludedJobs();
    const share = landingGalleryJobs(leftOut);
    const sections = sampleSectionJobs(leftOut);
    for (const j of share) {
      expect(leftOut, j).not.toContain(j);
      expect(sections, j).not.toContain(j);
    }
    // Beyond what a tile links to, at most LANDING_GALLERY_MAX in all, and never another effect's preview.
    const tiles = landingTileJobs(leftOut);
    const extra = share.filter((j) => !tiles.includes(j));
    expect(share.length).toBeLessThanOrEqual(Math.max(LANDING_GALLERY_MAX, tiles.length));
    for (const j of extra) expect(effectPreviewJobs(), j).not.toContain(j);
    // Every tile's link lands on a box: a grid card, or picture → video's figure (sections carry the clip of a pair).
    for (const j of tiles) expect(share.includes(j) || sections.includes(j), j).toBe(true);
    const shown = showcaseItems().filter(({ e }) => !landingGalleryExclude(leftOut).includes(e.jobId));
    expect(shown.map(({ e }) => e.jobId)).toEqual(share);
  });
});
