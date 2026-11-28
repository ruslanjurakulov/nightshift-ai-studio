/*
 * Adapted from Magic UI's border-beam and animated-gradient-text (MIT, Copyright (c) Magic UI) and motion-primitives'
 * text-shimmer (MIT, Copyright (c) 2024 ibelick), fetched 2026-11-28. Full notices: THIRD_PARTY_NOTICES.
 *
 * Adapted: CSS animations on --ds-* tokens (effects.css) instead of motion/react, colours from our tokens instead of props, and
 * one rule the originals do not have: an effect is drawn only while the state it stands for is true. BorderBeam and
 * TextShimmer take `active`, which the caller ties to a real job or event (SYSTEM.md §5 "motion must be true"); with it false
 * they draw nothing extra. All three are decoration: hidden from assistive technology, and the caller says the state in words.
 */
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";
import "./effects.css";

/** A light running round the edge of the nearest positioned box (give that box `position: relative` and a radius). */
export function BorderBeam({
  active,
  size = 80,
  duration = 6,
  width = 1.5,
  className,
}: {
  /** True only while a real job for this box is running. */
  active: boolean;
  size?: number;
  /** Seconds per lap. */
  duration?: number;
  width?: number;
  className?: string;
}) {
  if (!active) return null;
  return (
    <span
      aria-hidden
      data-fx="beam"
      className={cn("fx-beam", className)}
      style={{ "--fx-beam-size": `${size}px`, "--fx-beam-duration": `${duration}s`, "--fx-beam-width": `${width}px` } as CSSProperties}
    />
  );
}

/**
 * A "working" label with a band of light passing over it. Inactive, it is the plain text. The text itself stays in the
 * accessibility tree (it is the words that say the state); only the light is decoration.
 */
export function TextShimmer({
  active,
  children,
  as: Tag = "span",
  duration = 2,
  className,
}: {
  active: boolean;
  children: string;
  /** A text element: a void one (input, img) cannot hold the words. */
  as?: "span" | "p" | "div" | "strong" | "em" | "h2" | "h3" | "h4";
  duration?: number;
  className?: string;
}) {
  if (!active) return <Tag className={className}>{children}</Tag>;
  return (
    <Tag
      data-fx="shimmer"
      className={cn("fx-shimmer", className)}
      style={{ "--fx-chars": children.length, "--fx-shimmer-duration": `${duration}s` } as CSSProperties}
    >
      {children}
    </Tag>
  );
}

/** A slow wash behind a surface (a finished result, an empty studio). Pure decoration: it says nothing on its own. */
export function AnimatedGradient({
  children,
  duration = 8,
  className,
}: {
  children?: ReactNode;
  duration?: number;
  className?: string;
}) {
  return (
    // With nothing inside it is a pure backdrop: hidden from assistive technology like the other two.
    <div data-fx="gradient" aria-hidden={children == null || children === false ? true : undefined} className={cn("fx-gradient", className)} style={{ "--fx-gradient-duration": `${duration}s` } as CSSProperties}>
      {children}
    </div>
  );
}
