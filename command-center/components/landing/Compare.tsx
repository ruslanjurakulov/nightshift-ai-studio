import { Check, UserRound } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";

/** The steps that stay with the person: the topic is theirs to choose and the last word is theirs. */
const YOURS = new Set(["topic", "publish"]);

/**
 * The same six steps, made by hand and with Nightshift, as one clear contrast
 * instead of a table: on the left you do all six; on the right Nightshift does
 * four and the two that matter stay marked as yours. It has no hours, no
 * percentages and no "x times faster": the page cannot measure how long anyone
 * takes by hand, so it does not say. What it can say is true by construction:
 * which steps Nightshift does, and which two it leaves to you.
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
        <div className="nx-cmp" aria-label={c.slug} role="group">
          <section className="nx-cmp-col" aria-labelledby="cmp-hand">
            <h3 id="cmp-hand" className="nx-h3">
              {c.colHand}
            </h3>
            <p className="nx-cmp-sum">{c.handSum}</p>
            <ol className="nx-cmp-list">
              {c.rows.map((row) => (
                <li key={row.id}>
                  <UserRound aria-hidden />
                  {row.step}
                </li>
              ))}
            </ol>
          </section>
          <section className="nx-cmp-col" data-ns="true" aria-labelledby="cmp-ns">
            <h3 id="cmp-ns" className="nx-h3">
              {c.colNs}
            </h3>
            <p className="nx-cmp-sum">{c.nsSum}</p>
            <ol className="nx-cmp-list">
              {c.rows.map((row) => {
                const yours = YOURS.has(row.id);
                return (
                  <li key={row.id} data-yours={yours ? "true" : undefined}>
                    {yours ? <UserRound aria-hidden /> : <Check aria-hidden />}
                    <span>{row.step}</span>
                    {yours && <b>{c.keep}</b>}
                  </li>
                );
              })}
            </ol>
          </section>
        </div>
      </div>
    </section>
  );
}
