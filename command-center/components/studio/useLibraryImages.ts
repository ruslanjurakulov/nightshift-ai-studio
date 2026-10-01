"use client";

import { useCallback, useEffect, useState } from "react";
import type { LibraryAsset, MediaLibraryData } from "@/lib/media";

/** What a picker knows about an image: enough to draw a tile. */
export interface PickerImage {
  id: string;
  thumbUrl: string | null;
  name: string | null;
  /** The full picture, when the host can serve it (before / after needs its detail). */
  viewUrl?: string | null;
}

export type LibraryLoadState = "loading" | "ready" | "failed" | "unavailable";

/**
 * The organization's library images, for the Studio's pickers.
 *
 * Reads GET /api/media (the library's own route, under the member's session —
 * RLS shows this organization's live assets and nothing else) and keeps the
 * images only. What is picked is only an id: the database checks it again
 * wherever it is used.
 *
 * `enabled: false` reads nothing (a feed with nothing to compare); a new
 * `key` reads again (a job just finished and its result is new).
 */
export function useLibraryImages(orgId: string, { enabled = true, key = "" }: { enabled?: boolean; key?: string } = {}) {
  const [state, setState] = useState<LibraryLoadState>("loading");
  const [images, setImages] = useState<PickerImage[]>([]);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch(`/api/media?org=${encodeURIComponent(orgId)}`, { cache: "no-store" });
      if (res.status === 503) {
        setState("unavailable");
        return;
      }
      if (!res.ok) {
        setState("failed");
        return;
      }
      const data = (await res.json()) as MediaLibraryData;
      if (data.error) {
        setState("failed");
        return;
      }
      setImages(
        (data.assets ?? [])
          .filter((a: LibraryAsset) => a.kind === "image")
          .map((a: LibraryAsset) => ({ id: a.id, thumbUrl: a.thumbUrl ?? a.viewUrl, name: a.name, viewUrl: a.viewUrl })),
      );
      setState("ready");
    } catch {
      setState("failed");
    }
  }, [orgId]);

  useEffect(() => {
    if (enabled) void load();
  }, [load, enabled, key]);

  return { state, images, reload: load };
}
