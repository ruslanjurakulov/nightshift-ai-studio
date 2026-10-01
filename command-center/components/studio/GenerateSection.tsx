"use client";

import { useRef, useState } from "react";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { JobFeed } from "@/components/studio/JobFeed";
import type { StudioModel, StudioPrefill } from "@/lib/creative/studio";

/**
 * The Studio's "make one thing" half: the panel and the feed of what it made.
 * "Try again" on a card refills the panel (a fresh mount with the job's
 * settings) and scrolls to it — it never starts a generation by itself.
 */
export function GenerateSection({ orgId, models }: { orgId: string; models: StudioModel[] }) {
  const [prefill, setPrefill] = useState<{ nonce: number; value: StudioPrefill } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const top = useRef<HTMLDivElement>(null);

  return (
    <div className="flex flex-col gap-4">
      <div ref={top} className="scroll-mt-4">
        <GeneratePanel
          key={prefill?.nonce ?? 0}
          orgId={orgId}
          models={models}
          initial={prefill?.value ?? null}
          onCreated={() => setRefreshKey((k) => k + 1)}
        />
      </div>
      <JobFeed
        orgId={orgId}
        models={models}
        refreshKey={refreshKey}
        onRetry={(value) => {
          setPrefill((p) => ({ nonce: (p?.nonce ?? 0) + 1, value }));
          top.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        }}
      />
    </div>
  );
}
