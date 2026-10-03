import { CopyButton, type CopyLabels } from "@/components/docs/CopyButton";

/**
 * A copyable field inside a step: the server address on one line, or a command
 * or config block. Only the key copies; the text stays selectable. A field that
 * scrolls sideways on a phone is a tab stop with a name of its own (axe
 * scrollable-region-focusable, landmark-unique), so `name` must differ from the
 * other fields visible at once.
 */
/**
 * A one-line command is shown wrapped, but only where a person would break it: between words, never inside
 * a flag (`--transport`), and an address only at a slash. A block with structure (JSON, YAML, several
 * lines that depend on their indentation) is not wrapped at all: it scrolls sideways with a fade at the
 * edge that still has more, because a wrapped block loses its indentation and stops being readable.
 */
function isStructured(text: string): boolean {
  // A line that opens a block ({ [ or `key:`), a TOML table, or columns aligned with runs of spaces.
  return /[{[]\s*$/m.test(text) || /^\s*[\w-]+:\s*$/m.test(text) || /^\s*\[[\w.-]+\]\s*$/m.test(text) || /\S {3,}\S/.test(text);
}

function Words({ text }: { text: string }) {
  // Plain words stay plain text (so the page still contains the command as written); only flags and
  // addresses are wrapped, because they are the pieces that must not be broken in the wrong place.
  const parts: React.ReactNode[] = [];
  let plain = "";
  const flush = () => {
    if (plain) parts.push(plain);
    plain = "";
  };
  text.split(/( +|\n)/).forEach((tok, i) => {
    if (/^https?:\/\//.test(tok)) {
      flush();
      parts.push(
        <span key={i}>
          {tok.split(/(?<=\/\/)|(?<=[^/])(?=\/[^/])/).map((seg, si) => (
            <span key={si} className="st-nb">
              {seg}
            </span>
          ))}
        </span>,
      );
    } else if (/^-/.test(tok)) {
      flush();
      parts.push(
        <span key={i} className="st-nb">
          {tok}
        </span>,
      );
    } else plain += tok;
  });
  flush();
  return <>{parts}</>;
}

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
  const structured = kind === "code" && isStructured(text);
  return (
    <div className="st-cfield" data-kind={kind}>
      <Tag
        tabIndex={0}
        role="region"
        aria-label={`${name} · ${scrollLabel}`}
        className="scroll-focus st-cfield-text"
        data-wrap={kind === "code" ? (structured ? "scroll" : "words") : undefined}
      >
        {kind === "code" ? <code>{structured ? text : <Words text={text} />}</code> : text}
      </Tag>
      <CopyButton text={text} name={name} labels={copy} variant="icon" />
    </div>
  );
}
