"use client";

import { Pause, Play } from "lucide-react";
import { createContext, useContext, useState } from "react";

/**
 * The moving rows of the "works with" strip must be stoppable (WCAG 2.2.2: anything that moves by itself for more
 * than five seconds needs a pause). The state lives here: the wrapper carries `data-paused`, which site.css reads
 * to pause every row at once; the toggle is a real 44 px button (keyboard and touch), pressed = paused. Hovering the
 * rows also pauses them. With prefers-reduced-motion nothing moves, so the button is hidden there (site.css).
 */
const Ctx = createContext<{ paused: boolean; toggle: () => void } | null>(null);

export function MarqueePause({ children }: { children: React.ReactNode }) {
  const [paused, setPaused] = useState(false);
  return (
    <Ctx.Provider value={{ paused, toggle: () => setPaused((p) => !p) }}>
      <div className="ml-works-wrap" data-paused={paused || undefined}>
        {children}
      </div>
    </Ctx.Provider>
  );
}

export function MarqueeToggle({ label }: { label: string }) {
  const c = useContext(Ctx);
  if (!c) throw new Error("MarqueeToggle needs <MarqueePause>");
  return (
    <button type="button" className="ml-mq-toggle" aria-pressed={c.paused} onClick={c.toggle}>
      {c.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
      <span>{label}</span>
    </button>
  );
}
