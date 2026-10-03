import type { ReactNode } from "react";
import { cleanClientName } from "@/lib/oauth/redirect";

/**
 * An app's self-chosen name, safe to drop into a sentence. It is text the app
 * wrote about itself, so it is shown as untrusted: direction overrides and
 * zero-width characters are removed again at display time (the registration
 * already did it once; this is the second line), and the name sits in its own
 * <bdi> so a right-to-left name cannot reorder the words around it
 * ("Connect <name> to Nightshift" stays in its own order). The bold weight
 * keeps a lookalike name from reading as part of Nightshift's own sentence.
 */
export function AppName({ name }: { name: string }) {
  return <bdi className="font-semibold [overflow-wrap:anywhere]">{cleanClientName(name, "?")}</bdi>;
}

/** A translated sentence with {placeholders} replaced by nodes (names go in as isolated <bdi>). */
export function withParts(template: string, parts: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{\w+\})/g).map((piece, i) => {
    const m = /^\{(\w+)\}$/.exec(piece);
    return m && m[1] in parts ? <span key={i}>{parts[m[1]]}</span> : piece;
  });
}
