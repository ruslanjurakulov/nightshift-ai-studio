"use client";

import { span as MSpan } from "motion/react-m";
import type { HTMLMotionProps } from "motion/react";
import { useFreshMount, useReducedMotionSafe } from "./hooks";
import { revealProps, staggerGroupProps, staggerItemProps, type RevealTrigger } from "@/lib/motion/presets";
import { DISTANCE } from "@/lib/motion/tokens";

import { mTag as tag, type MTag } from "./tags";

/** The block elements the kit renders as; each is the `m.*` form of that tag. */
export type RevealTag = Exclude<MTag, "nav" | "aside">;

type Base = Omit<HTMLMotionProps<"div">, "initial" | "animate" | "exit" | "whileInView" | "variants" | "transition">;

/**
 * A block that arrives once: in view (default) or when it mounts on the client.
 * Server-rendered `mount` blocks are already in place and do not replay on
 * hydration. Reduced motion: rendered in place, no props, nothing moves.
 *
 * Use for a section of a long page, a result that just appeared, a panel the
 * person opened — not for every card on a screen.
 */
export function Reveal({
  as = "div",
  trigger = "inView",
  delay = 0,
  distance = DISTANCE.rise,
  children,
  ...rest
}: Base & { as?: RevealTag; trigger?: RevealTrigger; delay?: number; distance?: number }) {
  const reduced = useReducedMotionSafe();
  const fresh = useFreshMount();
  const Tag = tag(as);
  return (
    <Tag
      data-ns-motion=""
      data-ns-reveal={trigger === "inView" ? "" : undefined}
      {...rest}
      {...revealProps(reduced, { trigger, delay, distance, enter: fresh })}
    >
      {children}
    </Tag>
  );
}

/** A group whose members print in reading order. Members are <StaggerItem index>. */
export function Stagger({
  as = "div",
  trigger = "inView",
  children,
  ...rest
}: Base & { as?: RevealTag; trigger?: RevealTrigger }) {
  const reduced = useReducedMotionSafe();
  const fresh = useFreshMount();
  const Tag = tag(as);
  return (
    <Tag data-ns-motion="" {...rest} {...staggerGroupProps(reduced, { trigger, enter: fresh })}>
      {children}
    </Tag>
  );
}

export function StaggerItem({
  as = "div",
  index,
  distance = DISTANCE.rise,
  children,
  ...rest
}: Base & { as?: RevealTag; index: number; distance?: number }) {
  const reduced = useReducedMotionSafe();
  const Tag = tag(as);
  return (
    <Tag data-ns-motion="" data-ns-reveal="" {...rest} {...staggerItemProps(reduced, index, { distance })}>
      {children}
    </Tag>
  );
}

/**
 * A heading that prints word by word, the way a caption generator types a
 * line onto the monitor. The sentence is one string for assistive technology
 * (an sr-only copy); the animated words are hidden from it. Each word moves by
 * transform inside its own box, so the line it sits on never reflows.
 *
 * Never on a page's LCP heading: hidden-at-start text delays Largest
 * Contentful Paint. Use it for headings further down a page.
 */
export function RevealText({
  as = "h2",
  text,
  trigger = "inView",
  className,
}: {
  as?: Extract<RevealTag, "h1" | "h2" | "h3" | "p" | "span">;
  text: string;
  trigger?: RevealTrigger;
  className?: string;
}) {
  const reduced = useReducedMotionSafe();
  const fresh = useFreshMount();
  const words = text.split(/\s+/).filter(Boolean);
  const Tag = tag(as);
  if (reduced) {
    return (
      <Tag data-ns-motion="" className={className}>
        {text}
      </Tag>
    );
  }
  return (
    <Tag data-ns-motion="" className={className} {...staggerGroupProps(false, { trigger, enter: fresh })}>
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {words.map((word, i) => (
          <MSpan
            key={`${i}-${word}`}
            data-ns-motion=""
            data-ns-reveal=""
            className="inline-block whitespace-pre"
            {...staggerItemProps(false, i, { distance: DISTANCE.rise, step: 0.03 })}
          >
            {i < words.length - 1 ? `${word} ` : word}
          </MSpan>
        ))}
      </span>
    </Tag>
  );
}
