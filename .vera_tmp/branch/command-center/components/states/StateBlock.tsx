import type { ReactNode } from "react";
import "@/app/(app)/app-pages-g5.css";

/**
 * What the screen can truthfully say, and the one thing to do next: a lamp, a short title, a plain line, and at most one
 * key. Used for the states every page shares (could not read, nothing yet, not set up). Left-aligned and open, so it sits
 * inside a ruled section instead of floating in a box; `centered` is for a block that owns a whole area.
 */
export type StateTone = "fail" | "warn" | "idle" | "ok";

export function StateBlock({
  tone = "idle",
  title,
  children,
  actions,
  compact = false,
  centered = false,
  role,
  className,
  ...rest
}: {
  tone?: StateTone;
  /** A short line. Leave it out when the sentence itself is the whole state: it is then set as the body beside the lamp. */
  title?: ReactNode;
  children?: ReactNode;
  /** The next step. One filled key at most; a link or a quiet key is the norm. */
  actions?: ReactNode;
  compact?: boolean;
  centered?: boolean;
  role?: "alert" | "status";
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "title">) {
  return (
    <div
      role={role}
      className={`g5-state${className ? ` ${className}` : ""}`}
      data-compact={compact ? "true" : undefined}
      data-centered={centered ? "true" : undefined}
      {...rest}
    >
      <div className="g5-state-head" data-bare={title ? undefined : "true"}>
        <span aria-hidden className="ns-lamp" data-tone={tone} data-size="md" />
        {title ? <p className="g5-state-title">{title}</p> : <p className="g5-state-body">{children}</p>}
      </div>
      {title && children ? <p className="g5-state-body">{children}</p> : null}
      {actions ? <div className="g5-state-actions">{actions}</div> : null}
    </div>
  );
}
