import { Check, Lock } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { ArtImg } from "@/components/site/art";
import { THUMB_ART } from "@/lib/site/art";

/**
 * The Approvals band's picture: a drawn approval screen, so the band shows what its words say ("Nothing airs until you say so")
 * instead of scenery. The owner asked what a wave had to do with that sentence (2026-11-13); this is the answer: a finished video,
 * private on YouTube, the publish check passed, and the Approve key not pressed yet.
 *
 * It is an illustration and says so: tagged "Example", one `role="img"` with a description, and every part inside it is drawn, so
 * nothing in it can be pressed or focused (the key is a span). Its rows are the same words the product's own approval step uses
 * (`site.stage.steps` approve), so the picture never promises a state the product does not have. The video's title is that step's
 * example topic (the Silk Road), so its thumbnail is the Silk Road example's own AI-generated picture (lib/site/art.ts THUMB_ART),
 * labelled AI-generated. Not a showcase sample: one made from another prompt (a jungle explorer) under this title said the result
 * need not match the prompt (owner, 2026-11-14), so the box names no sample job and no model. A Server Component.
 */
export function ApprovalCard({ t }: { t: Dictionary }) {
  const st = t.site.stage;
  const approve = st.steps.find((s) => s.id === "approve" && "check" in s) as Extract<(typeof st.steps)[number], { check: string }>;
  const brief = st.steps.find((s) => s.id === "brief" && "field" in s) as Extract<(typeof st.steps)[number], { field: string }>;
  return (
    <div className="nx-approve-art" role="img" aria-label={t.site.approvalCard.figure}>
      <div className="nx-approve-card" aria-hidden>
        <span className="nx-approve-tag">{st.tag}</span>
        <span className="nx-approve-thumb">
          {/* The description is the figure's (aria-label above); inside the aria-hidden drawing the picture has an empty alt. */}
          <ArtImg id={THUMB_ART} alt="" />
          <span className="nx-ai-badge">{t.site.gallery.badge}</span>
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
