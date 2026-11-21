import Link from "next/link";
import type { OwnerConsoleDictionary } from "@/lib/i18n/owner-console/en";
import type { OwnerSection } from "@/lib/owner-console/nav";

/**
 * One Owner Console page: the title, an optional subtitle and toolbar, and the body. Server-safe, so a page can read its
 * data on the server and render inside it. S8 fills the sections' bodies; until then a section shows OwnerTools.
 */
export function OwnerPage({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="oc-page">
      <div className="oc-head">
        <div className="min-w-0">
          <h1 className="oc-h1">{title}</h1>
          {subtitle && <p className="oc-sub">{subtitle}</p>}
        </div>
        {actions && <div className="oc-actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * A section that is not built yet says so, and lists the existing owner tools that already hold its data, so the owner is
 * never left at a dead end. No figure is drawn here: an unbuilt page never shows a number.
 */
export function OwnerTools({ section, c, note }: { section: OwnerSection; c: OwnerConsoleDictionary; note?: string }) {
  return (
    <section className="oc-card" aria-labelledby={`oc-tools-${section.key}`}>
      <p className="oc-note">{note ?? c.notBuilt}</p>
      {section.tools.length > 0 && (
        <>
          <h2 className="oc-h2" id={`oc-tools-${section.key}`}>
            {c.toolsTitle}
          </h2>
          <ul role="list" className="oc-tools">
            {section.tools.map((tool) => (
              <li key={tool.key}>
                <Link href={tool.href} className="oc-tool">
                  {c.tools[tool.key]}
                  <span aria-hidden>→</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
