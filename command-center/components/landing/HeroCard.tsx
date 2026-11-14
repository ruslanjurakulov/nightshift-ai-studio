import { Check } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { BrandMark } from "@/components/site/BrandMark";
import { BrandArt, type BrandArtKind } from "@/components/site/BrandArt";
import { TypedText } from "@/components/site/TypedText";
import { EXAMPLE_THUMB_JOB, exampleMedia, slotMedia, type PlaceMedia, type SlotId } from "@/components/site/samples";
import { PlaceFill, placeAlt, placeBox, placeNote } from "@/components/site/PlaceFill";

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
  /** The sentence under the card: what its stock picture is, or the caller's own; null under one of our samples (it carries its AI badge, and no footnote, components/site/PlaceFill.tsx placeNote). */
  note: string | null;
  /**
   * What the card's frame shows, and the site dictionary its labels come from. Under the default ask (football in 2050) it is that
   * example's own clip (components/site/slots.ts EXAMPLE_THUMB_JOB), never the slot's: a reply under the example ask with a
   * chocolate pour in it said the result need not match the prompt (owner, 2026-11-14); null while that clip's files are not here,
   * and then the card has no frame rather than a stand-in. A caller's own ask shows its slot (components/site/samples.tsx slotMedia).
   */
  media: PlaceMedia | null;
  site: Dictionary["site"];
  lamps: [string, string, string];
  key: string;
};

/** The chat card's words from the site dictionary; `ask` replaces the default one-line ask, `opts` the picture's label and note (for drawn art). */
export function chatCopy(t: Dictionary, slot: SlotId = "hero", ask?: string, opts?: { badge?: string; note?: string }): ChatCopy {
  const st = t.site.stage;
  const media = ask === undefined ? exampleMedia(EXAMPLE_THUMB_JOB) : slotMedia(slot);
  const approve = st.steps.find((s) => s.id === "approve" && "check" in s) as Extract<(typeof st.steps)[number], { check: string }>;
  return {
    figure: st.figure,
    tag: st.tag,
    brand: t.brand.name,
    steps: st.steps.map((s) => ({ id: s.id, tab: s.tab })),
    current: "approve",
    ask: ask ?? t.site.caps.items[0].bubble,
    reply: t.site.caps.exampleReply,
    alt: ask === undefined ? t.site.how.thumbAlt : media ? placeAlt(media, t.site) : "",
    badge: opts?.badge ?? t.site.stage.tag,
    // A sample carries its AI badge on the frame and needs no stock sentence under it (placeNote is null for one).
    note: opts?.note ?? (media ? placeNote(media, t.site) : null),
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
 * so nothing flashes. Nothing in it can be pressed: a frame that shows one of our generations carries its AI badge
 * only (components/site/PlaceFill.tsx). Its frame has a fixed aspect ratio, so it cannot shift the page. A Server Component.
 *
 * `art` puts a drawing where the picture goes (the /mcp card); otherwise, under the default ask (football in 2050), the frame plays
 * that example's own clip (ChatCopy `media`), and under a caller's own ask it is whatever chatCopy's slot shows.
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
          {!bare && (art || m) && (
            <div className="nx-result-art" data-ratio="wide" {...(art || !m ? {} : placeBox(m))}>
              {art ? (
                <>
                  <BrandArt kind={art} className="nx-art" />
                  <span className="nx-result-badge" data-kind="still">
                    {copy.badge}
                  </span>
                </>
              ) : (
                m && <PlaceFill media={m} s={copy.site} alt={copy.alt} eager={eager} early={eager} compact={compactClip} sizes="(min-width: 640px) 520px, calc(100vw - 80px)" />
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
      {copy.note && <figcaption className="nx-demo-note">{copy.note}</figcaption>}
    </figure>
  );
}
