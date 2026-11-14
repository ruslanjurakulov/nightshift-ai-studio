import { Check, Lock } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { EXAMPLE_THUMB_JOB, exampleMedia } from "@/components/site/samples";
import { PlaceFill, placeBox } from "@/components/site/PlaceFill";

/**
 * The Approvals band's picture: a drawn approval screen, so the band shows what its words say ("Nothing airs until you say so")
 * instead of scenery. The owner asked what a wave had to do with that sentence (2026-11-13); this is the answer: a finished video,
 * private on YouTube, the publish check passed, and the Approve key not pressed yet.
 *
 * It is an illustration and says so: tagged "Example", one `role="img"` with a description, and every part inside it is drawn, so
 * nothing in it can be pressed or focused (the key is a span). Its rows are the same words the product's own approval step uses
 * (`site.stage.steps` approve), so the picture never promises a state the product does not have. The video's title is that step's
 * example topic (football in 2050), so its thumbnail is that example's own 16:9 clip, made in our Studio from a prompt about the
 * topic (components/site/slots.ts EXAMPLE_THUMB_JOB), playing like every site clip and labelled AI-generated. A still there read as
 * "you asked for a video and got a picture", and a sample made from another prompt (a jungle explorer) said the result need not
 * match the ask (owner, 2026-11-14). No anchor: the model tiles link to the gallery's cards. A Server Component.
 */
export function ApprovalCard({ t }: { t: Dictionary }) {
  const st = t.site.stage;
  const approve = st.steps.find((s) => s.id === "approve" && "check" in s) as Extract<(typeof st.steps)[number], { check: string }>;
  const brief = st.steps.find((s) => s.id === "brief" && "field" in s) as Extract<(typeof st.steps)[number], { field: string }>;
  const m = exampleMedia(EXAMPLE_THUMB_JOB);
  return (
    <div className="nx-approve-art" role="img" aria-label={t.site.approvalCard.figure}>
      <div className="nx-approve-card" aria-hidden>
        <span className="nx-approve-tag">{st.tag}</span>
        <span className="nx-approve-thumb" {...(m ? placeBox(m) : {})}>
          {/* The description is the figure's (aria-label above); inside the aria-hidden drawing the picture has an empty alt. */}
          {m && <PlaceFill media={m} s={t.site} alt="" className="nx-approve-shot" compact sizes="(min-width: 860px) 360px, 90vw" labels={false} />}
          {m && <span className="nx-ai-badge">{t.site.gallery.badge}</span>}
          <span className="nx-approve-private">
            <Lock aria-hidden />
            {approve.lamp}
          </span>
        </span>
        <b className="nx-approve-title">{brief.field}</b>
        <ul className="nx-ui-status nx-approve-rows">
          <li>
            <Check aria-hidden className="nx-approve-ok" />
            {approve.check}
          </li>
          <li data-lit="true">
            <span className="nx-dot" data-tone="run" />
            {approve.waiting}
          </li>
        </ul>
        <span className="nx-approve-key" data-state="waiting">
          {approve.key}
        </span>
      </div>
    </div>
  );
}
