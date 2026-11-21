import type { Dictionary } from "@/lib/i18n";
import { PublicShell } from "@/components/legal/PublicShell";
import { MotionProvider } from "@/components/motion/MotionProvider";
import "@/components/concepts/concepts.css";

/** What each concept is called in the prototype strip (engineering chrome, English only). */
export const CONCEPT_NAMES = {
  a: "The rack",
  b: "The ledger",
  c: "The screen waiting",
} as const;

/**
 * The frame every concept sits in: the real public header and footer, so a
 * hero is judged in the page it would live in, and a one-line strip that says
 * this is a prototype and which one. `bare` drops the strip for clean
 * screenshots (?bare=1).
 *
 * The motion engine is mounted here, not in a layout: only these pages animate
 * (docs/design/MOTION.md §7), and the public layout carries none.
 */
export function ConceptShell({
  t,
  variant,
  bare,
  children,
}: {
  t: Dictionary;
  variant: keyof typeof CONCEPT_NAMES;
  bare: boolean;
  children: React.ReactNode;
}) {
  return (
    <PublicShell t={t} current="home">
      <MotionProvider>
        {!bare && (
          <p className="ac-strip">
            <span className="st-tag">Atelier concept {variant.toUpperCase()}</span>
            <span>{CONCEPT_NAMES[variant]}</span>
            <span className="ac-strip-note">Prototype, not the live page. Not indexed.</span>
          </p>
        )}
        {children}
      </MotionProvider>
    </PublicShell>
  );
}
