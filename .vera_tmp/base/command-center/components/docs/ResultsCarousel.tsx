"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type CarouselLabels = { region: string; track: string; prev: string; next: string };

/**
 * A row of cards that scrolls sideways with scroll-snap. The track is a real
 * scroll container a keyboard can reach (tabindex 0, named; the arrow keys,
 * Home and End scroll it, and Tab walks the buttons inside the cards, which
 * scroll themselves into view); two round buttons step one card, and switch off
 * at either end. The group is a labelled "carousel" of "slide" groups. Nothing
 * moves by itself; under prefers-reduced-motion a step jumps instead of gliding.
 */
export function ResultsCarousel({ cards, labels, slideLabel }: { cards: React.ReactNode[]; labels: CarouselLabels; slideLabel: string }) {
  const track = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdge({ start: el.scrollLeft <= 2, end: el.scrollLeft >= max - 2 });
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  function step(dir: 1 | -1) {
    const el = track.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>("[data-slide]");
    const gap = parseFloat(getComputedStyle(el).columnGap || "16") || 16;
    const by = (card ? card.offsetWidth : el.clientWidth * 0.8) + gap;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * by, behavior: reduce ? "auto" : "smooth" });
  }

  // A card reached by Tab that is not fully in view is brought fully into view (snap alone can leave its button half cut off).
  function onFocus(e: React.FocusEvent) {
    const el = track.current;
    const slide = (e.target as HTMLElement).closest<HTMLElement>("[data-slide]");
    if (!el || !slide) return;
    const s = slide.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    if (s.left >= t.left && s.right <= t.right) return;
    const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: el.scrollLeft + (s.left - t.left) - pad, behavior: reduce ? "auto" : "smooth" });
  }

  function onKey(e: React.KeyboardEvent) {
    const el = track.current;
    if (!el || e.target !== el) return;
    if (e.key === "Home") {
      e.preventDefault();
      el.scrollTo({ left: 0 });
    } else if (e.key === "End") {
      e.preventDefault();
      el.scrollTo({ left: el.scrollWidth });
    }
  }

  return (
    <div className="ml-car" role="group" aria-roledescription="carousel" aria-label={labels.region}>
      <div ref={track} className="ml-car-track" role="group" aria-label={labels.track} tabIndex={0} onScroll={measure} onKeyDown={onKey} onFocus={onFocus}>
        {cards.map((card, i) => (
          <div key={i} data-slide role="group" aria-roledescription="slide" aria-label={slideLabel.replace("{n}", String(i + 1)).replace("{total}", String(cards.length))} className="ml-car-slide">
            {card}
          </div>
        ))}
      </div>
      <div className="ml-car-nav">
        <button type="button" className="ml-car-btn" onClick={() => step(-1)} disabled={edge.start} aria-label={labels.prev}>
          <ArrowLeft aria-hidden />
        </button>
        <button type="button" className="ml-car-btn" onClick={() => step(1)} disabled={edge.end} aria-label={labels.next}>
          <ArrowRight aria-hidden />
        </button>
      </div>
    </div>
  );
}
