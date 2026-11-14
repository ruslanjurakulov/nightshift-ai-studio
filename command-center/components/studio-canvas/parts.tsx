"use client";

import { AudioLines, Clapperboard, Film, Image as ImageIcon, Layers, Sparkles, Type, Wand2, type LucideIcon } from "lucide-react";
import type { NodeKind } from "@/lib/studio/canvas";

export const KIND_ICONS: Record<NodeKind, LucideIcon> = {
  prompt: Type,
  image: ImageIcon,
  video: Clapperboard,
  animate: Film,
  effects: Sparkles,
  enhance: Wand2,
  voice: AudioLines,
  asset: Layers,
};

/**
 * A state lamp, the prototype's: a filled lamp for a real state, a ring for idle, a dashed ring for unknown, a breathing
 * violet lamp only while a job is actually working. The words are always beside it: never a colour alone.
 */
export function Lamp({ tone, live = false, label, className }: { tone: "ok" | "run" | "fail" | "warn" | "idle"; live?: boolean; label: string; className?: string }) {
  return (
    <span className={className ? `cv-lampw ${className}` : "cv-lampw"}>
      <span aria-hidden className={`cv-lamp is-${tone}${live ? " is-live" : ""}`} />
      <span className="cv-lamp-label">{label}</span>
    </span>
  );
}
