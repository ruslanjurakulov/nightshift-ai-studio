import { Check, UserRound } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";

/** The steps that stay with the person, in both columns: the topic is theirs to choose and the last word is theirs. */
const YOURS = new Set(["topic", "publish"]);

/**
 * The same video made by hand and with Nightshift, one row per step, saying
 * only who does it. There are no hours, no percentages and no "x times
 * faster": the page cannot measure how long anyone takes by hand, so it does
 * not say. What it can say is true by construction: the steps Nightshift does,
 * the two it leaves to you (the topic, which can also come from the channel's
 * niche, and the publish button), and that upload is private by default.
 */
export function Compare({ t }: { t: Dictionary }) {
  const c = t.site.compare;
  return (
    <section id="compare" aria-labelledby="compare-title" className="nx-section">
      <div className="nx-wrap">
        <h2 id="compare-title" className="nx-h2">
          {c.title}
        </h2>
        <p className="nx-sub">{c.lead}</p>
        <ul className="nx-cmp" aria-label={c.slug}>
          <li className="nx-cmp-head" aria-hidden>
            <span>{c.colStep}</span>
            <span>{c.colHand}</span>
            <span>{c.colNs}</span>
          </li>
          {c.rows.map((row) => {
            const yours = YOURS.has(row.id);
            return (
              <li key={row.id} className="nx-cmp-row" data-yours={yours ? "true" : undefined}>
                <b className="nx-cmp-step">{row.step}</b>
                <span className="nx-cmp-cell">
                  <small className="nx-cmp-k">{c.colHand}</small>
                  <span className="nx-cmp-who">
                    <UserRound aria-hidden />
                    {c.you}
                  </span>
                </span>
                <span className="nx-cmp-cell" data-ns="true">
                  <small className="nx-cmp-k">{c.colNs}</small>
                  <span className="nx-cmp-who">
                    {yours ? <UserRound aria-hidden /> : <Check aria-hidden />}
                    {row.ns}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
