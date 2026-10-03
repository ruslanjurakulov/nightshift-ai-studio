import Link from "next/link";
import type { DevDictionary } from "@/lib/i18n/dev";

/** What a screen reader calls a box that scrolls sideways. A scroll container
 *  must be reachable by keyboard, and a focusable box needs a name — a name of
 *  its own (axe landmark-unique), so each box is called by what it holds. */
export type ScrollLabels = { table: string; code: string };

/** A table that scrolls inside its own box on a phone instead of widening the page. */
export function Table({
  children,
  name,
  labels,
  stack = false,
}: {
  children: React.ReactNode;
  name: string;
  labels: ScrollLabels;
  /** On a phone, each row becomes its key cells on one line over its description
   *  (a three-column table left the description a ~100px column). "rows": every
   *  cell on its own line, for a long name over a sentence over a note. */
  stack?: boolean | "rows";
}) {
  return (
    <div tabIndex={0} role="region" aria-label={`${name} · ${labels.table}`} className="scroll-focus st-doc-table-wrap">
      <table className="st-doc-table" data-stack={stack === "rows" ? "rows" : stack || undefined}>
        <caption className="sr-only">{name}</caption>
        {children}
      </table>
    </div>
  );
}

/** One numbered section of a developer page, ruled like a rundown sheet: number
 *  and title on the left, the text on the right. */
export function DocSection({
  id,
  no,
  title,
  children,
}: {
  id: string;
  no: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="st-doc-sec">
      <div className="st-wrap st-doc-grid">
        <header className="st-doc-head">
          <span className="st-num st-doc-no" aria-hidden>
            {String(no).padStart(2, "0")}
          </span>
          <h2 id={`${id}-title`} className="st-doc-h2">
            {title}
          </h2>
        </header>
        <div className="st-doc-body">{children}</div>
      </div>
    </section>
  );
}

export const H3 = ({ children }: { children: React.ReactNode }) => <h3 className="st-doc-h3">{children}</h3>;

export type DevPageId = "api" | "mcp" | "cli" | "skills";

/**
 * The developers' sub-navigation, above every developer page's title: where
 * you are and the other doors in. CLI and Skills appear only while their flag
 * is on (lib/dev-pages.ts) — off, they are not linked anywhere.
 */
export function DevNav({ nav, current, showCli }: { nav: DevDictionary["nav"]; current: DevPageId; showCli: boolean }) {
  const items: { id: DevPageId; href: string; label: string }[] = [
    { id: "api", href: "/docs/api", label: nav.api },
    { id: "mcp", href: "/mcp", label: nav.mcp },
    ...(showCli
      ? [
          { id: "cli" as const, href: "/docs/cli", label: nav.cli },
          { id: "skills" as const, href: "/docs/skills", label: nav.skills },
        ]
      : []),
  ];
  // Named by the page too: the footer's "Developers" column is a landmark of the same name (axe landmark-unique).
  return (
    <nav aria-label={`${nav.label} · ${items.find((i) => i.id === current)?.label ?? ""}`} className="st-devnav">
      <span className="st-devnav-label" aria-hidden>
        {nav.label}
      </span>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <Link href={i.href} aria-current={i.id === current ? "page" : undefined}>
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A short sentence set large above a section's text: what the section is about. */
export const Statement = ({ children }: { children: React.ReactNode }) => <p className="st-doc-statement">{children}</p>;
