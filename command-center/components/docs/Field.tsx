import { CopyButton, type CopyLabels } from "@/components/docs/CopyButton";

/**
 * A copyable field inside a step: the server address on one line, or a command
 * or config block. Only the key copies; the text stays selectable. A field that
 * scrolls sideways on a phone is a tab stop with a name of its own (axe
 * scrollable-region-focusable, landmark-unique), so `name` must differ from the
 * other fields visible at once.
 */
export function Field({
  text,
  name,
  kind,
  scrollLabel,
  copy,
}: {
  text: string;
  name: string;
  kind: "url" | "code";
  scrollLabel: string;
  copy: CopyLabels;
}) {
  const Tag = kind === "code" ? "pre" : "div";
  return (
    <div className="st-cfield" data-kind={kind}>
      <Tag tabIndex={0} role="region" aria-label={`${name} · ${scrollLabel}`} className="scroll-focus st-cfield-text">
        {kind === "code" ? <code>{text}</code> : text}
      </Tag>
      <CopyButton text={text} name={name} labels={copy} variant="icon" />
    </div>
  );
}
