import type { Dictionary } from "@/lib/i18n";
import { ResultsCarousel } from "@/components/docs/ResultsCarousel";
import { SAMPLES, SampleImg, type SampleId } from "@/components/site/samples";

const ORDER: SampleId[] = ["silkroad", "library", "moon", "nightmarket", "valley", "lighthouse"];

/**
 * "What comes back": the six example frames as a rail that scrolls sideways
 * with snap. The same carousel the /mcp page uses (a labelled group, a
 * keyboard-reachable track, two 44px buttons, nothing moves by itself, so
 * there is nothing to pause), with each frame's one-line ask printed under it
 * and "Example frame" on it. The lead says in words that they are AI-generated
 * stills made for the page and not output from a real account.
 */
export function Gallery({ t }: { t: Dictionary }) {
  const g = t.site.gallery;
  const tag = t.site.samples.tag;
  return (
    <section id="examples" aria-labelledby="gallery-title" className="nx-section nx-gal" data-tone="raised">
      <div className="nx-wrap">
        <p className="nx-label">{g.label}</p>
        <h2 id="gallery-title" className="nx-h2">
          {g.title}
        </h2>
        <p className="nx-sub">{g.lead}</p>
      </div>
      <div className="nx-gal-rail">
        <ResultsCarousel
          slideLabel={g.slide}
          labels={{ region: g.region, track: g.track, prev: g.prev, next: g.next }}
          cards={ORDER.map((id) => {
            const s = SAMPLES[id];
            return (
              <figure key={id} className="nx-gal-card" data-portrait={s.height > s.width ? "true" : undefined}>
                <div className="nx-gal-pic nx-kb">
                  <SampleImg id={id} className="nx-art" />
                  <span className="nx-result-badge">{tag}</span>
                </div>
                <figcaption>{g.items[id]}</figcaption>
              </figure>
            );
          })}
        />
      </div>
    </section>
  );
}
