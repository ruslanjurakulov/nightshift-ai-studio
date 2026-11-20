/**
 * The class list of a design-system key (app/tokens.css .ds-btn). A plain module, not "use client": a Server Component (a
 * public page, a layout) styles its own <Link> or <a> with it, which it could not do through components/ds/Button.tsx — a
 * function exported from a client module is a client reference on the server and throws when called there.
 */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export function buttonClass({
  variant = "secondary",
  size = "md",
  icon = false,
  block = false,
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; icon?: boolean; block?: boolean; className?: string } = {}): string {
  const parts = ["ds-btn", `ds-btn--${variant}`];
  if (size !== "md") parts.push(`ds-btn--${size}`);
  if (icon) parts.push("ds-btn--icon");
  if (block) parts.push("ds-btn--block");
  if (className) parts.push(className);
  return parts.join(" ");
}
