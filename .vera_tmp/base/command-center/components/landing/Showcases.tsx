import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { ClipPause } from "@/components/site/ClipPause";
import { slotMedia, type SlotId } from "@/components/site/samples";
import { PlaceFill, placeBox, placeNote } from "@/components/site/PlaceFill";
import { ApprovalCard } from "@/components/landing/ApprovalCard";
import { studioToolsOpen } from "@/lib/site/tool-samples";

/**
 * The two things Nightshift is shown by: one section each. The Studio's picture is its slot (components/site/slots.ts SLOTS), a
 * thing the Studio made; the Approvals one is a drawn approval screen (ApprovalCard), because its words are about a decision, and
 * no generated scene illustrates "nothing airs until you say so".
 */
/** Where "See how approval works" goes: the page that spells out who may publish what. The third step of "How it works" links here too. */
export const APPROVALS_HREF = "/solutions/youtube-channels";

const SHOWS: { id: "studio" | "approvals"; slot: SlotId | null; href: string }[] = [
  { id: "studio", slot: "show.studio", href: "/signup" },
  { id: "approvals", slot: null, href: APPROVALS_HREF },
];

/**
 * Two full-width showcases: a large rounded picture, the headline over its lower edge, then a sentence and one
 * outlined button. On a phone the picture is shown whole and bright (4:5, nothing over it but the label and a short
 * dark panel under the headline); the sentence and the button sit on solid dark below it. On a desktop the words sit
 * on the left over a gradient. Wherever words are over the picture the overlay is at least 74% opaque, so white on it
 * reads at 4.5:1 or better even over the brightest pixel of any picture (tests/site-engage.test.tsx works the numbers
 * from the stops in site-next.css). A slot's picture is one of our generations, labelled with the AI badge (its badge only: the
 * picture is the section's backdrop, not its subject), or the stock fallback, labelled an example with its contributor's
 * credit, with the stock sentence under the card. The drawn approval screen is on its own dark stage, with the headline under it
 * on a phone (data-art="drawn"), so nothing covers the screen it draws.
 */
export function Showcases({ t }: { t: Dictionary }) {
  const items = SHOWS.map((s) => ({ ...s, item: t.site.caps.items.find((i) => i.id === s.id)!, media: s.slot ? slotMedia(s.slot) : null }));
  return (
    <div className="nx-shows">
      {items.map(({ id, href, item, media }) => {
        const moving = media ? (media.kind === "ai" ? media.moving : media.clip !== null) : false;
        const note = media ? placeNote(media, t.site) : null;
        return (
          <section key={id} id={id} aria-labelledby={`show-${id}-title`} className="nx-show">
            <div className="nx-wrap">
              <div className="nx-show-card" data-art={media ? undefined : "drawn"}>
                {media ? (
                  <div className="nx-show-pic" {...placeBox(media, true)}>
                    <PlaceFill media={media} s={t.site} sizes="(min-width: 1240px) 1160px, 100vw" />
                    {moving && <ClipPause label={t.site.fx.pause} />}
                  </div>
                ) : (
                  <div className="nx-show-pic" data-media="drawn">
                    <ApprovalCard t={t} />
                  </div>
                )}
                <div className="nx-show-text">
                  <div className="nx-show-head">
                    <p className="nx-show-label">{item.pill}</p>
                    <h2 id={`show-${id}-title`} className="nx-show-h">
                      {item.title}
                    </h2>
                  </div>
                  <div className="nx-show-rest">
                    {/* The Studio band says its models are not on sale while none is (lib/site/tool-samples.ts studioToolsOpen). */}
                    <p className="nx-show-body">{!studioToolsOpen() && "bodyClosed" in item ? item.bodyClosed : item.body}</p>
                    <Link href={href} className="nx-show-cta">
                      {item.cta}
                    </Link>
                  </div>
                </div>
              </div>
              {note && <p className="nx-show-note">{note}</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
