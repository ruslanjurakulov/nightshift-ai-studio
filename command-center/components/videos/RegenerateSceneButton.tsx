"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { sceneRepairIntent } from "@/lib/sceneRepair";

/**
 * One scene's "Regenerate scene" button on the Storyboard.
 *
 * It files a request and stops — the same thing the review panel's "Render it
 * again" does: a `review_intents` row (action "regenerate_scene", the scene's
 * Video IR id), inserted with the signed-in user's anon-key session. The
 * database decides who may (editor and above, migration 0007's insert policy);
 * a refusal is shown as the database's own message. Nothing here renders,
 * spends or publishes — the repair is a separate workflow dispatch that
 * consumes the row.
 */
export function RegenerateSceneButton({
  channelId,
  videoId,
  sceneId,
  pending,
  labels,
}: {
  channelId: string;
  videoId: string;
  sceneId: string;
  /** A request for this scene is already waiting. */
  pending: boolean;
  labels: { action: string; filing: string; filed: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [filed, setFiled] = useState(pending);
  const [error, setError] = useState<string | null>(null);

  async function file() {
    const row = sceneRepairIntent(channelId, videoId, sceneId);
    const supabase = createClient();
    if (!row || !supabase) return;
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.from("review_intents").insert(row);
    setBusy(false);
    if (e) {
      setError(e.message);
      return;
    }
    setFiled(true);
    router.refresh();
  }

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {filed ? (
          <span className="pill border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-ok)]">
            {labels.filed}
          </span>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={file}
            className="btn-sky is-quiet pill px-3 py-1 text-[11px] disabled:opacity-40"
          >
            {busy ? labels.filing : labels.action}
          </button>
        )}
        <span className="mono text-[10px] text-[var(--color-muted)]">{sceneId}</span>
      </div>
      {error && <p className="mono text-[11px] text-[var(--color-fail)]">{error}</p>}
    </div>
  );
}
