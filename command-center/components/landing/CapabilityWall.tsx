import { SlidersHorizontal } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { ArtImg } from "@/components/site/art";
import { WallControls } from "@/components/landing/WallControls";
import { TOOL_ART } from "@/lib/site/art";

/** The tools that cost no credits (the editor and the style library), as everywhere else on the site. */
const FREE = new Set(["editor", "styles"]);

/**
 * What Nightshift can make, as a wall of eight illustrations, one per tool. The names and the one-line descriptions are the
 * tool strip's own words (`site.studio.tools`), and whether a tool costs credits is said as it always was ("Price on its
 * button", "No credits": the wall says the first once, in its note, and prints the second on the tools it is true of). The
 * pictures are AI-generated illustrations that STAND FOR each tool (lib/site/art.ts); they are not what the tool makes and not
 * screenshots, and the wall says so above the grid ("AI-generated illustrations of each tool") and below it. The ninth tool, the
 * Editor, has no picture and is a plain line under the wall. Nothing on it can be pressed; no tile claims a result, a customer
 * or a provider. A Server Component.
 */
export function CapabilityWall({ t }: { t: Dictionary }) {
  const st = t.site.studio;
  const tiles = st.tools.flatMap((tool) => (tool.id in TOOL_ART ? [{ tool, pic: TOOL_ART[tool.id as keyof typeof TOOL_ART] }] : []));
  const editor = st.tools.find((x) => x.id === "editor");
  return (
    <div id="tools" className="nx-wall" data-open="false">
      <h3 id="tools-title" className="nx-h3">
        {t.site.toolStrip.title}
      </h3>
      <p className="nx-wall-label">{t.site.wall.label}</p>
      <ul id="tools-grid" className="nx-wall-grid" aria-labelledby="tools-title">
        {tiles.map(({ tool, pic }) => (
          <li key={tool.id} className="nx-wall-tile">
            <span className="nx-wall-frame">
              <ArtImg id={pic} alt={t.site.art.alts[pic]} className="nx-wall-pic" />
            </span>
            <b className="nx-wall-name">{tool.title}</b>
            <span className="nx-wall-body">{tool.body}</span>
            {FREE.has(tool.id) && <small className="nx-wall-price">{st.free}</small>}
          </li>
        ))}
      </ul>
      <WallControls more={t.site.wall.more} less={t.site.wall.less} />
      {editor && (
        <p className="nx-wall-editor">
          <SlidersHorizontal aria-hidden />
          <b>{editor.title}</b>
          <span>{editor.body}</span>
          <small>{st.free}</small>
        </p>
      )}
      <p className="nx-wall-note">{t.site.wall.note}</p>
    </div>
  );
}
