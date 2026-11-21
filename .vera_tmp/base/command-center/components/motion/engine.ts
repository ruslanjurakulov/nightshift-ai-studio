"use client";

import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * Is Motion's animation engine (the feature bundle MotionProvider fetches
 * after hydration) actually here? The kit animates only when it is:
 *
 *   absent  — no <MotionProvider> above this element. Nothing animates.
 *   pending — the bundle is on its way. Server-rendered start states (in-view
 *             reveals, a first-paint entrance) may wait for it; anything that
 *             mounts now is drawn at rest instead of waiting.
 *   ready   — loaded: the kit animates.
 *   failed  — the bundle did not load (offline, a CDN error, deploy skew), even
 *             after one retry, or took longer than ENGINE_TIMEOUT_MS. Nothing
 *             animates for the rest of the page's life, and <html
 *             data-ns-motion-engine="failed"> makes motion.css pin every kit element at
 *             rest, so something already drawn at its start state (opacity 0)
 *             is shown instead of being left invisible.
 *
 * A failed engine must look exactly like reduced motion: complete, still
 * screens. Never a blank page or an invisible dialog holding focus.
 */
export type EngineState = "absent" | "pending" | "ready" | "failed";

export const ENGINE_TIMEOUT_MS = 4000;

let state: Exclude<EngineState, "absent"> = "pending";
const listeners = new Set<() => void>();

function set(next: "ready" | "failed") {
  // Failed is final for this page: an engine that turns up late must not start
  // animating things that were already shown at rest.
  if (state === "failed" || state === next) return;
  state = next;
  if (next === "failed" && typeof document !== "undefined") {
    document.documentElement.setAttribute("data-ns-motion-engine", "failed");
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Wraps the dynamic import of a Motion feature bundle: one retry, a timeout,
 * and on failure an empty bundle (Motion then renders static elements) plus
 * the `failed` state. `tracked: false` for an optional extra bundle (the
 * layout features) whose failure only costs that one effect.
 */
export function loadMotionFeatures<T extends object>(
  importer: () => Promise<T>,
  { tracked = true, timeoutMs = ENGINE_TIMEOUT_MS }: { tracked?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const attempt = () => importer();
  const withRetry = attempt().catch(() => attempt());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("motion engine timed out")), timeoutMs);
  });
  return Promise.race([withRetry, timeout])
    .then((features) => {
      if (tracked) set("ready");
      return features;
    })
    .catch(() => {
      if (tracked) set("failed");
      // An empty bundle: LazyMotion then has no renderer, and every m.* element
      // stays plain markup.
      return {} as T;
    })
    .finally(() => clearTimeout(timer));
}

/** Provided by <MotionProvider>; the default (no provider) is `absent`. */
export const MotionEngineContext = createContext<boolean>(false);

/** The engine state as this element sees it. Hydration-safe: server and hydration read `pending`. */
export function useMotionEngine(): EngineState {
  const provided = useContext(MotionEngineContext);
  const current = useSyncExternalStore(subscribe, () => state, () => "pending" as const);
  if (!provided) {
    warnAbsent();
    return "absent";
  }
  return current;
}

let warned = false;
function warnAbsent() {
  if (warned || process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test") return;
  warned = true;
  console.warn("[motion kit] used outside <MotionProvider>: rendered at rest, no animation.");
}

/** Tests only: put the module back to its first state. */
export function resetMotionEngineForTests(next: "pending" | "ready" | "failed" = "pending") {
  state = next;
  if (typeof document !== "undefined") {
    if (next === "failed") document.documentElement.setAttribute("data-ns-motion-engine", "failed");
    else document.documentElement.removeAttribute("data-ns-motion-engine");
  }
  listeners.forEach((l) => l());
}
