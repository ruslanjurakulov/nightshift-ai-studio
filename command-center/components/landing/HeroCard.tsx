import { Check } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { BrandMark } from "@/components/site/BrandMark";
import { SLOTS, SlotImg, type SlotId } from "@/components/site/samples";

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
  note: string;
  lamps: [string, string, string];
  key: string;
};

/** The chat card's words from the site dictionary; `ask` replaces the default one-line ask. */
export function chatCopy(t: Dictionary, slot: SlotId = "hero", ask?: string): ChatCopy {
  const st = t.site.stage;
  const approve = st.steps.find((s) => s.id === "approve" && "check" in s) as Extract<(typeof st.steps)[number], { check: string }>;
  return {
    figure: st.figure,
    tag: st.tag,
    brand: t.brand.name,
    steps: st.steps.map((s) => ({ id: s.id, tab: s.tab })),
    current: "approve",
    ask: ask ?? t.site.caps.items[0].bubble,
    reply: t.site.caps.exampleReply,
    alt: t.site.samples.alts[SLOTS[slot].id],
    badge: t.site.samples.tag,
    note: t.site.samples.note,
    lamps: [approve.lamp, approve.check, approve.waiting],
    key: approve.key,
  };
}

/**
 * The chat card, the shape of the whole product in one picture: you ask for a
 * video (one line), Nightshift's reply comes back with a frame, and the video
 * waits, private, for the person to press publish.
 *
 * It is a still picture of the *idea*, and says so: the card is tagged
 * "Example", the reply row reads "example reply", the frame is an example still
 * with its own badge and a visible note under the card, and the drawn "Approve
 * and publish" button is a span in an aria-hidden group, never pressable.
 * Nothing in it can be pressed; its frame has a fixed aspect ratio, so it
 * cannot shift the page. The frame drifts very slowly (the page's pause switch
 * and reduced motion stop it). A Server Component.
 */
export function ChatCard({ copy, slot = "hero", eager = false, className = "" }: { copy: ChatCopy; slot?: SlotId; eager?: boolean; className?: string }) {
  return (
    <figure className={`nx-demo nx-chat ${className}`.trim()} data-spot aria-label={copy.figure}>
      <span className="nx-demo-tag" aria-hidden>
        {copy.tag}
      </span>
      <div className="nx-demo-body">
        <ol className="nx-chat-rail">
          {copy.steps.map((s, i) => (
            <li key={s.id} data-done={i < 2 ? "true" : undefined} aria-current={s.id === copy.current ? "step" : undefined}>
              {s.tab}
            </li>
          ))}
        </ol>
        <p className="nx-bubble">{copy.ask}</p>
        <div className="nx-reply">
          <BrandMark size={32} />
          <b>{copy.brand}</b>
          <span>
            <Check aria-hidden />
            {copy.reply}
          </span>
        </div>
        <div className="nx-result nx-result-sign">
          <div className="nx-result-art nx-kb" data-ratio="wide">
            <SlotImg slot={slot} alt={copy.alt} className="nx-art" eager={eager} />
            <span className="nx-result-badge">{copy.badge}</span>
          </div>
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
