/**
 * The words inside an "AI" badge: the short mark for the eye, the full meaning for a screen reader. The owner wants every
 * "made with AI" label on a picture to read just "AI" (2026-11-22); a bare "AI" spoken aloud says less than the label used to, and
 * the disclosure is the one thing a sample's label may never lose, so the long form stays in the page, visually hidden.
 *
 * Only the words: each place keeps its own badge element and class (and so its position and its measured contrast). No hooks and
 * no "use client", so a Server and a Client Component can both draw it.
 */
export function AiMark({ short, name }: { short: string; name: string }) {
  return (
    <>
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{name}</span>
    </>
  );
}
