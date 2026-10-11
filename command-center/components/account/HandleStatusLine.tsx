import { Check, Info, Loader2, X } from "lucide-react";
import { fmt } from "@/lib/i18n/core";
import type { Dictionary } from "@/lib/i18n";
import type { HandleStatus } from "@/lib/handles";

type Strings = Pick<
  Dictionary["signup"],
  | "handleHint"
  | "handleChecking"
  | "handleAvailable"
  | "handleTaken"
  | "handleSame"
  | "handleUnknown"
  | "handleRuleShort"
  | "handleRuleLong"
  | "handleRuleChars"
  | "handleRuleDots"
  | "handleRuleLetter"
>;

/** The sentence for a status (also what tests and the field's accessible description read). */
export function handleStatusText(status: HandleStatus, handle: string, s: Strings): string {
  switch (status.kind) {
    case "idle":
      return s.handleHint;
    case "rule":
      return {
        too_short: s.handleRuleShort,
        too_long: s.handleRuleLong,
        characters: s.handleRuleChars,
        dots: s.handleRuleDots,
        no_letter: s.handleRuleLetter,
      }[status.problem];
    case "checking":
      return s.handleChecking;
    case "available":
      return fmt(s.handleAvailable, { handle });
    case "taken":
      return fmt(s.handleTaken, { handle });
    case "same":
      return fmt(s.handleSame, { handle });
    case "unknown":
      return s.handleUnknown;
  }
}

/**
 * Under a username field. Always words, never colour alone: a green check with
 * "is available", a red cross with "is already taken" (the words stay in the text colour), the rule in plain text while
 * the shape is wrong. A polite live region, so a screen reader hears each
 * answer once without being interrupted mid-typing.
 */
export function HandleStatusLine({ id, status, handle, strings }: { id: string; status: HandleStatus; handle: string; strings: Strings }) {
  const tone = status.kind === "available" ? "ok" : status.kind === "taken" ? "fail" : "neutral";
  const Icon = status.kind === "available" ? Check : status.kind === "taken" ? X : status.kind === "checking" ? Loader2 : Info;
  return (
    <p
      id={id}
      aria-live="polite"
      data-status={status.kind}
      data-tone={tone}
      className="flex items-start gap-2 text-sm leading-snug"
      style={{ color: tone === "neutral" ? "var(--ns-text-dim)" : "var(--ns-text)", minHeight: "1.4em" }}
    >
      <Icon
        aria-hidden
        className={status.kind === "checking" ? "mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" : "mt-0.5 size-4 shrink-0"}
        style={tone === "ok" ? { color: "var(--ns-go)" } : tone === "fail" ? { color: "var(--ns-tally)" } : undefined}
      />
      <span>{handleStatusText(status, handle, strings)}</span>
    </p>
  );
}
