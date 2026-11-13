import { AudioLines, Clapperboard, Image as ImageIcon, LayoutGrid, MonitorPlay, Sparkles, ZoomIn, type LucideIcon } from "lucide-react";
import type { Desk } from "@/lib/creative/desks";

/** One glyph per Studio section: the switcher, /create's mode chips and Advanced links, and the sidebar rows. */
export const DESK_ICONS: Record<Desk, LucideIcon> = {
  overview: LayoutGrid,
  video: Clapperboard,
  effects: Sparkles,
  image: ImageIcon,
  enhance: ZoomIn,
  voice: AudioLines,
  youtube: MonitorPlay,
};
