"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { breadcrumbs, type Crumb } from "@/lib/navigation";
import type { Dictionary } from "@/lib/i18n";
import { useNavigation } from "./NavigationProvider";

function crumbLabel(crumb: Crumb, t: Dictionary, channelName: (slug: string) => string | null): string {
  switch (crumb.kind) {
    case "channel":
      return crumb.slug === ALL_CHANNELS_SLUG ? t.channels.allChannels : channelName(crumb.slug) ?? crumb.slug;
    case "section":
      return t.nav[crumb.key];
    case "detail":
      if (crumb.parent === "channels" && crumb.segment === "new") return t.channels.add;
      // A section the sidebar does not list names itself by its URL; anything
      // below a section (a video's id) is a detail page, and an id is not a name.
      return crumb.parent === null ? crumb.segment.replace(/-/g, " ") : t.navigation.details;
  }
}

/**
 * The top-left of an opened panel: a back arrow and where you are.
 *
 * The arrow goes where the browser's back would when the page behind is one of
 * ours, and to the section's parent otherwise — a pasted link or a fresh tab
 * must not be sent out of the app by an arrow drawn inside it.
 */
export function PageNav() {
  const pathname = usePathname();
  const { t } = useI18n();
  const { goBack, channelName, showChannel } = useNavigation();
  const crumbs = breadcrumbs(pathname).filter((c) => c.kind !== "channel" || showChannel);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={goBack}
        aria-label={t.navigation.back}
        title={t.navigation.back}
        className="nav-back shrink-0"
      >
        <ArrowLeft aria-hidden className="size-4" />
      </button>
      <nav aria-label={t.navigation.breadcrumb} className="min-w-0">
        <ol className="flex min-w-0 items-center gap-1 text-[12px] text-[var(--color-muted)]">
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1;
            const label = crumbLabel(crumb, t, channelName);
            // Middle crumbs give way first on a narrow screen; the page you are
            // on is the one worth keeping legible.
            const hideOnPhone = !last && i < crumbs.length - 2;
            return (
              <li
                key={`${crumb.kind}:${i}`}
                className={`${hideOnPhone ? "hidden sm:flex" : "flex"} min-w-0 items-center gap-1 ${last ? "" : "shrink-0"}`}
              >
                {i > 0 && <ChevronRight aria-hidden className="size-3 shrink-0 opacity-60" />}
                {last ? (
                  <span aria-current="page" className="truncate text-[var(--color-fg)]">
                    {label}
                  </span>
                ) : crumb.kind === "channel" ? (
                  <span className="max-w-[10rem] truncate">{label}</span>
                ) : (
                  <Link
                    href={crumb.href}
                    className="max-w-[12rem] truncate rounded transition-colors hover:text-[var(--color-fg)]"
                  >
                    {label}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}
