"use client";

import { useEffect, useRef, useState } from "react";
import { AudioLines, Clapperboard, Film, Image as ImageIcon, Layers, Sparkles, Type, Wand2, type LucideIcon } from "lucide-react";
import { TextShimmer } from "@/components/ui/effects";
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
      {/* A light passes over the words only while the job is really working (live comes from its status, never a timer). */}
      <TextShimmer active={live} className="cv-lamp-label">
        {label}
      </TextShimmer>
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
      return c.node.readyToMake;
    case "done":
      return c.node.made;
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


/** How long a node keeps its "just finished" look: long enough to see, short enough that a board of results is calm. */
export const JUST_FINISHED_MS = 1800;

/**
 * True for a moment after this node's job is seen to finish: it was working or queued while on screen, then done, AND its
 * result is in view (`ready`: the picture is shown, or the result has no picture to show). Not before: a ring beside
 * "the result is loading" or "the result can't be shown" would celebrate a result the card itself says is not there
 * (rule 5). A board opened on a finished job never celebrates it, and a job first read as done (a fast job, an unknown
 * reading) is not a finish either: only a run the person watched end. Missing a ring is the safe failure; a false one is not.
 */
export function useJustFinished(status: NodeStatus, ready = true): boolean {
  const sawRun = useRef(status === "working" || status === "queued");
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (status === "working" || status === "queued") {
      sawRun.current = true;
      setOn(false);
      return;
    }
    if (status !== "done") {
      sawRun.current = false;
      setOn(false);
      return;
    }
    if (!ready || !sawRun.current) return;
    sawRun.current = false;
    setOn(true);
    const t = window.setTimeout(() => setOn(false), JUST_FINISHED_MS);
    return () => window.clearTimeout(t);
  }, [status, ready]);
  return on;
}

/**
 * The phone list's card has no room for a class hook per row (rows are drawn in a map), so its "just finished" look is this
 * ring drawn inside the card (an inset ring: the card clips), only for the moment useJustFinished allows.
 */
export function FinishRing({ status, ready }: { status: NodeStatus; ready: boolean }) {
  const on = useJustFinished(status, ready);
  return on ? <span aria-hidden className="cv-finish" data-fx="finish" /> : null;
}
