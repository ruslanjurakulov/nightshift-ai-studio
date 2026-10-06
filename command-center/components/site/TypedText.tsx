import type { CSSProperties } from "react";

/**
 * A line that types itself, with no script: every letter is its own span that becomes visible at its turn (a CSS animation
 * with a delay of `--i` steps, see ".nx-ch" in site-next.css), so the server's HTML is the whole text, nothing flashes
 * before it starts, nothing shifts (hidden letters keep their room) and, where motion is off (reduced motion, the pause
 * switch), the line is simply there. The full text is also in the page once as screen-reader text, because the letters
 * are hidden from assistive technology while they come in.
 */
export function TypedText({ text }: { text: string }) {
  return (
    <>
      <span className="sr-only">{text}</span>
      <span className="nx-typed" aria-hidden>
        {Array.from(text).map((c, i) => (
          <span key={i} className="nx-ch" style={{ "--i": i } as CSSProperties}>
            {c}
          </span>
        ))}
      </span>
    </>
  );
}
