"use client";

import { useState } from "react";
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
 * What Nightshift can make, as a strip of tool names: hover one (or tap, or focus and press) and the line under the strip
 * says what it does and how it is paid for. Names of what the product does, never of a provider or a model. It takes
 * the strings it needs, not the dictionary, so nothing else travels in the page's HTML. The first tool is open at the
 * start, so the line is never empty; the buttons are real buttons (`aria-pressed`), the line is read out politely.
 */
export function ToolStrip({ title, tools, priced, free }: { title: string; tools: Tool[]; priced: string; free: string }) {
  const [id, setId] = useState(tools[0].id);
  const tool = tools.find((t) => t.id === id) ?? tools[0];
  return (
    <div className="nx-tools" role="group" aria-label={title}>
      <ul className="nx-tools-list">
        {tools.map((t) => {
          const Icon = ICONS[t.id] ?? ImageIcon;
          return (
            <li key={t.id}>
              <button
                type="button"
                className="nx-tool"
                aria-pressed={t.id === id}
                onClick={() => setId(t.id)}
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
      <p className="nx-tools-line" aria-live="polite">
        <span aria-hidden className="nx-tools-dot" data-free={FREE.has(tool.id) ? "true" : undefined} />
        <b>{tool.title}</b>
        <span>{tool.body}</span>
        <small>{FREE.has(tool.id) ? free : priced}</small>
      </p>
    </div>
  );
}
