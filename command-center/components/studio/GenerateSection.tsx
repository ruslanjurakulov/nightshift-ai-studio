"use client";

import { useRef, useState, type CSSProperties } from "react";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { JobFeed } from "@/components/studio/JobFeed";
import { TemplateGallery } from "@/components/studio/TemplateGallery";
import type { StudioModel, StudioPrefill } from "@/lib/creative/studio";

/**
 * The Studio's "make one thing" half: the composer on the left (sticky from
 * `lg` up), the canvas of what it made on the right — templates as a strip
 * above the results. On a phone the composer comes first, its Generate pinned
 * above the bottom tab bar, and the results follow as a two-column grid.
 *
 * "Try again" and a template refill the composer (a fresh mount with those
 * settings); "Use as picture" hands a finished picture to it without clearing
 * the words. None of them starts a generation: only Generate does.
 */
export function GenerateSection({
  orgId,
  models,
  initial = null,
  defaultStyleKitId = null,
  bottomBar = true,
}: {
  orgId: string;
  models: StudioModel[];
  /** From the Library's "Use in Studio" link; fills the form only. */
  initial?: StudioPrefill | null;
  /** The open channel's default style kit (0047), if it has one. */
  defaultStyleKitId?: string | null;
  /** The phone's bottom tab bar is shown (not for the platform operator): Generate docks above it. */
  bottomBar?: boolean;
}) {
  const [prefill, setPrefill] = useState<{ nonce: number; value: StudioPrefill } | null>(
    initial ? { nonce: 0, value: initial } : null,
  );
  const [sourceRequest, setSourceRequest] = useState<{ nonce: number; id: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
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

  const dock = { "--studio-dock-offset": bottomBar ? "60px" : "0px" } as CSSProperties;

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(340px,384px)_minmax(0,1fr)]" style={dock}>
      <div
        ref={top}
        className="scroll-mt-24 lg:sticky lg:top-[96px] lg:max-h-[calc(100dvh-112px)] lg:overflow-y-auto lg:rounded-[20px]"
        data-testid="gen-composer"
      >
        <GeneratePanel
          key={prefill?.nonce ?? 0}
          orgId={orgId}
          models={models}
          initial={prefill?.value ?? null}
          defaultStyleKitId={defaultStyleKitId}
          sourceRequest={sourceRequest}
          onCreated={() => setRefreshKey((k) => k + 1)}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-6" data-testid="gen-canvas">
        <TemplateGallery onPick={fill} />
        <JobFeed orgId={orgId} models={models} refreshKey={refreshKey} onRetry={fill} onUseAsSource={pickAsSource} />
      </div>
    </div>
  );
}
