import type { Dictionary } from "@/lib/i18n";
import { devFor } from "@/lib/i18n/dev";
import { ROADMAP_PATH, STUDIO_PAGE_PATH, TRUST_PATH } from "@/lib/public-paths";
import { SOLUTION_IDS, SOLUTIONS_PATH, solutionHref } from "@/lib/solutions";

export { isCurrentPage, menuHref, menuPath } from "@/lib/public-menu-href";

/** Which top-level page the visitor is on, for the bar's lit item. */
export type PublicSection = "home" | "studio" | "solutions" | "pricing" | "docs" | "legal" | "resources" | null;

export type NavItem = { href: string; label: string; description?: string };
export type NavColumn = {
  id: string;
  title: string;
  href?: string;
  links: NavItem[];
};
export type NavGroupId = "studio" | "solutions" | "developers" | "resources";
export type NavGroup = {
  kind: "group";
  id: NavGroupId;
  label: string;
  section: PublicSection;
  columns: NavColumn[];
};
export type NavLinkEntry = {
  kind: "link";
  href: string;
  label: string;
  section: PublicSection;
};
export type NavEntry = NavGroup | NavLinkEntry;

/** The /studio page's own sections that the menu points into (its "On this page" list, minus the questions). */
const STUDIO_SECTIONS = ["plan", "editor", "publish", "price"] as const;

/**
 * The public header's one navigation source: the desktop panels (components/legal/PublicMegaMenu.tsx) and the phone
 * sheet's sections (components/legal/PublicMenu.tsx) both draw this list, so the two can never offer different pages.
 *
 * Every href is a distinct, public page or a section that page always renders (tests/public-megamenu.test.tsx resolves
 * each to a route file and to lib/public-paths.ts). The rule that shaped the Studio panel: a link labelled as a tool must
 * land on that tool. The only per-tool address that exists is the app's `/{channel}/create?tool=…` behind sign-in, so the
 * models on sale (0193) are not listed as links here; the panel names the /studio page's sections instead, which is what
 * a signed-out visitor can actually open. CLI and Skills appear only while their pages are switched on (lib/dev-pages.ts).
 * There is no Download panel: there is no app to download.
 */
export function publicNav(t: Dictionary, opts: { devPages: boolean }): NavEntry[] {
  const n = t.site.nav;
  const m = t.site.megaMenu;
  const dev = devFor(t);
  const jump = t.site.studioPage.hero.jump;
  const pages = t.site.solutions.pages;
  return [
    {
      kind: "group",
      id: "studio",
      label: n.studio,
      section: "studio",
      columns: [
        {
          id: "studio",
          title: t.site.studioPage.hero.label,
          href: STUDIO_PAGE_PATH,
          links: [
            // Absolute ("/#how") so it works from every public page, as the bar's old link did.
            { href: "/#how", label: n.how },
            ...STUDIO_SECTIONS.flatMap((id) => {
              const j = jump.find((x) => x.id === id);
              return j ? [{ href: `${STUDIO_PAGE_PATH}#${id}`, label: j.label }] : [];
            }),
          ],
        },
      ],
    },
    {
      kind: "group",
      id: "solutions",
      label: n.solutions,
      section: "solutions",
      columns: [
        {
          id: "solutions",
          title: n.solutions,
          href: SOLUTIONS_PATH,
          links: SOLUTION_IDS.flatMap((id) => {
            const p = pages.find((x) => x.id === id);
            if (!p) return [];
            // The developers page's short name ("Developers") is also the next trigger's: in the panel it reads by its kicker
            // ("For developers"), with the page's own title as the line under it.
            return id === "developers"
              ? [{ href: solutionHref(id), label: p.kicker, description: p.title }]
              : [{ href: solutionHref(id), label: p.nav, description: p.kicker }];
          }),
        },
      ],
    },
    { kind: "link", href: "/pricing", label: n.pricing, section: "pricing" },
    {
      kind: "group",
      id: "developers",
      label: dev.nav.label,
      section: "docs",
      columns: [
        {
          id: "developers",
          title: dev.nav.label,
          links: [
            {
              href: "/docs/api",
              label: t.site.footer.api,
              description: m.desc.api,
            },
            { href: "/mcp", label: dev.nav.mcp, description: m.desc.mcp },
            // The reference's "Pricing and limits" section (components/docs/ApiDocs.tsx), which prints the live API price list.
            {
              href: "/docs/api#pricing",
              label: m.apiPricing,
              description: m.desc.apiPricing,
            },
            ...(opts.devPages
              ? [
                  { href: "/docs/cli", label: dev.nav.cli },
                  { href: "/docs/skills", label: dev.nav.skills },
                ]
              : []),
          ],
        },
      ],
    },
    {
      kind: "group",
      id: "resources",
      label: m.resources,
      section: "resources",
      columns: [
        {
          id: "resources",
          title: m.resources,
          links: [
            {
              href: ROADMAP_PATH,
              label: t.site.roadmap.footer,
              description: m.desc.roadmap,
            },
            {
              href: TRUST_PATH,
              label: t.site.trust.footer,
              description: m.desc.trust,
            },
          ],
        },
      ],
    },
  ];
}

/** Every destination the navigation offers, in reading order: column title links, panel links and the plain links. */
export function navHrefs(entries: readonly NavEntry[]): string[] {
  return entries.flatMap((e) =>
    e.kind === "link" ? [e.href] : e.columns.flatMap((c) => [...(c.href ? [c.href] : []), ...c.links.map((l) => l.href)]),
  );
}
