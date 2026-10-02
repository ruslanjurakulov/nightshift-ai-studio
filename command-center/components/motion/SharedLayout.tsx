"use client";

import * as m from "motion/react-m";
import { LayoutGroup, LazyMotion } from "motion/react";
import { useReducedMotionSafe } from "./hooks";
import { plateProps } from "@/lib/motion/presets";

// Layout projection (shared `layoutId`) is the heavier feature set; it is
// fetched only when a <SharedLayout> mounts, never in the first-load bundle.
const loadLayout = () => import("@/lib/motion/features-max").then((mod) => mod.default);

/**
 * A scope for shared-layout transitions: one selection plate that travels
 * between rows, a frame that opens into its sheet. `id` namespaces the
 * `layoutId`s inside, so two rails on one screen never trade plates.
 */
export function SharedLayout({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <LazyMotion features={loadLayout} strict>
      <LayoutGroup id={id}>{children}</LayoutGroup>
    </LazyMotion>
  );
}

/**
 * The lit plate under the current row: render it inside the current row only
 * (it is absolutely positioned, behind the row's content, so it never takes
 * space). When the current row changes the plate slides along the rail to it,
 * on a dead-beat spring; reduced motion, it is simply drawn under the new row.
 *
 * The row needs `position: relative` and `isolation: isolate` (`.ns-plate-host`
 * in motion.css), and the rail that scrolls or is pinned (`sticky`/`fixed`)
 * must say so (`layoutScroll` / `layoutRoot` on an `m.*` element) for the
 * plate to measure where it is.
 */
export function Plate({ id, className = "" }: { id: string; className?: string }) {
  const reduced = useReducedMotionSafe();
  return <m.span aria-hidden data-ns-motion="" className={`ns-plate ${className}`} {...plateProps(reduced, id)} />;
}
