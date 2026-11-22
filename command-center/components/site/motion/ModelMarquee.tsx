import type { ShowcaseEntry } from "@/lib/site/showcase";
import { ClipPause } from "@/components/site/ClipPause";

/**
 * A slow strip of the names of the models behind the samples on the page, after the explore grid and the effects. Since the
 * model tiles were dropped (owner decision 22 Nov: they named models and would duplicate the gallery), it is the one place on the
 * landing that names models; no card does.
 *
 * Decoration over facts the page already states: one name per model that made a sample shown on this page (the facts row counts
 * the same list), each name inside a box marked as that sample (data-showcase-entry, data-model), the only kind of
 * element on the public site that may name a model (tests/helpers/showcase-scope.ts). No logo, no count, no claim that the
 * Studio sells it.
 *
 * The whole strip is hidden from assistive technology: it is decoration, and the facts row says how many models there are.
 * The list is printed twice so the loop is seamless; under reduced motion the copy is not drawn and the names sit still in a row. It stops on hover and with the
 * page's pause switch (lib/site/motion.ts), and carries its own pause key (outside the hidden part), because the page's other
 * switches are only there when something else on it moves. That key is for the keyboard only: the public site shows no pause
 * button (the owner's rule), so site-motion.css keeps it invisible until it has the keyboard's focus.
 */
export function ModelMarquee({ entries, pause }: { entries: readonly ShowcaseEntry[]; pause: string }) {
  const byModel = new Map<string, ShowcaseEntry>();
  for (const e of entries) if (!byModel.has(e.modelId)) byModel.set(e.modelId, e);
  const models = [...byModel.values()];
  if (models.length < 2) return null;
  const row = (copy: number) => (
    <ul className="nx-marquee-row" data-copy={copy}>
      {models.map((e) => (
        <li key={e.modelId} className="nx-marquee-item" data-showcase-entry={e.jobId} data-model={e.modelId}>
          {e.modelName}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="nx-marquee" style={{ "--nx-mq-n": models.length } as React.CSSProperties}>
      <div className="nx-marquee-track" aria-hidden="true">
        {row(0)}
        {row(1)}
      </div>
      <ClipPause label={pause} />
    </div>
  );
}
