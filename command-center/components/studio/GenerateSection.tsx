"use client";

import { useRef, useState, type CSSProperties } from "react";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { JobFeed } from "@/components/studio/JobFeed";
import { TemplateGallery } from "@/components/studio/TemplateGallery";
import { useI18n } from "@/lib/i18n/context";
import { defaultDescribeLanguage, describePrefill, type StudioModel, type StudioPrefill } from "@/lib/creative/studio";
import type { UpsellCatalog } from "@/lib/upsell";
import type { StudioDna } from "@/lib/channel-dna";
import { DESK_TOOLS, type MediaDesk } from "@/lib/creative/desks";
import type { FeedVariant } from "@/components/studio/JobFeed";
import "@/components/studio/desk.css";

/** How each desk shows what it made (components/studio/JobFeed variants). */
const DESK_FEED: Record<MediaDesk, FeedVariant> = { video: "monitor", image: "table", enhance: "table", voice: "takes" };

/**
 * The Studio's "make one thing" half: the composer on the left (sticky from
 * `lg` up), the canvas of what it made on the right — templates as a strip
 * above the results. On a phone the composer comes first, its Generate pinned
 * above the bottom tab bar, and the results follow as a two-column grid.
 *
 * "Try again" and a template refill the composer (a fresh mount with those
 * settings); "Use as picture" hands a finished picture to it without clearing
 * the words. "Describe" on a finished picture opens the composer on Describe
 * with that picture, and "Make similar" on a description opens it on Image with
 * the text. None of them starts a generation: only the priced press does.
 */
export function GenerateSection({
  orgId,
  models,
  initial = null,
  defaultStyleKitId = null,
  dna = null,
  bottomBar = true,
  plans = null,
  desk = null,
}: {
  /**
   * The desk this section is (lib/creative/desks): its tools only, laid out
   * around its job — Video's monitor over a docked slate, Image's light table
   * beside the composer, Enhance's loupe with the composer on the right,
   * Voice's booth over its takes. Absent: every tool, composer then canvas.
   */
  desk?: MediaDesk | null;
  orgId: string;
  models: StudioModel[];
  /** From the Library's "Use in Studio" link; fills the form only. */
  initial?: StudioPrefill | null;
  /** The open channel's default style kit (0047), if it has one. */
  defaultStyleKitId?: string | null;
  /** The open channel's DNA (0056), for a form that starts fresh. */
  dna?: (StudioDna & { href: string }) | null;
  /** The phone's bottom tab bar is shown (not for the platform operator): Generate docks above it. */
  bottomBar?: boolean;
  /** What the plan dialog may offer when a generation is refused (lib/upsell.ts); null = no dialog. */
  plans?: UpsellCatalog | null;
}) {
  const [prefill, setPrefill] = useState<{ nonce: number; value: StudioPrefill } | null>(
    initial ? { nonce: 0, value: initial } : null,
  );
  const [sourceRequest, setSourceRequest] = useState<{ nonce: number; id: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { t, locale } = useI18n();
  const top = useRef<HTMLDivElement>(null);

  const toComposer = () => top.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });

  const fill = (value: StudioPrefill) => {
    // A fresh composer: a picture handed in earlier must not come back with it.
    setSourceRequest(null);
    setPrefill((p) => ({ nonce: (p?.nonce ?? 0) + 1, value }));
    toComposer();
  };

  const pickAsSource = (id: string) => {
    setSourceRequest((r) => ({ nonce: (r?.nonce ?? 0) + 1, id }));
    toComposer();
  };

  const describe = (id: string) => {
    const value = describePrefill(id, defaultDescribeLanguage(locale));
    if (value) fill(value);
  };

  const dock = { "--studio-dock-offset": bottomBar ? "60px" : "0px" } as CSSProperties;

  const panel = (
    <GeneratePanel
      key={prefill?.nonce ?? 0}
      orgId={orgId}
      models={models}
      initial={prefill?.value ?? null}
      defaultStyleKitId={defaultStyleKitId}
      // A retried job or a template brings its own settings: DNA starts only the page's own form.
      dna={prefill && prefill.nonce > 0 ? null : dna}
      sourceRequest={sourceRequest}
      plans={plans}
      desk={desk}
      onCreated={() => setRefreshKey((k) => k + 1)}
    />
  );

  if (desk) {
    const tools = DESK_TOOLS[desk];
    const deskHas = (c: (typeof tools)[number]) => tools.includes(c);
    return (
      <div className="desk-layout" data-desk={desk} style={dock}>
        <div ref={top} className="desk-layout-composer scroll-mt-24" data-testid="gen-composer">
          {panel}
        </div>
        <div className="desk-layout-canvas flex min-w-0 flex-col gap-6" data-testid="gen-canvas">
          <TemplateGallery onPick={fill} only={tools} />
          <JobFeed
            orgId={orgId}
            models={models}
            refreshKey={refreshKey}
            capabilities={tools}
            variant={DESK_FEED[desk]}
            title={t.desk.feedTitle[desk]}
            emptyTitle={t.desk.emptyTitle[desk]}
            emptyBody={t.desk.empty[desk]}
            onRetry={fill}
            // A picture result goes back into this desk's picture tools; Describe and
            // "Make similar" only where the desk has those tools (the Image desk).
            onUseAsSource={tools.some((c) => c === "edit" || c === "i2v" || c === "upscale" || c === "remove_bg") ? pickAsSource : undefined}
            onDescribe={deskHas("describe") ? describe : undefined}
            onMakeSimilar={deskHas("t2i") ? fill : undefined}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(340px,384px)_minmax(0,1fr)]" style={dock}>
      <div
        ref={top}
        className="scroll-mt-24 lg:sticky lg:top-[96px] lg:max-h-[calc(100dvh-112px)] lg:overflow-y-auto lg:rounded-[var(--ns-r-sheet)]"
        data-testid="gen-composer"
      >
        {panel}
      </div>
      <div className="flex min-w-0 flex-col gap-6" data-testid="gen-canvas">
        <TemplateGallery onPick={fill} />
        <JobFeed
          orgId={orgId}
          models={models}
          refreshKey={refreshKey}
          onRetry={fill}
          onUseAsSource={pickAsSource}
          onDescribe={describe}
          onMakeSimilar={fill}
        />
      </div>
    </div>
  );
}
