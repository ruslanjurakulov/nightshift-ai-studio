/**
 * What a node shows, from real state only: its job as the database last answered, the library's files,
 * what is on sale. Nothing here is assumed: a job that could not be read is "unknown", never "done"
 * (CLAUDE.md rule 5), and a tool with nothing on sale says so instead of looking ready (rule 4).
 */
import { KIND_SPEC, missingInput, outputType, wireInto, type CanvasNode, type CanvasState, type NodeKind, type PortType } from "@/lib/studio/canvas";
import { isActiveStatus, isUnsuccessful, type StudioJob } from "@/lib/creative/studio";
import { deskOpen, toolOpen, type ToolAvailability } from "@/lib/tool-availability";
import type { LibraryPreview } from "@/components/studio/useLibraryImages";

/** A node's job as last read: not read yet, read, or unreadable (network, RLS, gone). */
/**
 * A node's job as last read: not read yet, read, or unreadable (network, RLS, gone). `stale`: the last read failed, so this is the
 * reading before it; it is still polled (with backoff), and a failed poll never ends polling or turns "working" into "unknown".
 */
export type JobReading = { state: "loading" } | { state: "ok"; job: StudioJob; stale?: boolean } | { state: "unknown" };

export type NodeStatus =
  | "closed" // nothing on sale for this tool
  | "needs" // a required input is not wired
  | "idle" // ready to be priced, nothing started
  | "loading" // its job is being read
  | "unknown" // its job could not be read
  | "queued"
  | "working"
  | "done"
  | "failed"
  | "asset" // a library file
  | "missing" // a library file the library no longer has
  | "words" // a prompt with words in it
  | "empty"; // a prompt with nothing typed yet

/** Is this kind's tool on sale? Unknown availability draws every tool as before (lib/tool-availability.ts). */
export function kindOpen(av: ToolAvailability, kind: NodeKind): boolean {
  if (kind === "asset" || kind === "prompt") return true;
  if (kind === "image" || kind === "video" || kind === "animate") return toolOpen(av, KIND_SPEC[kind].capability!);
  if (kind === "effects") return deskOpen(av, "effects");
  return deskOpen(av, KIND_SPEC[kind].desk!);
}

export function nodeStatus(
  state: Pick<CanvasState, "wires">,
  node: CanvasNode,
  jobs: ReadonlyMap<string, JobReading>,
  av: ToolAvailability,
  library: { ready: boolean; previews: ReadonlyMap<string, LibraryPreview> },
): NodeStatus {
  if (node.kind === "asset") return library.ready && node.assetId && !library.previews.has(node.assetId) ? "missing" : "asset";
  if (node.kind === "prompt") return node.draft.trim() ? "words" : "empty";
  if (node.jobId) {
    const r = jobs.get(node.jobId);
    if (!r || r.state === "loading") return "loading";
    if (r.state === "unknown") return "unknown";
    if (r.job.status === "queued") return "queued";
    if (isActiveStatus(r.job.status)) return "working";
    if (r.job.status === "completed") return "done";
    if (isUnsuccessful(r.job.status)) return "failed";
    return "unknown";
  }
  if (!kindOpen(av, node.kind)) return "closed";
  if (missingInput(state, node)) return "needs";
  return "idle";
}

/** A finished job's first library file (what the next node's input becomes), or null. */
export function jobAsset(reading: JobReading | undefined): string | null {
  if (!reading || reading.state !== "ok" || reading.job.status !== "completed") return null;
  return reading.job.result_asset_ids[0] ?? null;
}

/** The library file a node puts out right now: its own file, or its finished job's result. */
export function nodeAsset(node: CanvasNode, jobs: ReadonlyMap<string, JobReading>): string | null {
  if (node.kind === "asset") return node.assetId;
  return node.jobId ? jobAsset(jobs.get(node.jobId)) : null;
}

/**
 * What a node's input is fed with: the wired node, and that node's file once there is one. `assetId` null with
 * a `from` means the source is still being made (or failed): the form gets nothing until a real file exists.
 */
export function inputOf(
  state: CanvasState,
  node: CanvasNode,
  jobs: ReadonlyMap<string, JobReading>,
): { from: CanvasNode; type: PortType | null; assetId: string | null; text: string | null } | null {
  const w = wireInto(state, node.id);
  const from = w ? state.nodes.find((n) => n.id === w.from) : undefined;
  if (!from) return null;
  const type = outputType(state, from);
  // A prompt hands over its words; everything else hands over a file once there is one.
  return { from, type, assetId: nodeAsset(from, jobs), text: type === "text" ? from.draft.trim() || null : null };
}

/** The canvas nodes that could feed this node's input now (the phone and the inspector wire from this list). */
export function wireCandidates(state: CanvasState, node: CanvasNode): CanvasNode[] {
  const accepts = KIND_SPEC[node.kind].accepts;
  if (accepts.length === 0) return [];
  return state.nodes.filter((n) => {
    if (n.id === node.id) return false;
    const t = outputType(state, n);
    return t !== null && accepts.includes(t);
  });
}

export const LAMP: Record<NodeStatus, "ok" | "run" | "fail" | "warn" | "idle"> = {
  closed: "idle",
  needs: "warn",
  idle: "idle",
  loading: "idle",
  unknown: "warn",
  queued: "idle",
  working: "run",
  done: "ok",
  failed: "fail",
  asset: "ok",
  missing: "warn",
  words: "ok",
  empty: "idle",
};

/**
 * What a finished node's result picture is, for the card and the phone's flow alike: shown (its file is in view), loading (the
 * library, or a direct read of that file, is still answering), or missing (the read ended and the file is not there, or the
 * library could not be read). "Made" is only ever said beside a picture in view (CLAUDE.md rule 5); a voice result has no picture,
 * so it is null like every unfinished node.
 */
export type ResultView = "shown" | "loading" | "missing";
export function resultView(
  node: CanvasNode,
  status: NodeStatus,
  jobs: ReadonlyMap<string, JobReading>,
  previews: ReadonlyMap<string, Pick<LibraryPreview, "thumbUrl"> & { kind: string }>,
  pending: (assetId: string) => boolean,
): ResultView | null {
  if (status !== "done" || node.kind === "voice") return null;
  const asset = nodeAsset(node, jobs);
  const p = asset ? previews.get(asset) : undefined;
  if (p?.kind === "audio") return null;
  if (p?.thumbUrl) return "shown";
  return asset && !p && pending(asset) ? "loading" : "missing";
}
