"use client";

import * as m from "motion/react-m";
import { AnimatePresence, useIsPresent, type HTMLMotionProps } from "motion/react";
import { useReducedMotionSafe } from "./hooks";
import { presenceProps, type PresenceKind } from "@/lib/motion/presets";

/**
 * Mount/unmount with an exit: wrap the conditional in <Presence> and make the
 * conditional thing a <PresenceItem>. `popLayout` takes a leaving item out of
 * the flow at once, so its neighbours close the gap immediately instead of
 * jumping when it finally goes (use it for lists such as toasts).
 */
export function Presence({
  children,
  mode = "sync",
}: {
  children: React.ReactNode;
  mode?: "sync" | "popLayout" | "wait";
}) {
  return (
    <AnimatePresence mode={mode} initial={false}>
      {children}
    </AnimatePresence>
  );
}

type ItemTag = "div" | "li" | "section" | "aside";

/**
 * Something that opens and closes: a popover drops 4px from its bar, a sheet
 * or toast comes up from its edge, `fade` only fades. While it leaves it is
 * `inert`: no clicks, no focus, out of the accessibility tree, so a closing
 * dialog never holds focus or catches a click meant for what is under it.
 * Reduced motion: it appears and disappears at once.
 */
export function PresenceItem({
  kind = "fade",
  as = "div",
  children,
  ...rest
}: Omit<HTMLMotionProps<"div">, "initial" | "animate" | "exit" | "transition"> & {
  kind?: PresenceKind;
  as?: ItemTag;
}) {
  const reduced = useReducedMotionSafe();
  const present = useIsPresent();
  const Tag = m[as] as unknown as typeof m.div;
  return (
    <Tag data-ns-motion="" inert={!present || undefined} {...rest} {...presenceProps(reduced, kind)}>
      {children}
    </Tag>
  );
}
