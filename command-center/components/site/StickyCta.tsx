"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, X } from "lucide-react";

/**
 * The compact "Start free" bar that follows a visitor once the hero's own
 * button has scrolled away, and steps aside where a button is already in view
 * (the closing call and the footer) or when asked ("Hide this bar", kept for
 * the tab). It is position: fixed, so showing and hiding it moves nothing, and
 * while hidden it is inert, so it is never a tab stop or announced.
 *
 * It is for phones and tablets: from 1024 px the header's Start free is always in view, so the bar is not drawn, and below
 * that the header's button hides while the bar shows. It repeats the page's one action and adds no claim of its own: the words are
 * "your first video starts with one topic" and the same Start free link.
 */
const DISMISSED = "ns-bar-dismissed";

export function StickyCta({ label, text, cta, dismiss, href = "/signup" }: { label: string; text: string; cta: string; dismiss: string; href?: string }) {
  const [heroGone, setHeroGone] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(DISMISSED) === "1") setClosed(true);
    } catch {
      // Storage blocked: the bar simply is not remembered as hidden.
    }
    if (typeof IntersectionObserver === "undefined") return;
    const hero = document.querySelector(".nx-hero .nx-actions");
    const stops = Array.from(document.querySelectorAll(".nx-final-wrap, .st-footer"));
    if (!hero) return;
    const heroIo = new IntersectionObserver(([e]) => setHeroGone(!e.isIntersecting && e.boundingClientRect.top < 0), { threshold: 0 });
    heroIo.observe(hero);
    const inView = new Set<Element>();
    const stopIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) inView.add(e.target);
          else inView.delete(e.target);
        }
        setBlocked(inView.size > 0);
      },
      { threshold: 0.15 },
    );
    stops.forEach((s) => stopIo.observe(s));
    return () => {
      heroIo.disconnect();
      stopIo.disconnect();
    };
  }, []);

  const shown = heroGone && !blocked && !closed;
  // While the bar is up on a phone or a tablet, the header's own Start free steps aside (site-next.css): one button, not two.
  useEffect(() => {
    document.documentElement.setAttribute("data-bar", shown ? "on" : "off");
    return () => document.documentElement.removeAttribute("data-bar");
  }, [shown]);
  const close = () => {
    setClosed(true);
    try {
      window.sessionStorage.setItem(DISMISSED, "1");
    } catch {
      // Not remembered; it stays hidden for this page view.
    }
  };

  return (
    <aside className="nx-bar" data-shown={shown ? "true" : "false"} aria-label={label} inert={shown ? undefined : true}>
      <p className="nx-bar-text">{text}</p>
      <Link href={href} className="nx-bar-go" tabIndex={shown ? 0 : -1}>
        {cta}
        <ArrowRight aria-hidden />
      </Link>
      <button type="button" className="nx-bar-x" onClick={close} aria-label={dismiss} tabIndex={shown ? 0 : -1}>
        <X aria-hidden />
      </button>
    </aside>
  );
}
