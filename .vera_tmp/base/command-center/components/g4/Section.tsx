import type { ReactNode } from "react";

/**
 * An open, ruled section for the insight and operations pages: a heading with
 * its hairline, then the content on the ground. `desk` lights it as the page's
 * one desk (foundation `.ns-desk`); a page uses it once at most.
 */
export function Section({
  title,
  right,
  desk = false,
  id,
  children,
}: {
  title: ReactNode;
  right?: ReactNode;
  desk?: boolean;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`section-open${desk ? " ns-desk" : ""}`}>
      <header className="section-head">
        <h2 className="t-panel">{title}</h2>
        {right}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

/** A row of headline figures between hairlines (StatCard children go inside). */
export function Figures({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  return (
    <div className="g4-figures" data-cols={cols} style={{ ["--g4-cols" as string]: cols }}>
      {children}
    </div>
  );
}
