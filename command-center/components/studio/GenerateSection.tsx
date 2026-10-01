"use client";

import { useRef, useState } from "react";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { JobFeed } from "@/components/studio/JobFeed";
import { TemplateGallery } from "@/components/studio/TemplateGallery";
import type { StudioModel, StudioPrefill } from "@/lib/creative/studio";

/**
 * The Studio's "make one thing" half: the panel and the feed of what it made.
 * "Try again" on a card refills the panel (a fresh mount with the job's
 * settings) and scrolls to it — it never starts a generation by itself.
 * A template card above the panel does the same with a ready starting point.
 */
export function GenerateSection({
  orgId,
  models,
  initial = null,
  defaultStyleKitId = null,
}: {
  orgId: string;
  models: StudioModel[];
  /** From the Library's "Use in Studio" link; fills the form only. */
  initial?: StudioPrefill | null;
  /** The open channel's default style kit (0047), if it has one. */
  defaultStyleKitId?: string | null;
}) {
  const [prefill, setPrefill] = useState<{ nonce: number; value: StudioPrefill } | null>(
    initial ? { nonce: 0, value: initial } : null,
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const top = useRef<HTMLDivElement>(null);

  const fill = (value: StudioPrefill) => {
    setPrefill((p) => ({ nonce: (p?.nonce ?? 0) + 1, value }));
    top.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="flex flex-col gap-4">
      <TemplateGallery onPick={fill} />
      <div ref={top} className="scroll-mt-4">
        <GeneratePanel
          key={prefill?.nonce ?? 0}
          orgId={orgId}
          models={models}
          initial={prefill?.value ?? null}
          defaultStyleKitId={defaultStyleKitId}
          onCreated={() => setRefreshKey((k) => k + 1)}
        />
      </div>
      <JobFeed
        orgId={orgId}
        models={models}
        refreshKey={refreshKey}
        onRetry={fill}
      />
    </div>
  );
}
