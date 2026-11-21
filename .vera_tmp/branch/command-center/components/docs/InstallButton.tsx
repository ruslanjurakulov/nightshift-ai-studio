import { ArrowUpRight, Plus } from "lucide-react";
import type { InstallLink } from "@/lib/dev/mcp-clients";

/**
 * One "Add to <assistant>" button: a plain link, never a script, so it works
 * with JavaScript off and nothing but the browser decides what happens. An
 * https page (Claude's dialog, vscode.dev/redirect) opens in a new tab; a
 * custom scheme (cursor:) is followed in the same tab, because a new
 * tab for a link the browser hands to an app stays blank behind it. The icon is
 * a generic one: the button names the product in text and carries no vendor
 * mark.
 *
 * It only opens the assistant's own install prompt; the person confirms there,
 * and nothing is added or spent from here.
 */
export function InstallButton({
  link,
  label,
  newTab,
  className,
  size,
  tone,
}: {
  link: InstallLink;
  label: string;
  /** "(opens in a new tab)", for screen readers on the https links. */
  newTab: string;
  className: string;
  size?: "sm";
  tone?: "quiet";
}) {
  const web = link.opens === "web";
  return (
    <a
      href={link.href}
      className={className}
      data-size={size}
      data-tone={tone}
      data-opens={link.opens}
      {...(web ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      <Plus aria-hidden />
      {label}
      {web && (
        <>
          <ArrowUpRight aria-hidden />
          <span className="sr-only">{newTab}</span>
        </>
      )}
    </a>
  );
}
