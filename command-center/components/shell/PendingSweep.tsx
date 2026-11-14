"use client";

import { useEffect } from "react";
import { dropExpired, indexedDbStore } from "@/lib/site/pending-attachment";

/**
 * On every app page: a file kept from the public home page for the Studio (lib/site/pending-attachment.ts) and never picked up is
 * removed once its hour is over. A signed-in person never sees the home page, where the same sweep runs, so without this a file
 * kept and forgotten would outlive its hour. Opens IndexedDB only when the browser's mark says a file is kept. Renders nothing.
 */
export function PendingSweep() {
  useEffect(() => {
    void dropExpired(indexedDbStore());
  }, []);
  return null;
}
