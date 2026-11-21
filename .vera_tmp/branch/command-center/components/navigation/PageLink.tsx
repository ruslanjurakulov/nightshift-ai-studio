"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { isEditorProjectHref } from "@/lib/editor-nav";

type Props = Omit<ComponentProps<typeof Link>, "href"> & { href: string };

/** Next's router-only props: meaningless on a plain anchor, and not attributes it may carry. */
const ROUTER_ONLY = ["prefetch", "replace", "scroll", "shallow", "passHref", "legacyBehavior", "locale", "onNavigate"] as const;

/**
 * A Next `<Link>`, except when it leads to the timeline editor's project page: then a plain `<a>`, so the page opens
 * as a new document with its own Permissions-Policy (the voice-over microphone, lib/editor-nav.ts). For links whose
 * target is only known at run time (a notification). The `onClick` runs either way.
 */
export function PageLink(props: Props) {
  if (!isEditorProjectHref(props.href)) return <Link {...props} />;
  const attrs: Record<string, unknown> = { ...props };
  for (const k of ROUTER_ONLY) delete attrs[k];
  return <a {...(attrs as ComponentProps<"a">)} />;
}
