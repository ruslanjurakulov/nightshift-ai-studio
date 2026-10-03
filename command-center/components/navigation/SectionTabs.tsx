"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { tabsFor } from "@/lib/navigation";

/**
 * The screens behind one rail entry (Studio), as tabs under the
 * panel's bar. Nothing renders for a section that has no group.
 */
export function SectionTabs() {
  const { t } = useI18n();
  const pathname = usePathname();
  const path = useChannelPath();
  const section = pathname.split("/")[2] ?? "";
  const group = tabsFor(section);
  // One entry is a page, not a tab bar (Settings).
  if (!group || group.items.length < 2) return null;
  return (
    <nav aria-label={t.nav.sections} className="mb-6 overflow-x-auto">
      {/* A segmented control: the current screen sits on a raised chip. */}
      <ul className="flex w-max gap-1 rounded-full border border-[var(--shell-border)] bg-[var(--color-panel)] p-1">
        {group.items.map(({ href, key }) => {
          const active = "/" + section === href;
          return (
            <li key={key}>
              <Link
                href={path(href)}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-10 items-center rounded-full px-4 max-sm:min-h-11 pointer-coarse:min-h-11 text-sm font-medium transition-colors ${
                  active
                    ? "bg-[var(--color-active)] text-[var(--color-fg)]"
                    : "text-[var(--color-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
                }`}
              >
                {t.nav[key]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
