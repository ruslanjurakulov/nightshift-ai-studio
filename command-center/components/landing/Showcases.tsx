import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { SLOTS, SlotImg, type SlotId } from "@/components/site/samples";

/** The three things Nightshift is shown by: one section each, one still each, never the same still twice (components/site/samples.tsx SLOTS). */
const SHOWS: { id: "video" | "studio" | "approvals"; slot: SlotId; href: string }[] = [
  { id: "video", slot: "show.video", href: "/signup" },
  { id: "studio", slot: "show.studio", href: "/signup" },
  { id: "approvals", slot: "show.approvals", href: "/solutions/youtube-channels" },
];

/**
 * Three full-width showcases: a rounded still with the headline over it, a
 * sentence and one outlined button. The text sits on a dark overlay that is at
 * least 70% opaque wherever words are, so white on it reads at 4.5:1 even over
 * the brightest pixel of any still (tests/site-engage.test.tsx works the numbers
 * from the stops in site-next.css). The still is an example and says so on the
 * picture, and a visible line under the card says what the pictures are; the
 * description is the image's alt, the words are real text.
 */
export function Showcases({ t }: { t: Dictionary }) {
  const items = SHOWS.map((s) => ({ ...s, item: t.site.caps.items.find((i) => i.id === s.id)! }));
  return (
    <div className="nx-shows">
      {items.map(({ id, slot, href, item }) => (
        <section key={id} id={id} aria-labelledby={`show-${id}-title`} className="nx-show">
          <div className="nx-wrap">
            <div className="nx-show-card">
              <div className="nx-show-pic nx-kb">
                <SlotImg slot={slot} alt={t.site.samples.alts[SLOTS[slot].id]} className="nx-art" />
              </div>
              <span className="nx-result-badge">{t.site.samples.tag}</span>
              <div className="nx-show-text">
                <p className="nx-show-label">{item.pill}</p>
                <h2 id={`show-${id}-title`} className="nx-show-h">
                  {item.title}
                </h2>
                <p className="nx-show-body">{item.body}</p>
                <Link href={href} className="nx-show-cta">
                  {item.cta}
                </Link>
              </div>
            </div>
            <p className="nx-show-note">{t.site.samples.note}</p>
          </div>
        </section>
      ))}
    </div>
  );
}
