import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { ClipPause } from "@/components/site/ClipPause";
import { slotMedia, type SlotId } from "@/components/site/samples";
import { AiCredit, PlaceFill, placeBox, placeNote } from "@/components/site/PlaceFill";
import { placeTry } from "@/components/site/place-try";

/** The two things Nightshift is shown by: one section each, one picture each, never the same picture twice (components/site/samples.tsx SLOTS). */
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
 * from the stops in site-next.css). Each picture is what its slot shows: one of our generations, labelled with its model and
 * "Try this prompt", or the stock fallback, labelled an example with its contributor's credit; the line under the card says which.
 */
export function Showcases({ t }: { t: Dictionary }) {
  const items = SHOWS.map((s) => ({ ...s, item: t.site.caps.items.find((i) => i.id === s.id)!, media: slotMedia(s.slot) }));
  return (
    <div className="nx-shows">
      {items.map(({ id, href, item, media }) => {
        const moving = media.kind === "ai" ? media.moving : media.clip !== null;
        return (
          <section key={id} id={id} aria-labelledby={`show-${id}-title`} className="nx-show">
            <div className="nx-wrap">
              <div className="nx-show-card">
                <div className="nx-show-pic" {...placeBox(media)}>
                  <PlaceFill media={media} s={t.site} tryHref={placeTry(media)} sizes="(min-width: 1240px) 1160px, 100vw" />
                  {moving && <ClipPause label={t.site.fx.pause} />}
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
              <p className="nx-show-note">{placeNote(media, t.site)}</p>
              {/* A phone's picture has the headline over it, so a sample's credit is printed under the card there (the stylesheet shows one of the two). */}
              {media.kind === "ai" && (
                <p className="nx-show-credit" {...placeBox({ ...media, moving: false })}>
                  <AiCredit entry={media.entry} g={t.site.gallery} href={placeTry(media)} scope={`show-${id}`} />
                </p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
