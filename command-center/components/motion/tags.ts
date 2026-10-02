"use client";

// Named imports, never `import * as m` + `m[tag]`: a dynamic lookup keeps all
// ~170 of Motion's element components in the bundle, these keep only ours.
import {
  article,
  aside,
  div,
  footer,
  h1,
  h2,
  h3,
  header,
  li,
  nav,
  ol,
  p,
  section,
  span,
  ul,
} from "motion/react-m";

/** The `m.*` elements the kit renders as. */
export const M = { article, aside, div, footer, h1, h2, h3, header, li, nav, ol, p, section, span, ul } as const;

export type MTag = keyof typeof M;

/** One props shape for every tag the kit passes through (the kit only sets motion props and attributes). */
export function mTag(as: MTag): typeof div {
  return M[as] as unknown as typeof div;
}
