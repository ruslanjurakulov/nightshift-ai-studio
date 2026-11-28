/**
 * The Studio's Plan column as a storyboard (Pixel H3, H6): one card per scene, in reading order, wrapped N to a row by the board's
 * width, with the idea, the script and the cast above the scenes and the assembly and final video below them. LiveView keeps its
 * step graph; this is only how the Plan column lays the same graph out. Pure, so the "12 scenes fit at zoom 1" promise is a test.
 *
 * A scene's two steps (its picture and its clip, `scene#<n>:keyframe` / `scene#<n>:clip`) fold into one scene card, `scene#<n>`: the
 * position-keyed ids stay the steps' own, and the card opens its picture step.
 */
import type { LiveGraph, LiveNode, LiveStatus } from "./liveGraph";

/** S5's card states (components/live LiveNode, docs/design/SYSTEM.md); the placeholder card takes the same words. */
export type CardState = "ghost" | "queued" | "working" | "arrived" | "failed" | "disabled" | "insufficient" | "unknown";

/**
 * A step's status as a card state (S5's contract). A finished step with no file is "unknown", not "queued": done is what a file says,
 * and without one we do not know (CLAUDE.md rule 5).
 */
export function cardState(n: Pick<LiveNode, "status" | "assetId">): CardState {
  const s: LiveStatus = n.status;
  switch (s) {
    case "draft":
      return "ghost";
    case "waiting":
    case "retried":
      return "queued";
    case "working":
      return "working";
    case "done":
      return n.assetId ? "arrived" : "unknown";
    case "failed":
      return "failed";
    case "skipped":
    case "stopped":
    case "none":
      return "disabled";
    default:
      return "unknown";
  }
}

export interface PlanScene {
  /** `scene#<n>`: the card. */
  id: string;
  n: number;
  /** The scene's picture step, what the card opens. */
  keyframe: LiveNode;
  clip: LiveNode | null;
  title: string | null;
  /** The first line of the scene's visual description, or null. */
  summary: string | null;
  seconds: number | null;
  cast: string[];
}

export interface PlanItems {
  /** Idea, script, then the cast (characters, places, props). */
  top: LiveNode[];
  scenes: PlanScene[];
  /** Voice and music when they are in the plan, then the assembly and the final video. */
  footer: LiveNode[];
  /** Steps the plan does not have (voice off, no music): said in one line, not drawn as cards. */
  absent: ("voice" | "music")[];
}

const TOP = new Set(["idea", "script", "topic", "research"]);
const CAST = new Set(["character", "location", "prop"]);
const SCENE_ID = /^scene#(\d+):(keyframe|clip)$/;

export function planItems(g: LiveGraph): PlanItems {
  const top: LiveNode[] = [];
  const cast: LiveNode[] = [];
  const footer: LiveNode[] = [];
  const absent: ("voice" | "music")[] = [];
  const byScene = new Map<number, { keyframe?: LiveNode; clip?: LiveNode }>();
  for (const n of g.nodes) {
    const m = SCENE_ID.exec(n.id);
    if (m) {
      const k = Number(m[1]);
      const e = byScene.get(k) ?? {};
      e[m[2] as "keyframe" | "clip"] = n;
      byScene.set(k, e);
    } else if (TOP.has(n.kind)) top.push(n);
    else if (CAST.has(n.kind)) cast.push(n);
    else if ((n.kind === "voice" || n.kind === "music") && n.status === "none") absent.push(n.kind);
    else footer.push(n);
  }
  const scenes: PlanScene[] = [...byScene.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([k, e]) => {
      const keyframe = e.keyframe ?? e.clip;
      if (!keyframe) return [];
      const text = keyframe.text ?? e.clip?.text ?? null;
      return [
        {
          id: `scene#${k}`,
          n: k,
          keyframe,
          clip: e.keyframe && e.clip ? e.clip : null,
          title: keyframe.sceneTitle ?? null,
          summary: text ? (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim() || null : null,
          seconds: typeof keyframe.seconds === "number" && keyframe.seconds > 0 ? keyframe.seconds : null,
          cast: keyframe.cast ?? [],
        },
      ];
    });
  // The film's order for the footer: what feeds the assembly, the assembly, then the result.
  const rank = (n: LiveNode) => ["voice", "music", "assembly", "final", "visuals", "render", "gate", "upload"].indexOf(n.kind);
  footer.sort((a, b) => rank(a) - rank(b));
  return { top: [...top, ...cast], scenes, footer, absent };
}

// ── the grid ────────────────────────────────────────────────────────────────────────────────

export const GRID = { pad: 12, gap: 10, minW: 200, maxW: 248, topH: 72, sceneH: 116, footH: 72 };

export interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PlanLayout {
  cols: number;
  cardW: number;
  placed: Placed[];
  width: number;
  height: number;
}

/**
 * Where each card goes on a board `width` wide. Rows wrap at `cols` cards; each band's height is the tallest measured card in it
 * (`measured`, React Flow's own sizes once known), so a longer title or a swapped-in card component never overlaps the row below.
 */
export function planLayout(items: PlanItems, width: number, measured: ReadonlyMap<string, number> = new Map(), g = GRID): PlanLayout {
  const room = Math.max(g.minW, width - 2 * g.pad);
  const cols = Math.max(1, Math.floor((room + g.gap) / (g.minW + g.gap)));
  const cardW = Math.min(g.maxW, Math.floor((room - (cols - 1) * g.gap) / cols));
  const placed: Placed[] = [];
  let y = g.pad;
  const band = (ids: string[], fallback: number) => {
    for (let i = 0; i < ids.length; i += cols) {
      const row = ids.slice(i, i + cols);
      const h = Math.max(...row.map((id) => measured.get(id) ?? fallback));
      row.forEach((id, k) => placed.push({ id, x: g.pad + k * (cardW + g.gap), y, w: cardW, h }));
      y += h + g.gap;
    }
  };
  band(items.top.map((n) => n.id), g.topH);
  band(items.scenes.map((s) => s.id), g.sceneH);
  band(items.footer.map((n) => n.id), g.footH);
  const height = y - g.gap + g.pad;
  return { cols, cardW, placed, width: g.pad * 2 + cols * cardW + (cols - 1) * g.gap, height };
}
