import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { ClipPause } from "@/components/site/ClipPause";
import { LoopClip } from "@/components/site/LoopClip";
import { CLIPS, SAMPLES, SLOTS, SlotImg, slotAlt, slotClip, type SlotId } from "@/components/site/samples";

/** The three things Nightshift is shown by: one section each, one still each, never the same still twice (components/site/samples.tsx SLOTS). */
const SHOWS: { id: "video" | "studio" | "approvals"; slot: SlotId; href: string }[] = [
  { id: "video", slot: "show.video", href: "/signup" },
  { id: "studio", slot: "show.studio", href: "/signup" },
  { id: "approvals", slot: "show.approvals", href: "/solutions/youtube-channels" },
];

/**
 * Three full-width showcases: a large rounded still, the headline over its lower edge, then a sentence and one
 * outlined button. On a phone the picture is shown whole and bright (4:5, nothing over it but the label and a short
 * dark panel under the headline); the sentence and the button sit on solid dark below it. On a desktop the words sit
 * on the left over a gradient. Wherever words are over the picture the overlay is at least 74% opaque, so white on it
 * reads at 4.5:1 or better even over the brightest pixel of any still (tests/site-engage.test.tsx works the numbers
 * from the stops in site-next.css). The first two play a slow clip over their still (see LoopClip); the picture says
 * it is an example, and a visible line under the card says what the pictures are.
 */
export function Showcases({ t }: { t: Dictionary }) {
  const items = SHOWS.map((s) => ({ ...s, item: t.site.caps.items.find((i) => i.id === s.id)! }));
  const sm = t.site.samples;
  return (
    <div className="nx-shows">
      {items.map(({ id, slot, href, item }) => {
        const clip = slotClip(slot);
        return (
          <section key={id} id={id} aria-labelledby={`show-${id}-title`} className="nx-show">
            <div className="nx-wrap">
              <div className="nx-show-card">
                <div className="nx-show-pic nx-kb" data-clip={clip ?? undefined}>
                  <SlotImg slot={slot} alt={slotAlt(sm.alts, slot)} className="nx-art" />
                  {clip && <LoopClip mp4={CLIPS[clip].mp4} webm={CLIPS[clip].webm} poster={SAMPLES[SLOTS[slot].id].src} />}
                  <span className="nx-result-badge" data-kind="still">
                    {sm.tag}
                  </span>
                  {clip && (
                    <span className="nx-result-badge" data-kind="clip">
                      {sm.clipTag}
                    </span>
                  )}
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
              <p className="nx-show-note">{clip ? `${sm.note} ${sm.clipNote}` : sm.note}</p>
            </div>
          </section>
        );
      })}
    </div>
  );
}
