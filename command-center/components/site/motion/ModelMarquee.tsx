import type { ShowcaseEntry } from "@/lib/site/showcase";
import { ClipPause } from "@/components/site/ClipPause";

/**
 * "Models in Nightshift Studio": two slow rows of the names of the models behind the samples on the page, drifting in opposite
 * directions, set just before the closing call to action (the owner's choice, 22 Nov 2026, after kling.ai's partner block —
 * but honest: these are models that made a sample shown on this page, not partners, and no logo, no "powered by", no count, no
 * claim that the Studio sells them).
 *
 * Each name sits inside a box marked as its sample (data-showcase-entry, data-model), the only kind of element on the public
 * site that may name a model (tests/helpers/showcase-scope.ts). The whole block, title included, is hidden from assistive
 * technology: the model tiles say the same names once, with their credits and links, so a screen reader hears each model
 * once. Each row is printed twice so its loop is seamless; where nothing may move (reduced motion, a touch screen that cannot
 * pause it) the copies are not drawn and the two rows sit still, centred. It stops under the pointer, while anything in it has
 * focus, and with the page's pause switch, and carries its own keyboard-only pause key outside the hidden part (the public
 * site shows no pause button: the owner's rule).
 */
export function ModelMarquee({ entries, pause, title }: { entries: readonly ShowcaseEntry[]; pause: string; title: string }) {
  const byModel = new Map<string, ShowcaseEntry>();
  for (const e of entries) if (!byModel.has(e.modelId)) byModel.set(e.modelId, e);
  const models = [...byModel.values()];
  if (models.length < 2) return null;
  // Two rows that differ: alternate names when there are enough for both rows to fill; with few, both rows carry every
  // name, the second in reverse, so the two never line up as a mirror.
  const lanes: ShowcaseEntry[][] =
    models.length >= 6 ? [models.filter((_, i) => i % 2 === 0), models.filter((_, i) => i % 2 === 1)] : [models, [...models].reverse()];
  const row = (list: ShowcaseEntry[], copy: number) => (
    <ul className="nx-marquee-row" data-copy={copy}>
      {list.map((e) => (
        <li key={e.modelId} className="nx-marquee-item" data-showcase-entry={e.jobId} data-model={e.modelId}>
          {e.modelName}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="nx-marquee">
      <div className="nx-marquee-inner" aria-hidden="true">
        <p className="nx-marquee-title">{title}</p>
        {lanes.map((list, i) => (
          <div key={i} className="nx-marquee-track" data-dir={i === 0 ? "left" : "right"} style={{ "--nx-mq-n": list.length } as React.CSSProperties}>
            {row(list, 0)}
            {row(list, 1)}
          </div>
        ))}
      </div>
      <ClipPause label={pause} />
    </div>
  );
}
