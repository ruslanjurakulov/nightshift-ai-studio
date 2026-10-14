import { TOOL_ICONS } from "@/components/studio/toolIcons";
import { FormatArt } from "@/components/home/FormatArt";
import { StyleTile } from "@/components/styles/StyleTile";
import { hashSeed, rng } from "@/lib/styles/tile";
import { templateGradient } from "@/lib/creative/templates";
import type { PresetArt as Art } from "@/lib/presets";

/**
 * A preset card's cover. All of it is drawn, none generated: a picture of a
 * person or a place here would read as "this is what you will get", and
 * nothing on this page was made by a model. Decorative (aria-hidden); the
 * card's words say what it is.
 */
export function PresetArt({ art }: { art: Art }) {
  switch (art.kind) {
    case "format":
      return <FormatArt id={art.id} className="block h-full w-full" />;
    case "look":
      // The style's own palette and texture motif, as in the Style Library.
      return <StyleTile style={art.style} className="h-full w-full" />;
    case "starter":
      return <StarterArt template={art.template} />;
    case "voice":
      return <VoiceArt id={art.id} />;
  }
}

/** The shape the starter makes (16:9, 9:16, 1:1) in the template's two colours, with its tool's mark. */
function StarterArt({ template }: { template: Extract<Art, { kind: "starter" }>["template"] }) {
  const Icon = TOOL_ICONS[template.capability];
  const [ratio, height] = template.aspect === "9:16" ? ["9 / 16", "80%"] : template.aspect === "1:1" ? ["1 / 1", "64%"] : ["16 / 9", "58%"];
  return (
    <div className="grid h-full w-full place-items-center">
      <div
        className="grid place-items-center rounded-[6px] text-white"
        style={{ height, aspectRatio: ratio, background: templateGradient(template) }}
      >
        <Icon aria-hidden className="size-6" strokeWidth={1.75} />
      </div>
    </div>
  );
}

/** A level bar pattern seeded by the voice id: the same voice always draws the same bars. It is not the voice's sound. */
function VoiceArt({ id }: { id: string }) {
  const next = rng(hashSeed(id));
  const bars = Array.from({ length: 21 }, () => 14 + Math.round(next() * 62));
  return (
    <svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false">
      {bars.map((b, i) => (
        <rect key={i} x={10 + i * 7} y={50 - b / 2} width="4" height={b} rx="2" fill="var(--ns-edge-print)" opacity={0.55 + (i % 3) * 0.15} />
      ))}
    </svg>
  );
}
