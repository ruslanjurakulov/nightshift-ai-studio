import { dictionaries } from "@/lib/i18n";
import { getDevDictionary } from "@/lib/i18n/dev";
import { getLegalTexts } from "@/lib/legal-docs";
import { isSolutionId, solutionHref, SOLUTIONS_PATH } from "@/lib/solutions";
import { STUDIO_PAGE_PATH } from "@/lib/public-paths";
import { listedPagePaths } from "@/lib/site-pages";

/**
 * /llms.txt (the llmstxt.org convention): a plain Markdown map of the public
 * site for language-model crawlers. It is generated, never typed:
 *
 * - the page list is the sitemap's (lib/site-pages.ts), plus the OpenAPI spec,
 *   which is a public file but not a page;
 * - every title and description is the English string the page itself uses for
 *   its search-result text (lib/i18n), so the file cannot say something the
 *   site does not. The one exception is the MCP page, whose own description
 *   names third-party assistants; here it is a neutral sentence instead, and
 *   tests/launch-checklist.test.ts keeps this whole file free of provider and
 *   model names, prices and role words;
 * - no price is printed: /pricing is the only place a number lives.
 *
 * The site is one URL per page in all three languages (the language follows the
 * visitor's cookie or browser setting), so there is one file, in English, and
 * it says so.
 */

export const OPENAPI_PATH = "/docs/api/openapi.json";

export interface LlmsEntry {
  path: string;
  title: string;
  description: string;
}

type Section = "Product" | "Solutions" | "Developers" | "Legal";
const SECTIONS: Section[] = ["Product", "Solutions", "Developers", "Legal"];

/** Where each listed page belongs; a listed page missing here is a bug the test names. */
function sectionOf(path: string): Section {
  if (path === "/" || path === STUDIO_PAGE_PATH || path === "/pricing") return "Product";
  if (path === SOLUTIONS_PATH || path.startsWith(SOLUTIONS_PATH + "/")) return "Solutions";
  if (path === "/privacy" || path === "/terms") return "Legal";
  return "Developers";
}

/** Title and description of every path the file can name, from the site's own English copy. */
function describe(path: string): { title: string; description: string } | null {
  const t = dictionaries.en;
  const dev = getDevDictionary("en");
  const legal = getLegalTexts("en");
  if (path === "/") return { title: t.brand.name, description: t.landing.meta.description };
  if (path === STUDIO_PAGE_PATH) return { title: t.site.nav.studio, description: t.site.studioPage.meta.description };
  if (path === "/pricing") return { title: t.pricing.title, description: t.pricing.metaDescription };
  if (path === SOLUTIONS_PATH) return { title: t.site.solutions.meta.title, description: t.site.solutions.meta.description };
  const solution = t.site.solutions.pages.find((p) => isSolutionId(p.id) && solutionHref(p.id) === path);
  if (solution) return { title: solution.nav, description: solution.lead };
  if (path === "/docs/api") return { title: dev.api.meta.title, description: dev.api.meta.description };
  if (path === OPENAPI_PATH) return { title: "OpenAPI specification", description: "The public REST API described in the OpenAPI format (JSON)." };
  if (path === "/mcp") return { title: dev.mcp.meta.title, description: "How to connect an AI assistant to Nightshift over MCP, then make videos by asking the assistant." };
  if (path === "/docs/cli") return { title: dev.cli.meta.title, description: dev.cli.meta.description };
  if (path === "/docs/skills") return { title: dev.skills.meta.title, description: dev.skills.meta.description };
  if (path === "/privacy") return { title: legal.privacy.title, description: legal.privacy.summary };
  if (path === "/terms") return { title: legal.terms.title, description: t.site.legalMeta.terms };
  return null;
}

/** The entries of the file, in sitemap order, the OpenAPI spec after the API reference. */
export function llmsEntries(devPages: boolean): LlmsEntry[] {
  const paths = listedPagePaths(devPages).flatMap((p) => (p === "/docs/api" ? [p, OPENAPI_PATH] : [p]));
  return paths.map((path) => {
    const d = describe(path);
    if (!d) throw new Error(`llms.txt: no description for the listed page ${path}`);
    return { path, ...d };
  });
}

/** One line of prose never needs a line break, and a link label never needs a bracket. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * The file. With an origin the links are absolute; without one (a deploy that
 * has not set its address) they are root-relative, never localhost.
 */
export function llmsTxt(origin: string | null, devPages: boolean): string {
  const t = dictionaries.en;
  const entries = llmsEntries(devPages);
  const url = (path: string) => (origin ? new URL(path, origin).toString() : path);
  const lines: string[] = [
    `# ${t.brand.name}`,
    "",
    `> ${oneLine(t.landing.meta.description)}`,
    "",
    "Every page is available in English, Russian and Uzbek at the same address; the language follows the visitor's setting. This file lists the public pages only. The signed-in app is private.",
    "",
  ];
  for (const section of SECTIONS) {
    const inSection = entries.filter((e) => sectionOf(e.path) === section);
    if (inSection.length === 0) continue;
    lines.push(`## ${section}`, "");
    for (const e of inSection) lines.push(`- [${oneLine(e.title).replace(/[[\]]/g, "")}](${url(e.path)}): ${oneLine(e.description)}`);
    lines.push("");
  }
  return lines.join("\n");
}
