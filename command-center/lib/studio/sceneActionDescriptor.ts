import { needsRecording, needsSource, needsVideo, type StudioCapability } from "@/lib/creative/studio";
import { toolClosed, type ToolAvailability } from "@/lib/tool-availability";
import type { PortType } from "@/lib/studio/canvas";

/** Plan presentation context (PLANNER.md §7), not FilmScene.status or proof of permission to run. */
export type SceneActionStatus = "draft" | "approved";
export type SceneActionSource = Readonly<{ type: PortType | null; assetId: string | null }>;
export type SceneActionReason = "tool-unavailable" | "source-missing" | "source-incompatible";

export interface SceneActionDescriptor {
  readonly capability: StudioCapability;
  readonly status: SceneActionStatus;
  readonly presentation: SceneActionStatus | "unavailable";
  readonly availability: "available" | "unavailable" | "unknown";
  readonly source: Readonly<{
    type: PortType | null;
    assetId: string | null;
    requirement: "none" | "image" | "video" | "recording";
  }>;
  readonly reason: SceneActionReason | null;
}

/**
 * Read-only adapter for the existing Inspector's capability/source facts, not another action gate.
 * PLANNER.md §7 distinguishes draft from approved views; STUDIO_IA.md §7 rules 4/6 require unavailable
 * tools and missing inputs to explain themselves. Availability and file presence never constitute a
 * quote, approval, usable-asset check or permission to start. No caller's action state is changed here.
 */
export function sceneActionDescriptor(context: Readonly<{
  capability: StudioCapability;
  status: SceneActionStatus;
  source: SceneActionSource | null;
  availability: ToolAvailability;
}>): SceneActionDescriptor {
  const { capability, status } = context;
  const requirement = needsSource(capability) ? "image" : needsVideo(capability) ? "video" : needsRecording(capability) ? "recording" : "none";
  const source = Object.freeze({
    type: context.source?.type ?? null,
    assetId: context.source?.assetId ?? null,
    requirement,
  });
  const availability = context.availability.state === "unknown" ? "unknown" : toolClosed(context.availability, capability) ? "unavailable" : "available";
  const compatible = requirement === "none" || (requirement === "recording" ? source.type === "audio" || source.type === "video" : source.type === requirement);
  const reason: SceneActionReason | null = availability === "unavailable"
    ? "tool-unavailable"
    : requirement !== "none" && source.type === null
      ? "source-missing"
      : !compatible
        ? "source-incompatible"
        : requirement !== "none" && !source.assetId
          ? "source-missing"
          : null;
  return Object.freeze({ capability, status, presentation: reason ? "unavailable" : status, availability, source, reason });
}
