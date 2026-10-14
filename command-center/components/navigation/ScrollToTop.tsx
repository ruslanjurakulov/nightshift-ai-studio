"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

/** Past two screens, the header is far enough away to want a shortcut back. */
const SHOW_AFTER = 2;
/** ...and only once the person has scrolled back UP this far (px): going down, the button would sit on the end of the content. */
const UP_BY = 24;

/**
 * Back to the top of a long page (logs, the audit trail, a video's detail).
 *
 * It shows itself when you scroll back up on a long page and steps away while
 * you read downwards, so it is never parked over the colour hint, a "Cancel" at
 * the right edge or the last line of a page you are still reading.
 *
 * Kept in the DOM while hidden, but out of the tab order and the accessibility
 * tree, so a keyboard user never lands on an invisible button.
 *
 * `dock` is for a phone layout that has the bottom tab bar: the button then
 * sits above the bar (see `.scroll-top[data-dock]`) rather than over a tab.
 */
export function ScrollToTop({ dock = false }: { dock?: boolean }) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let frame = 0;
    let last = window.scrollY;
    let up = 0;
    function update() {
      frame = 0;
      const y = window.scrollY;
      if (y < last) up += last - y;
      else if (y > last) up = 0;
      last = y;
      setVisible(y > window.innerHeight * SHOW_AFTER && up >= UP_BY);
    }
    function onScroll() {
      if (!frame) frame = window.requestAnimationFrame(update);
    }
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  function toTop() {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }

  return (
    <button
      type="button"
      onClick={toTop}
      aria-label={t.navigation.scrollTop}
      title={t.navigation.scrollTop}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      data-hidden={visible ? undefined : "true"}
      data-dock={dock ? "true" : undefined}
      className="scroll-top"
    >
      <ArrowUp aria-hidden className="size-[18px]" />
    </button>
  );
}
