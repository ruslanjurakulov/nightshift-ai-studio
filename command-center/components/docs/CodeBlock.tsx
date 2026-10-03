import { CopyButton, type CopyLabels } from "@/components/docs/CopyButton";

/**
 * A snippet with its name and a copy button, ruled like the rest of the
 * developer pages. The text box scrolls sideways on a phone instead of
 * widening the page, so it must be reachable by keyboard, and a focusable box
 * needs a name of its own (axe landmark-unique): each is called by what it holds.
 */
export function CodeBlock({
  code,
  name,
  scrollLabel,
  copy,
  tone,
}: {
  code: string;
  name: string;
  /** What a screen reader calls a box that scrolls sideways (common.scrollCode). */
  scrollLabel: string;
  copy: CopyLabels;
  tone?: "plain";
}) {
  return (
    <figure className="st-codeblock" data-tone={tone}>
      <figcaption className="st-codeblock-bar">
        <span className="st-codeblock-name">{name}</span>
        <CopyButton text={code} name={name} labels={copy} />
      </figcaption>
      <pre tabIndex={0} role="region" aria-label={`${name} · ${scrollLabel}`} className="scroll-focus st-code">
        <code>{code}</code>
      </pre>
    </figure>
  );
}
