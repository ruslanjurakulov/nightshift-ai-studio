"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { tabsFor } from "@/lib/navigation";

/**
 * The screens behind one rail entry (Studio, Settings), as tabs under the
 * panel's bar. Nothing renders for a section that has no group.
 */
export function SectionTabs() {
  const { t } = useI18n();
  const pathname = usePathname();
  const path = useChannelPath();
  const section = pathname.split("/")[2] ?? "";
  const group = tabsFor(section);
  if (!group) return null;
  return (
    <nav aria-label={t.nav.sections} className="-mt-2 mb-5 overflow-x-auto">
      <ul className="flex w-max gap-1 border-b border-[var(--color-border)]">
        {group.items.map(({ href, key }) => {
          const active = "/" + section === href;
          return (
            <li key={key}>
              <Link
                href={path(href)}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-11 items-center px-3 text-[13px] font-medium ${
                  active
                    ? "border-b-2 border-[var(--color-primary)] text-[var(--color-fg)]"
                    : "border-b-2 border-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)]"
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
