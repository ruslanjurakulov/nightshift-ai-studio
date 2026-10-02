import { useId, type ReactNode } from "react";

/**
 * A surface, by role (IDENTITY.md §Elevation): `flat` is a hairline rack face
 * (the default — most of the screen), `sunken` is a well (a drop zone, a feed
 * behind its frames), `lifted` is the one thing on a screen that stands off
 * it. Not the same rounded card with the same soft shadow everywhere.
 *
 * With a `title` it is a labelled region: an engraved eyebrow over a title,
 * actions to the right, a hairline under the head. (components/ui.tsx `Panel`
 * is the older open section — a heading and a rule with no surface — and
 * stays for the screens that use it.)
 */
export function Panel({
  tone = "flat",
  as: Tag = "section",
  eyebrow,
  title,
  actions,
  padded = true,
  children,
  className,
}: {
  tone?: "flat" | "sunken" | "lifted";
  as?: "section" | "div" | "article" | "aside";
  eyebrow?: string;
  title?: ReactNode;
  actions?: ReactNode;
  padded?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const head = eyebrow || title || actions;
  return (
    <Tag
      className={`ns-panel${className ? ` ${className}` : ""}`}
      data-tone={tone}
      aria-labelledby={title ? titleId : undefined}
    >
      {head && (
        <header className="ns-panel-head">
          <div className="flex min-w-0 flex-col gap-1">
            {eyebrow && <span className="ns-eyebrow">{eyebrow}</span>}
            {title && (
              <h2 id={titleId} className="ns-panel-title">
                {title}
              </h2>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? "p-4" : undefined}>{children}</div>
    </Tag>
  );
}
