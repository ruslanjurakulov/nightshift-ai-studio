/**
 * The tiny inline markup the legal texts use — links, operator placeholders and
 * code — tokenised here so rendering stays a plain map in the component and no
 * HTML string is ever injected into the page.
 */

export const LEGAL_VARS = ["legalName", "contactEmail", "country", "effectiveDate"] as const;
export type LegalVar = (typeof LEGAL_VARS)[number];

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "link"; label: string; href: string }
  | { kind: "var"; name: LegalVar }
  | { kind: "code"; text: string };

const PATTERN = /\[([^\]]+)\]\(((?:https:\/\/|\/)[^)\s]*)\)|\{(\w+)\}|`([^`]+)`/g;

function isVar(name: string): name is LegalVar {
  return (LEGAL_VARS as readonly string[]).includes(name);
}

export function tokenizeInline(source: string): InlineToken[] {
  const out: InlineToken[] = [];
  let last = 0;
  for (const m of source.matchAll(PATTERN)) {
    const at = m.index ?? 0;
    // An unknown {word} is left as text rather than dropped, so a typo in a
    // translation shows up on the page instead of silently deleting words.
    if (m[3] !== undefined && !isVar(m[3])) continue;
    if (at > last) out.push({ kind: "text", text: source.slice(last, at) });
    if (m[1] !== undefined) out.push({ kind: "link", label: m[1], href: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "var", name: m[3] as LegalVar });
    else out.push({ kind: "code", text: m[4] });
    last = at + m[0].length;
  }
  if (last < source.length) out.push({ kind: "text", text: source.slice(last) });
  return out;
}
