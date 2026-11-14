"use client";

import { AudioLines, Clapperboard, Film, Image as ImageIcon, Layers, Sparkles, Type, Wand2, type LucideIcon } from "lucide-react";
import type { NodeKind } from "@/lib/studio/canvas";
import type { useI18n } from "@/lib/i18n/context";
import { failureReason, statusView, type StudioJob } from "@/lib/creative/studio";
import type { NodeStatus } from "./nodeState";

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

/** A node's status in words: always words, never a colour alone; a failure names its reason (rule 6). */
export function statusLine(t: ReturnType<typeof useI18n>["t"], status: NodeStatus, job: StudioJob | null, accepts: string): string {
  const c = t.studioCanvas;
  switch (status) {
    case "closed":
      return c.node.notAvailable;
    case "needs":
      return c.node.needsInput.replace("{kinds}", accepts);
    case "idle":
      return c.node.notStarted;
    case "loading":
      return c.node.reading;
    case "unknown":
      return c.node.unknown;
    case "asset":
      return c.kinds.asset.name;
    case "missing":
      return c.node.noFile;
    case "words":
      return c.node.words;
    case "empty":
      return c.node.noWords;
    case "failed":
      return job ? `${t.gen.status.failed} · ${failureReason(t, job)}` : t.gen.status.failed;
    default:
      return job ? statusView(t, job.status).label : c.node.unknown;
  }
}

