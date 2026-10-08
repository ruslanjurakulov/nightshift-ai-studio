"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Clapperboard, Image as ImageIcon, Layers, Maximize2, Mic, Palette, Pencil, Scissors, SlidersHorizontal, type LucideIcon } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  image: ImageIcon,
  video: Clapperboard,
  voice: Mic,
  edit: Pencil,
  animate: Layers,
  upscale: Maximize2,
  cutout: Scissors,
  styles: Palette,
  editor: SlidersHorizontal,
};
/** The tools that cost no credits (the editor and the style library), as everywhere else on the site. */
const FREE = new Set(["editor", "styles"]);

type Tool = { id: string; title: string; body: string };

/**
 * What Nightshift can make, as a strip of the nine tool names you can swipe: a row of pills that scrolls sideways (snapping,
 * fading at its edges), each with a simple icon. Hover one, tap it, or move onto it with the arrow keys and the line under the
 * strip says what it does and whether it costs credits. Names of what the product does, never of a provider or a model.
 *
 * It is a tablist (arrows, Home and End move, only the open pill is a tab stop, the line under it is the tab panel), so a
 * keyboard visitor crosses it in one Tab and a screen reader hears "tab, 3 of 9". It takes the strings it needs, not the
 * dictionary, so nothing else travels in the page's HTML. The first tool is open at the start, so the line is never empty.
 */
export function ToolStrip({ title, tools, priced, free }: { title: string; tools: Tool[]; priced: string; free: string }) {
  const uid = useId();
  const [id, setId] = useState(tools[0].id);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const listRef = useRef<HTMLUListElement>(null);
  // Where the row is scrolled to: "start" (more to the right, the hint shows), "mid", "end", or "none" when it all fits. Drives the edge fades and the hint.
  const [edge, setEdge] = useState<"start" | "mid" | "end" | "none">("start");
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setEdge(el.scrollWidth - el.clientWidth < 4 ? "none" : el.scrollLeft < 4 ? "start" : el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 ? "end" : "mid");
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);
  const tool = tools.find((t) => t.id === id) ?? tools[0];
  const go = (i: number) => {
    const t = tools[(i + tools.length) % tools.length];
    setId(t.id);
    const el = refs.current[t.id];
    el?.focus();
    el?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(tools.length - 1);
    else return;
    e.preventDefault();
  };
  return (
    <div className="nx-tools">
      <div className="nx-tools-rail" data-edge={edge}>
      <ul ref={listRef} className="nx-tools-list" role="tablist" aria-label={title}>
        {tools.map((t, i) => {
          const Icon = ICONS[t.id] ?? ImageIcon;
          return (
            <li key={t.id} role="presentation">
              <button
                ref={(el) => {
                  refs.current[t.id] = el;
                }}
                type="button"
                role="tab"
                id={`${uid}-${t.id}`}
                aria-selected={t.id === id}
                aria-controls={`${uid}-line`}
                tabIndex={t.id === id ? 0 : -1}
                className="nx-tool"
                onClick={() => setId(t.id)}
                onKeyDown={(e) => onKey(e, i)}
                onPointerEnter={(e) => {
                  if (e.pointerType === "mouse") setId(t.id);
                }}
              >
                <Icon aria-hidden />
                {t.title}
              </button>
            </li>
          );
        })}
      </ul>
      </div>
      <p className="nx-tools-line" id={`${uid}-line`} role="tabpanel" aria-labelledby={`${uid}-${tool.id}`} aria-live="polite">
        <span aria-hidden className="nx-tools-dot" data-free={FREE.has(tool.id) ? "true" : undefined} />
        <b>{tool.title}</b>
        <span>{tool.body}</span>
        <small>{FREE.has(tool.id) ? free : priced}</small>
      </p>
    </div>
  );
}
