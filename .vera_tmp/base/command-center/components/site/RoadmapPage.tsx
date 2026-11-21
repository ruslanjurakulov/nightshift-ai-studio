import type { Dictionary } from "@/lib/i18n";
import { ROADMAP_ITEMS, shownNames } from "@/lib/roadmap";
import "@/components/site/roadmap-page.css";

/**
 * /roadmap: the owner's approved list of what is coming, in the master order, then the closing line. Nothing else:
 * no status, date, figure, button or name (lib/roadmap.ts). A Server Component; the frame is PublicShell's.
 *
 * Each item is looked up by id in the dictionary, so the data file decides what is shown and in which order, and an
 * item's names (none today) appear only through shownNames(), i.e. only when the item is marked nameable.
 */
export function RoadmapPage({ t }: { t: Dictionary }) {
  const r = t.site.roadmap;
  const items = ROADMAP_ITEMS.flatMap((item) => {
    const copy = r.items.find((c) => c.id === item.id);
    return copy ? [{ ...copy, names: shownNames(item) }] : [];
  });
  return (
    <>
      <section aria-labelledby="roadmap-title" className="rm-main">
        <div className="nx-wrap">
          <h1 id="roadmap-title" className="st-h1-page">
            {r.title}
          </h1>
          <ul className="rm-list">
            {items.map((item) => (
              <li key={item.id} className="rm-item" data-id={item.id}>
                <h2 className="rm-item-title">{item.title}</h2>
                {item.body && <p className="rm-item-body">{item.body}</p>}
                {item.names.length > 0 && <p className="rm-item-names">{item.names.join(", ")}</p>}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="roadmap-closing" className="nx-final-wrap rm-closing">
        <div className="nx-wrap">
          <div className="nx-final">
            <h2 id="roadmap-closing" className="nx-h2">
              {r.closing.title}
            </h2>
            <p className="rm-closing-body">{r.closing.body}</p>
            <p className="rm-soon">{r.closing.soon}</p>
          </div>
        </div>
      </section>
    </>
  );
}
