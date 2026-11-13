import { Check, Lock } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { APPROVAL_THUMB_JOB } from "@/lib/site/tool-samples";

/**
 * The Approvals band's picture: a drawn approval screen, so the band shows what its words say ("Nothing airs until you say so")
 * instead of scenery. The owner asked what a wave had to do with that sentence (2026-11-13); this is the answer: a finished video,
 * private on YouTube, the publish check passed, and the Approve key not pressed yet.
 *
 * It is an illustration and says so: tagged "Example", one `role="img"` with a description, and every part inside it is drawn, so
 * nothing in it can be pressed or focused (the key is a span). Its rows are the same words the product's own approval step uses
 * (`site.stage.steps` approve), so the picture never promises a state the product does not have. The thumbnail is one of our own
 * samples (lib/site/tool-samples.ts APPROVAL_THUMB_JOB), labelled AI-generated; the model is not named, because the video is not
 * the subject here. Without that sample's files the frame is simply empty, never a stock picture. A Server Component.
 */
export function ApprovalCard({ t }: { t: Dictionary }) {
  const st = t.site.stage;
  const approve = st.steps.find((s) => s.id === "approve" && "check" in s) as Extract<(typeof st.steps)[number], { check: string }>;
  const brief = st.steps.find((s) => s.id === "brief" && "field" in s) as Extract<(typeof st.steps)[number], { field: string }>;
  const entry = SHOWCASE_ENTRIES.find((e) => e.jobId === APPROVAL_THUMB_JOB);
  const files = entry ? SHOWCASE_FILES[entry.jobId] : undefined;
  return (
    // The model tiles link to the thumbnail's sample here (#sample-<job>): the anchor is on the described image, not inside the
    // aria-hidden drawing, so a jump lands on something assistive tech can read.
    <div className="nx-approve-art" role="img" aria-label={t.site.approvalCard.figure} id={entry && files ? `sample-${entry.jobId}` : undefined}>
      <div className="nx-approve-card" aria-hidden>
        <span className="nx-approve-tag">{st.tag}</span>
        <span className="nx-approve-thumb" {...(entry && files ? { "data-showcase-entry": entry.jobId, "data-model": entry.modelId } : {})}>
          {entry && files && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={files.posterSm} width={entry.width} height={entry.height} alt="" loading="lazy" decoding="async" data-sample-job={entry.jobId} />
              <span className="nx-ai-badge">{t.site.gallery.badge}</span>
            </>
          )}
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
