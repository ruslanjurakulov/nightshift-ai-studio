import { Check } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { BrandMark } from "@/components/site/BrandMark";
import { SampleImg } from "@/components/site/samples";

/**
 * The hero's picture: one chat exchange, the shape of the whole product. You
 * ask for a video (one line), Nightshift's reply comes back with a frame, and
 * the video waits, private, for the person to press publish.
 *
 * It is a still picture of the *idea*, and says so: the card is tagged
 * "Example", the reply row reads "example reply", the frame is one of the six
 * AI-generated example stills with its own badge and a visible note under the
 * card, and the drawn "Approve and publish" button is a span in an aria-hidden
 * group, never pressable. Nothing in it moves, so there is nothing to pause;
 * its size is fixed by aspect-ratio boxes, so it cannot shift the page. A
 * Server Component: no script, and the frame is the only image on the first
 * screen (eager, high priority).
 */
export function HeroCard({ t }: { t: Dictionary }) {
  const st = t.site.stage;
  const approve = st.steps.find((s) => s.id === "approve" && "check" in s) as Extract<(typeof st.steps)[number], { check: string }>;
  const ask = t.site.caps.items[0].bubble;
  return (
    <figure className="nx-demo nx-chat" data-spot aria-label={st.figure}>
      <span className="nx-demo-tag" aria-hidden>
        {st.tag}
      </span>
      <div className="nx-demo-body">
        <ol className="nx-chat-rail">
          {st.steps.map((s, i) => (
            <li key={s.id} data-done={i < 2 ? "true" : undefined} aria-current={s.id === "approve" ? "step" : undefined}>
              {s.tab}
            </li>
          ))}
        </ol>
        <p className="nx-bubble">{ask}</p>
        <div className="nx-reply">
          <BrandMark size={32} />
          <b>{t.brand.name}</b>
          <span>
            <Check aria-hidden />
            {t.site.caps.exampleReply}
          </span>
        </div>
        <div className="nx-result nx-result-sign">
          <div className="nx-result-art nx-kb" data-ratio="wide">
            <SampleImg id="silkroad" alt={t.site.samples.alts.silkroad} className="nx-art" eager />
            <span className="nx-result-badge">{t.site.samples.tag}</span>
          </div>
          <ul className="nx-ui-status">
            <li>
              <span className="nx-dot" data-tone="ok" />
              {approve.lamp}
            </li>
            <li>
              <span className="nx-dot" data-tone="ok" />
              {approve.check}
            </li>
            <li data-lit="true">
              <span className="nx-dot" data-tone="run" />
              {approve.waiting}
            </li>
          </ul>
        </div>
        <div className="nx-chat-foot" aria-hidden>
          <span>{st.tag}</span>
          <span className="nx-chat-key">{approve.key}</span>
        </div>
      </div>
      <figcaption className="nx-demo-note">{t.site.samples.note}</figcaption>
    </figure>
  );
}
