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
    <nav aria-label={t.nav.sections} className="ns-tabs mb-6 overflow-x-auto">
      {/* Underlined tabs, as the public Studio card draws them: the current screen carries the amber line. */}
      <ul className="flex w-max gap-1">
        {group.items.map(({ href, key }) => {
          const active = "/" + section === href;
          return (
            <li key={key}>
              <Link href={path(href)} aria-current={active ? "page" : undefined} className="ns-tabs-link">
                {t.nav[key]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
