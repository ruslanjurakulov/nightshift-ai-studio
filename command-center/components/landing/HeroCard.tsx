import { Check } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { BrandMark } from "@/components/site/BrandMark";
import { BrandArt, type BrandArtKind } from "@/components/site/BrandArt";
import { TypedText } from "@/components/site/TypedText";
import { slotMedia, type PlaceMedia, type SlotId } from "@/components/site/samples";
import { PlaceFill, placeAlt, placeBox, placeNote } from "@/components/site/PlaceFill";
import { placeTry } from "@/components/site/place-try";

/** Everything a chat card says, as plain strings, so any page (the landing, /pricing, /mcp) can print one from its own dictionary. */
export type ChatCopy = {
  figure: string;
  tag: string;
  brand: string;
  steps: { id: string; tab: string }[];
  current: string;
  ask: string;
  reply: string;
  alt: string;
  badge: string;
  /** The sentence under the card: what its picture is (stock, or one of our generations), or the caller's own. */
  note: string;
  /** What the card's slot shows (components/site/samples.tsx slotMedia), and the site dictionary its labels come from. */
  media: PlaceMedia;
  site: Dictionary["site"];
  lamps: [string, string, string];
  key: string;
};

/** The chat card's words from the site dictionary; `ask` replaces the default one-line ask, `opts` the picture's label and note (for drawn art). */
export function chatCopy(t: Dictionary, slot: SlotId = "hero", ask?: string, opts?: { badge?: string; note?: string }): ChatCopy {
  const st = t.site.stage;
  const media = slotMedia(slot);
  const approve = st.steps.find((s) => s.id === "approve" && "check" in s) as Extract<(typeof st.steps)[number], { check: string }>;
  return {
    figure: st.figure,
    tag: st.tag,
    brand: t.brand.name,
    steps: st.steps.map((s) => ({ id: s.id, tab: s.tab })),
    current: "approve",
    ask: ask ?? t.site.caps.items[0].bubble,
    reply: t.site.caps.exampleReply,
    alt: placeAlt(media, t.site),
    badge: opts?.badge ?? t.site.stage.tag,
    note: opts?.note ?? placeNote(media, t.site),
    media,
    site: t.site,
    lamps: [approve.lamp, approve.check, approve.waiting],
    key: approve.key,
  };
}

/**
 * The chat card, the shape of the whole product in one picture: you ask for a video (one line, typed as you watch), a
 * reply comes back with a frame, and the video waits, private, for the person to press publish.
 *
 * It is a picture of the *idea*, and says so: the card is tagged "Example", the reply row reads "example reply", the frame
 * is an example (a still with its badge and a visible note under the card, or drawn art with its own label), and the drawn
 * "Approve and publish" button is a span in an aria-hidden group, never pressable. The story plays once, in CSS only, and
 * rests on its last state: the ask types, the reply arrives, the rail goes Topic, Plan, Approve (never Live: nothing goes live
 * until the person presses the button) and the lamps and the button light, in that order (".nx-chat" in site-next.css). With
 * reduced motion, the pause switch or no script that last state is simply what is there, and it is what the server renders,
 * so nothing flashes. The drawn parts cannot be pressed; the only links are a sample's own credit and "Try this prompt", when
 * the slot shows one of our generations (components/site/PlaceFill.tsx). Its frame has a fixed aspect ratio, so it cannot
 * shift the page. A Server Component.
 *
 * `art` puts a drawing where the picture goes (the /mcp card); otherwise the frame is whatever chatCopy's slot shows.
 */
export function ChatCard({
  copy,
  eager = false,
  className = "",
  art,
  bare = false,
  compactClip = false,
}: {
  copy: ChatCopy;
  eager?: boolean;
  className?: string;
  art?: BrandArtKind;
  /** No picture at all: the card is the idea (an ask, a reply, the wait for approval) and shows nothing that looks like a result. */
  bare?: boolean;
  /** The card is never wider than about 560 px, so its clip uses the 640 px file on any screen. */
  compactClip?: boolean;
}) {
  const m = copy.media;
  const current = Math.max(0, copy.steps.findIndex((s) => s.id === copy.current));
  return (
    <figure className={`nx-demo nx-chat ${className}`.trim()} data-spot aria-label={copy.figure}>
      <span className="nx-demo-tag" aria-hidden>
        {copy.tag}
      </span>
      <div className="nx-demo-body">
        <ol className="nx-chat-rail">
          {copy.steps.map((s, i) => (
            <li key={s.id} data-done={i < current ? "true" : undefined} data-current={i === current ? "true" : undefined}>
              {s.tab}
            </li>
          ))}
        </ol>
        <p className="nx-bubble">
          <TypedText text={copy.ask} />
        </p>
        <div className="nx-reply">
          <BrandMark size={32} />
          <b>{copy.brand}</b>
          <span>
            <Check aria-hidden />
            {copy.reply}
          </span>
        </div>
        <div className="nx-result nx-result-sign">
          {!bare && (
            <div className="nx-result-art" data-ratio="wide" {...(art ? {} : placeBox(m))}>
              {art ? (
                <>
                  <BrandArt kind={art} className="nx-art" />
                  <span className="nx-result-badge" data-kind="still">
                    {copy.badge}
                  </span>
                </>
              ) : (
                <PlaceFill media={m} s={copy.site} alt={copy.alt} tryHref={placeTry(m)} eager={eager} early={eager} compact={compactClip} sizes="(min-width: 640px) 520px, calc(100vw - 80px)" />
              )}
            </div>
          )}
          <ul className="nx-ui-status">
            <li>
              <span className="nx-dot" data-tone="ok" />
              {copy.lamps[0]}
            </li>
            <li>
              <span className="nx-dot" data-tone="ok" />
              {copy.lamps[1]}
            </li>
            <li data-lit="true">
              <span className="nx-dot" data-tone="run" />
              {copy.lamps[2]}
            </li>
          </ul>
        </div>
        <div className="nx-chat-foot" aria-hidden>
          <span>{copy.tag}</span>
          <span className="nx-chat-key">{copy.key}</span>
        </div>
      </div>
      <figcaption className="nx-demo-note">{copy.note}</figcaption>
    </figure>
  );
}
