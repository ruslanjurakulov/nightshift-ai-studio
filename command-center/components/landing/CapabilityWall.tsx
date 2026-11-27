import { Clapperboard, ImageIcon, Maximize, Mic, Palette, Scissors, ScissorsLineDashed, SlidersHorizontal, WandSparkles, type LucideIcon } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { SHOWCASE_ENTRIES, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { TOOL_SAMPLES, toolSource } from "@/lib/site/tool-samples";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { WallControls } from "@/components/landing/WallControls";
import { AiMark } from "@/components/site/AiMark";

/** The tools that cost no credits (the editor and the style library), as everywhere else on the site. */
const FREE = new Set(["editor", "styles"]);

/** One icon per tool, by the tool's id in `site.studio.tools` (lucide, the icon set the app already uses), for a tile with no output. */
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

type Sample = { e: ShowcaseEntry; f: ShowcaseFiles };
const sample = (job: string | null | undefined): Sample | null => {
  const e = job ? SHOWCASE_ENTRIES.find((x) => x.jobId === job) : undefined;
  const f = e ? SHOWCASE_FILES[e.jobId] : undefined;
  return e && f ? { e, f } : null;
};

/**
 * A sample's picture in a tile: its poster (drifting slowly), and its loop when it is a clip. `anchor` gives it the id the model
 * tiles link to (#sample-<job>), for a sample that is on this page only here (the Animate tile's still).
 */
function SamplePic({ s, alt, anchor = false }: { s: Sample; alt: string; anchor?: boolean }) {
  const clip = s.e.kind === "video" && s.f.clip !== null;
  return (
    <span className="nx-wall-out" data-clip={clip ? "sample" : undefined} id={anchor ? `sample-${s.e.jobId}` : undefined}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={s.f.posterSm} width={s.e.width} height={s.e.height} alt={alt} className="nx-wall-shot nx-drift-pic" loading="lazy" decoding="async" />
      {clip && <ShowcaseClip jobId={s.e.jobId} together />}
    </span>
  );
}

/**
 * What Nightshift can make, as a wall of tiles, one per tool (lib/site/tool-samples.ts says what each shows). A tool with a real
 * output shows it: a picture the Image tool made, a clip the Video tool made, and for Animate the still and the clip made from
 * it, side by side. Each such tile is that sample's box, labelled with one small line, "AI-generated · made by our team", and no
 * model name: the owner has not decided whether the public site names models, and the wall does not need them (no maker's credit
 * either: it is shown in the Studio). A tool no customer can use today says "Not available yet" once (the Studio's own words for it,
 * lib/i18n/availability), and nothing else about it: a second "this model is not in the Studio" on the same tile repeated it
 * (owner, 2026-11-14). Beside the words, our team's sample when it has one, or its icon: never a drawn result. A tool with no line in lib/site/tool-samples.ts is not drawn at all, because
 * nothing says whether it can be used (CLAUDE.md #5: an unknown is never shown as available). Tools with an output come first.
 * Each sample on the wall carries the id the model tiles link to. The Editor is a plain line under the wall. A Server Component.
 */
export function CapabilityWall({ t }: { t: Dictionary }) {
  const st = t.site.studio;
  const g = t.site.gallery;
  const w = t.site.wall;
  const tiles = st.tools
    .flatMap((tool) => {
      const def = TOOL_SAMPLES[tool.id];
      if (!(tool.id in TOOL_ICON) || !def) return [];
      // Our team's sample is shown either way, labelled AI-generated; a closed tool also says "Not available yet".
      const out = sample(def.job);
      const from = out ? sample(toolSource(out.e.jobId)) : null;
      return [{ tool, Icon: TOOL_ICON[tool.id], def, out, from }];
    })
    .sort((a, b) => Number(Boolean(b.out)) - Number(Boolean(a.out)) || Number(b.def.inStudio) - Number(a.def.inStudio));
  const editor = st.tools.find((x) => x.id === "editor");
  return (
    <div id="tools" className="nx-wall" data-open="false">
      <h3 id="tools-title" className="nx-h3">
        {t.site.toolStrip.title}
      </h3>
      <p className="nx-wall-label">{w.label}</p>
      <ul id="tools-grid" className="nx-wall-grid" aria-labelledby="tools-title">
        {tiles.map(({ tool, Icon, def, out, from }) => (
          <li
            key={tool.id}
            className="nx-wall-tile"
            data-tool={tool.id}
            {...(out ? { id: `sample-${out.e.jobId}`, "data-showcase-entry": out.e.jobId, "data-model": out.e.modelId } : {})}
            data-in-studio={def.inStudio ? "true" : "false"}
          >
            <span className="nx-wall-frame" data-tool={tool.id} data-split={from ? "true" : undefined}>
              {from && <SamplePic s={from} alt={w.altFrom} anchor />}
              {out ? <SamplePic s={out} alt={out.e.kind === "video" ? g.bgClip : g.bgImage} /> : <Icon className="nx-wall-icon" aria-hidden strokeWidth={1.5} />}
            </span>
            <b className="nx-wall-name">{tool.title}</b>
            <span className="nx-wall-body">{tool.body}</span>
            {!def.inStudio && <small className="nx-wall-notyet">{t.availability.notYet}</small>}
            {/* A price line only on a tool that can be used: "No credits" beside "Not available yet" would read as on offer. */}
            {def.inStudio && FREE.has(tool.id) && <small className="nx-wall-price">{st.free}</small>}
            {out && <small className="nx-wall-credit"><AiMark short={g.badge} name={`${g.badgeName} · ${w.byTeam}`} /></small>}
            {from && <small className="nx-wall-from">{w.from}</small>}
          </li>
        ))}
      </ul>
      <WallControls more={w.more} less={w.less} />
      {editor && (
        <p className="nx-wall-editor">
          <SlidersHorizontal aria-hidden />
          <b>{editor.title}</b>
          <span>{editor.body}</span>
          <small>{st.free}</small>
        </p>
      )}
      <p className="nx-wall-note">{w.note}</p>
    </div>
  );
}
