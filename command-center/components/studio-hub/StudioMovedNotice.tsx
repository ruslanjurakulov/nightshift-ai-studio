"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { fmt } from "@/lib/i18n";
import { MOVED_PARAM } from "@/lib/studioRoutes";
import type { Dictionary } from "@/lib/i18n";
import "./studio-hub.css";

/**
 * "Styles now lives in Nightshift Studio." — one line, for one release, on every screen that moved
 * under the Studio entry (docs/studio/STUDIO_IA.md §5), and on Studio home after a redirect brought
 * someone there (`?moved=videos`). Dismissing it is a per-browser convenience (localStorage): it is
 * never state anyone relies on, and a browser that blocks storage simply shows it again.
 */

/** The moved screens, by their first path segment, and the name the notice gives each. */
const MOVED: Record<string, (t: Dictionary) => string> = {
  create: (t) => t.nav.create,
  videos: (t) => t.nav.videos,
  styles: (t) => t.nav.styles,
  presets: (t) => t.presets.title,
  library: (t) => t.nav.library,
  editor: (t) => t.nav.editor,
  workflows: (t) => t.nav.workflows,
  pipeline: (t) => t.nav.pipeline,
  look: (t) => t.nav.brandLook,
  // Studio → Projects (/create/projects): the shelf is named Projects in every language.
  projects: (t) => t.studioHub.shelfProjects,
};

const STORE = "ns.studio-moved.v1.";

/** Which moved screen this URL is, if any: `/c/styles` → "styles", `/c/studio/look` → "look", `/c/studio?moved=editor` → "editor". */
export function movedSectionFor(pathname: string, moved: string | null): string | null {
  const [, , first = "", second = ""] = pathname.split("/");
  if (first === "studio") {
    if (second === "look") return "look";
    if (second === "" && moved && moved in MOVED) return moved;
    return null;
  }
  // Only the screen itself, not a video's or a project's own page: those are not where the move is felt.
  return second === "" && first in MOVED ? first : null;
}

function read(key: string): boolean {
  try {
    return window.localStorage.getItem(STORE + key) === "1";
  } catch {
    return false;
  }
}

function write(key: string): void {
  try {
    window.localStorage.setItem(STORE + key, "1");
  } catch {
    /* storage blocked: the notice comes back next time, which is harmless */
  }
}

function Notice() {
  const { t } = useI18n();
  const path = useChannelPath();
  const pathname = usePathname();
  const moved = useSearchParams().get(MOVED_PARAM);
  const section = movedSectionFor(pathname, moved);
  // Hidden until storage has been read on the client, so a dismissed notice never flashes on load.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(section !== null && !read(section));
  }, [section]);
  if (!section || !shown) return null;
  const onStudio = pathname.split("/")[2] === "studio" && !pathname.split("/")[3];
  return (
    <div role="status" data-studio-moved={section} className="studio-moved mb-4">
      <p className="m-0 min-w-0 flex-1 text-sm">{fmt(t.studioHub.moved, { name: MOVED[section](t) })}</p>
      {!onStudio && (
        <Link href={path("/studio")} className="tap-link shrink-0 text-sm text-[var(--color-primary)] hover:underline">
          {t.studioHub.movedOpen}
        </Link>
      )}
      <button
        type="button"
        onClick={() => {
          write(section);
          setShown(false);
        }}
        aria-label={t.studioHub.movedDismiss}
        title={t.studioHub.movedDismiss}
        className="studio-moved-close"
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}

export function StudioMovedNotice() {
  return (
    <Suspense fallback={null}>
      <Notice />
    </Suspense>
  );
}
