"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Clapperboard, Image as ImageIcon, Pause, Play } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { templateCreateHref, type TemplateDto } from "@/lib/templates/trends";

/**
 * One template card: the poster, then a muted looping preview on hover or focus (a pointer that hovers) or on a tap (touch).
 * Reduced motion: the poster only, no video element at all. With no poster yet, the designed poster state (a gradient in the
 * kind's colour and its icon), never a stock picture.
 *
 * "Use template" is a plain link to Create with ?template=<slug>: it fills the form and stops (rule 3). When the template's
 * model is measured as not on sale, the card says so and offers no link — Create would have nothing honest to open with, and no
 * other model is named in its place (rule 4). An unknown availability is shown as unknown, and the link stays: Create decides.
 */
export function TrendCard({ template, reduced, canHover }: { template: TemplateDto; reduced: boolean; canHover: boolean }) {
  const { t } = useI18n();
  const tt = t.trends;
  const path = useChannelPath();
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const hasPreview = Boolean(template.preview_url) && !reduced;
  const Icon = template.kind === "video" ? Clapperboard : ImageIcon;

  const play = () => {
    const v = video.current;
    if (!v) return;
    // A refused play (autoplay policy, a missing file) leaves the poster showing; nothing else depends on it.
    v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };
  const stop = () => {
    const v = video.current;
    if (!v) return;
    v.pause();
    setPlaying(false);
  };

  const hoverHandlers = hasPreview && canHover ? { onPointerEnter: play, onPointerLeave: stop, onFocus: play, onBlur: stop } : {};
  const meta = [tt.kind[template.kind], template.aspect, template.duration_s ? fmt(tt.seconds, { n: template.duration_s }) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="tr-card" data-template={template.slug} data-kind={template.kind} data-model-status={template.model_status} {...hoverHandlers}>
      <div className="tr-media" data-aspect={template.aspect}>
        {template.poster_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- a public bucket object; next/image would need a remote pattern for it.
          <img src={template.poster_url} alt="" loading="lazy" decoding="async" className="tr-poster" />
        ) : (
          <div className="tr-placeholder" aria-hidden>
            <Icon className="size-8" strokeWidth={1.6} />
            <span>{tt.noPreview}</span>
          </div>
        )}
        {hasPreview && (
          <video
            ref={video}
            className="tr-video"
            data-playing={playing ? "true" : "false"}
            src={template.preview_url}
            poster={template.poster_url}
            muted
            loop
            playsInline
            preload="none"
            aria-hidden
            tabIndex={-1}
            onEnded={() => setPlaying(false)}
          />
        )}
        {hasPreview && !canHover && (
          <button type="button" className="tr-play tap" onClick={playing ? stop : play} aria-label={playing ? tt.pause : tt.play} aria-pressed={playing}>
            {playing ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}
          </button>
        )}
      </div>
      <div className="tr-body">
        <p className="tr-meta">{meta}</p>
        <h3 className="tr-title">{template.title}</h3>
        <p className="tr-desc">{template.description}</p>
        {template.model_status === "unavailable" ? (
          <p className="tr-note" data-tone="warn">{tt.modelUnavailable}</p>
        ) : (
          <>
            {template.model_status === "unknown" && <p className="tr-note">{tt.modelUnknown}</p>}
            <Link href={path(templateCreateHref(template.slug))} className="btn-primary tr-use press" aria-label={fmt(tt.useAria, { title: template.title })}>
              {tt.use}
            </Link>
          </>
        )}
      </div>
    </article>
  );
}

export function TrendCardSkeleton() {
  return (
    <div className="tr-card" aria-hidden>
      <div className="tr-media skeleton" data-aspect="9:16" />
      <div className="tr-body">
        <div className="skeleton h-3 w-24" />
        <div className="skeleton h-5 w-40" />
        <div className="skeleton h-3 w-full" />
      </div>
    </div>
  );
}
