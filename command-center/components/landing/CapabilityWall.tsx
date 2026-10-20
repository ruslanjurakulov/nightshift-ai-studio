import { Clapperboard, ImageIcon, Maximize, Mic, Palette, Scissors, ScissorsLineDashed, SlidersHorizontal, WandSparkles, type LucideIcon } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { ArtSlotImg, slotArt } from "@/components/site/art";
import { WallControls } from "@/components/landing/WallControls";

/** The tools that cost no credits (the editor and the style library), as everywhere else on the site. */
const FREE = new Set(["editor", "styles"]);

/** One icon per tool, by the tool's id in `site.studio.tools` (lucide, the icon set the app already uses). */
const TOOL_ICON: Record<string, LucideIcon> = {
  image: ImageIcon,
  video: Clapperboard,
  voice: Mic,
  edit: Scissors,
  animate: WandSparkles,
  upscale: Maximize,
  cutout: ScissorsLineDashed,
  styles: Palette,
};

/**
 * What Nightshift can make, as a wall of eight tiles, one per tool: a calm violet icon on a dark tile (dark in both themes, the
 * icon is 9:1 or better on it). The names and the one-line descriptions are the tool strip's own words (`site.studio.tools`), and
 * whether a tool costs credits is said as it always was ("Price on its button", "No credits": the wall says the first once, in
 * its note, and prints the second on the tools it is true of). The icons stand for the tools; they are not what a tool makes
 * and they are decoration (hidden from assistive tech: the tool's name is printed under each). The ninth tool, the Editor, has
 * no tile and is a plain line under the wall. Nothing on it can be pressed; no tile claims a result, a customer or a provider.
 * A Server Component.
 */
export function CapabilityWall({ t }: { t: Dictionary }) {
  const st = t.site.studio;
  const tiles = st.tools.flatMap((tool) => (tool.id in TOOL_ICON ? [{ tool, Icon: TOOL_ICON[tool.id] }] : []));
  const editor = st.tools.find((x) => x.id === "editor");
  return (
    <div id="tools" className="nx-wall" data-open="false">
      <h3 id="tools-title" className="nx-h3">
        {t.site.toolStrip.title}
      </h3>
      <p className="nx-wall-label">{t.site.wall.label}</p>
      <ul id="tools-grid" className="nx-wall-grid" aria-labelledby="tools-title">
        {tiles.map(({ tool, Icon }) => {
          // A picture, when one is configured for the tool (components/site/art.tsx SLOT_ART); otherwise the icon.
          const art = slotArt("tool", tool.id);
          return (
            <li key={tool.id} className="nx-wall-tile">
              <span className="nx-wall-frame" data-tool={tool.id}>
                {art ? <ArtSlotImg slot={art} alt={t.site.art.alts[art.altKey]} className="nx-wall-pic" /> : <Icon className="nx-wall-icon" aria-hidden strokeWidth={1.5} />}
              </span>
              <b className="nx-wall-name">{tool.title}</b>
              <span className="nx-wall-body">{tool.body}</span>
              {FREE.has(tool.id) && <small className="nx-wall-price">{st.free}</small>}
            </li>
          );
        })}
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
