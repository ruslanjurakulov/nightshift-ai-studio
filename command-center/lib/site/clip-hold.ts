import { useSyncExternalStore } from "react";

/**
 * A hold on the page's own loops (components/site/LoopClip.tsx), separate from the visitor's pause switch (lib/site/motion.ts):
 * while the phone's Shorts feed is open over the page, the gallery's clips under it stop, so only the feed's clip decodes. It is
 * not remembered and it does not touch <html data-motion>, so it never reads as the visitor having paused anything.
 */
let holds = 0;
const listeners = new Set<() => void>();

/** Holds every LoopClip still until the returned release is called (each hold is released once). */
export function holdClips(): () => void {
  holds += 1;
  listeners.forEach((l) => l());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    listeners.forEach((l) => l());
  };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useClipsHeld(): boolean {
  return useSyncExternalStore(subscribe, () => holds > 0, () => false);
}
