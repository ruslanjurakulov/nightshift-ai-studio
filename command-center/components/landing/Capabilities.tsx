import Link from "next/link";
import { Check, Clapperboard, Film, Maximize2, Mic, Palette, Scissors, SlidersHorizontal, Sparkles, Wand2, ImageIcon, type LucideIcon } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { BrandMark } from "@/components/site/BrandMark";
import { Art, type ArtKind } from "@/components/landing/Art";

type Item = Dictionary["site"]["caps"]["items"][number];

/** Where each capability's one button goes, and what its demo shows. */
const PLAN: Record<string, { href: string; art: ArtKind | null; thumb: ArtKind | null; ratio: "wide" | "audio" }> = {
  video: { href: "/signup", art: "moon", thumb: null, ratio: "wide" },
  voice: { href: "/signup", art: "wave", thumb: null, ratio: "audio" },
  studio: { href: "/signup", art: "dusk", thumb: null, ratio: "wide" },
  channels: { href: "/solutions/youtube-channels", art: "market", thumb: "market", ratio: "wide" },
  approvals: { href: "/solutions/youtube-channels", art: "moon", thumb: null, ratio: "wide" },
};

const TOOL_ICON: Record<string, LucideIcon> = {
  image: ImageIcon,
  video: Clapperboard,
  voice: Mic,
  edit: Wand2,
  animate: Film,
  upscale: Maximize2,
  cutout: Scissors,
  styles: Palette,
  editor: SlidersHorizontal,
};

/**
 * One section per thing Nightshift does, each built the same way so the page
 * reads as a list of answers: a small label, a two-line headline, a plain
 * paragraph, one button, and a card that shows it as a short exchange: what
 * you ask for, and what Nightshift hands back.
 *
 * The exchanges are examples and say so. The "results" are flat drawings in the
 * identity's colours, never generated or stock pictures, and there is no
 * figure in them the product measured. The Approvals card reuses the words of
 * the Solutions page's sign-off picture, so the two cannot disagree.
 */
export function Capabilities({ t }: { t: Dictionary }) {
  return (
    <>
      {t.site.caps.items.map((item, i) => (
        <Capability key={item.id} t={t} item={item} flip={i % 2 === 1} />
      ))}
    </>
  );
}

function Capability({ t, item, flip }: { t: Dictionary; item: Item; flip: boolean }) {
  const plan = PLAN[item.id] ?? PLAN.video;
  const titleId = `cap-${item.id}-title`;
  // Alternate the ground and the raised tone, so rhythm is colour, not lines.
  const raised = item.id === "voice" || item.id === "channels";
  return (
    <section id={item.id} aria-labelledby={titleId} className="nx-section" data-tone={raised ? "raised" : undefined}>
      <div className="nx-wrap nx-cap" data-flip={flip ? "true" : undefined}>
        <div className="nx-cap-words">
          <p className="nx-label">{item.pill}</p>
          <h2 id={titleId} className="nx-h2 nx-h2-cap">
            {item.title}
          </h2>
          <p className="nx-sub nx-sub-cap">{item.body}</p>
          <Link href={plan.href} className="nx-cta">
            {item.cta}
          </Link>
          {item.id === "studio" && <Tools t={t} />}
        </div>
        <Demo t={t} item={item} plan={plan} />
      </div>
    </section>
  );
}

function Tools({ t }: { t: Dictionary }) {
  const s = t.site.studio;
  return (
    <ol className="nx-toolchips" aria-label={s.slug}>
      {s.tools.map((tool) => {
        const Icon = TOOL_ICON[tool.id] ?? Sparkles;
        // The editor and the style library spend nothing; every other tool is a
        // generation, priced on its button before it runs.
        const free = tool.id === "editor" || tool.id === "styles";
        return (
          <li key={tool.id} title={tool.body}>
            <Icon aria-hidden />
            <span>{tool.title}</span>
            {free ? <span className="nx-tool-free st-patch-cost">{s.free}</span> : <span className="sr-only">{s.priced}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Demo({ t, item, plan }: { t: Dictionary; item: Item; plan: (typeof PLAN)[string] }) {
  const c = t.site.caps;
  const sign = t.site.solutions.pictures.signoff;
  return (
    <figure className="nx-demo" aria-label={`${item.pill}. ${c.demo}`}>
      <span className="nx-demo-tag" aria-hidden>
        {c.tag}
      </span>
      <div aria-hidden className="nx-demo-body">
        <p className="nx-bubble">{item.bubble}</p>
        {plan.thumb && (
          <span className="nx-thumb">
            <Art kind={plan.thumb} />
          </span>
        )}
        <div className="nx-reply">
          <BrandMark size={32} />
          <b>{t.brand.name}</b>
          <span>
            <Check />
            {item.reply}
          </span>
        </div>
        {item.id === "approvals" ? (
          <div className="nx-result nx-result-sign">
            <div className="nx-result-art" data-ratio="wide">
              <Art kind="moon" />
              <span className="nx-result-badge">{sign.private}</span>
            </div>
            <ul className="nx-ui-status">
              <li>
                <span className="nx-dot" data-tone="ok" />
                {sign.check}: {sign.checkState}
              </li>
              <li>
                <span className="nx-dot" data-tone="ok" />
                {sign.first}: {sign.firstState}
              </li>
              <li data-lit="true">
                <span className="nx-dot" data-tone="run" />
                {sign.second}: {sign.secondState}
              </li>
            </ul>
          </div>
        ) : (
          plan.art && (
            <div className="nx-result">
              <div className="nx-result-art" data-ratio={plan.ratio}>
                <Art kind={plan.art} />
              </div>
            </div>
          )
        )}
        {item.chips.length > 0 && (
          <ul className="nx-chiprow">
            {item.chips.map((chip) => (
              <li key={chip}>{chip}</li>
            ))}
          </ul>
        )}
      </div>
    </figure>
  );
}
