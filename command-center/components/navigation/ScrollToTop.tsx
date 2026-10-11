"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

/** Past about a screen and a half, the header is far enough away to want a shortcut back. */
const SHOW_AFTER = 1.5;

/**
 * Back to the top of a long page (logs, the audit trail, a video's detail).
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
    function update() {
      frame = 0;
      setVisible(window.scrollY > window.innerHeight * SHOW_AFTER);
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
