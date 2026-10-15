"use client";

import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import type { SettleChange } from "@/lib/editorSettle";

/**
 * What the last edit had to settle elsewhere so the export can still accept the
 * document: a backwards part shortened to the frame size's limit, smoothing or
 * steadying switched off, a blur removed, a zoom lowered. A polite live region, so
 * a screen reader hears it; nothing at all when nothing was changed.
 */
export function SettleNotice({ changes }: { changes: readonly SettleChange[] }) {
  const { t } = useI18n();
  const s = t.editor.fx.settled;
  const sh = t.editor.shapes;
  if (!changes.length) return null;
  const line = (c: SettleChange) => {
    switch (c.kind) {
      case "shapeNarrowed":
        return fmt(sh.settledNarrowed, { n: c.shape });
      case "shapeRemoved":
        return fmt(sh.settledRemoved, { n: c.shape });
      case "reverse":
        return fmt(s.reverse, { n: c.clip, max: Math.floor(c.max * 10) / 10 });
      case "interpolate":
        return fmt(s.interpolate, { n: c.clip });
      case "stabilize":
        return fmt(s.stabilize, { n: c.clip });
      case "blur":
        return fmt(s.blur, { n: c.clip });
      case "zoom":
        return fmt(s.zoom, { n: c.clip, max: c.max });
    }
  };
  return (
    <div role="status" data-testid="settled" className="flex flex-col gap-0.5 text-xs text-[var(--color-warn)]">
      {changes.map((c, i) => (
        <p key={i} className="m-0">
          {line(c)}
        </p>
      ))}
    </div>
  );
}
