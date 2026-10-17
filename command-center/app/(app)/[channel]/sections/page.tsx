import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { ICONS } from "@/components/navigation/navIcons";
import { isOperator } from "@/lib/auth/org-roles";
import { getChannelPath } from "@/lib/channels-path-server";
import { getDictionary } from "@/lib/i18n/server";
import { navGroupsFor } from "@/lib/navigation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * All sections — the page behind the owner's More tab on a phone. The whole console as a visible,
 * grouped list of tappable rows (the same groups and order as the desktop rail), so reaching any screen is
 * a tap on a tab and a tap on a row, never a drawer opened by a hamburger. Operator only: the layout bounces
 * anyone else to Home (lib/navigation isOperatorOnlySection), and this re-checks.
 */
export default async function AllSectionsPage() {
  if (!(await isOperator())) notFound();
  const { t } = await getDictionary();
  const path = await getChannelPath();

  return (
    <div className="rhythm ns-open stagger-enter">
      <PageHeader icon="organization" title={t.nav.allSections} subtitle={t.ownerShell.allSectionsLead} />
      {navGroupsFor(true).map((group, gi) => (
        <section key={group.label ?? `g${gi}`} aria-label={group.label ? t.nav[group.label] : t.nav.allSections} className="flex flex-col gap-2">
          {group.label && <h2 className="px-1 text-xs font-semibold text-[var(--color-muted)]">{t.nav[group.label]}</h2>}
          <ul className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 lg:grid-cols-3">
            {group.items.map(({ href, key }) => {
              const Icon = ICONS[key];
              return (
                <li key={href}>
                  <Link
                    href={path(href)}
                    className="flex min-h-12 items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm text-[var(--color-fg)] transition-colors hover:bg-[var(--color-hover)]"
                  >
                    <Icon aria-hidden className="size-[18px] shrink-0 text-[var(--color-muted)]" strokeWidth={1.75} />
                    <span className="min-w-0 break-words">{t.nav[key]}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
