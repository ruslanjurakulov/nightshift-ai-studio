import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { ClipPause } from "@/components/site/ClipPause";
import { LoopClip } from "@/components/site/LoopClip";
import { SAMPLES, SLOTS, SlotImg, slotAlt, slotClip, slotPosition, slotSample, type SlotId } from "@/components/site/samples";
import { creditLine } from "@/lib/site/media";

/** The two things Nightshift is shown by (round 9 dropped the first of three, a still photograph, from a landing that had grown long): one section each, one picture each, never the same picture twice (components/site/samples.tsx SLOTS). */
const SHOWS: { id: "studio" | "approvals"; slot: SlotId; href: string }[] = [
  { id: "studio", slot: "show.studio", href: "/signup" },
  { id: "approvals", slot: "show.approvals", href: "/solutions/youtube-channels" },
];

/**
 * Two full-width showcases: a large rounded picture, the headline over its lower edge, then a sentence and one
 * outlined button. On a phone the picture is shown whole and bright (4:5, nothing over it but the label and a short
 * dark panel under the headline); the sentence and the button sit on solid dark below it. On a desktop the words sit
 * on the left over a gradient. Wherever words are over the picture the overlay is at least 74% opaque, so white on it
 * reads at 4.5:1 or better even over the brightest pixel of any picture (tests/site-engage.test.tsx works the numbers
 * from the stops in site-next.css). Two of them play a looped clip of stock footage over their own first frame (see
 * LoopClip); every picture says it is an example and who made it, and a visible line under the card says what the
 * pictures are: stock photos and footage, not output from a real account.
 */
export function Showcases({ t }: { t: Dictionary }) {
  const items = SHOWS.map((s) => ({ ...s, item: t.site.caps.items.find((i) => i.id === s.id)! }));
  const sm = t.site.samples;
  return (
    <div className="nx-shows">
      {items.map(({ id, slot, href, item }) => {
        const clip = slotClip(slot);
        const sample = slotSample(slot);
        return (
          <section key={id} id={id} aria-labelledby={`show-${id}-title`} className="nx-show">
            <div className="nx-wrap">
              <div className="nx-show-card">
                <div className="nx-show-pic" data-clip={clip ?? undefined}>
                  <SlotImg slot={slot} alt={slotAlt(sm.alts, slot)} className="nx-art" sizes="(min-width: 1240px) 1160px, 100vw" />
                  {clip && <LoopClip clip={clip} poster={SAMPLES[SLOTS[slot].id].sm} position={slotPosition(slot)} />}
                  <span className="nx-result-badge" data-kind="still">
                    {sample.footage ? sm.frameTag : sm.tag}
                  </span>
                  {clip && (
                    <span className="nx-result-badge" data-kind="clip">
                      {sm.clipTag}
                    </span>
                  )}
                  <span className="nx-result-credit">{creditLine(sample.id, sm.credit)}</span>
                  {clip && <ClipPause label={t.site.fx.pause} />}
                </div>
                <div className="nx-show-text">
                  <div className="nx-show-head">
                    <p className="nx-show-label">{item.pill}</p>
                    <h2 id={`show-${id}-title`} className="nx-show-h">
                      {item.title}
                    </h2>
                  </div>
                  <div className="nx-show-rest">
                    <p className="nx-show-body">{item.body}</p>
                    <Link href={href} className="nx-show-cta">
                      {item.cta}
                    </Link>
                  </div>
                </div>
              </div>
              <p className="nx-show-note">{`${sm.note} ${sm.clipNote}`}</p>
            </div>
          </section>
        );
      })}
    </div>
  );
}
