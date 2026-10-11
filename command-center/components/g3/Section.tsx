import { useId, type ReactNode } from "react";

/**
 * A ruled section of a production page (docs/design/app-redesign-g3): a rule on
 * the ground, a heading, an optional line under it and actions to the right.
 * `desk` makes it the page's one lit desk (`ns-desk`); a page uses it once.
 * Server-safe: no state, so server and client pages both use it.
 */
export function Section({
  title,
  hint,
  actions,
  desk = false,
  className,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  desk?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`g3-section${desk ? " ns-desk" : ""}${className ? ` ${className}` : ""}`}>
      <header className="g3-head">
        <div className="min-w-0">
          <h2 id={id} className="t-panel">
            {title}
          </h2>
          {hint ? <p className="g3-hint">{hint}</p> : null}
        </div>
        {actions ? <div className="g3-head-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** One plain, true line where a page has nothing to show or cannot read: a ruled note, not a card. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="g3-note">
      {children}
    </p>
  );
}
