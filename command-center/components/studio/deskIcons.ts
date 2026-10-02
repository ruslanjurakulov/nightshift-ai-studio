import { AudioLines, Clapperboard, Image as ImageIcon, LayoutGrid, MonitorPlay, ZoomIn, type LucideIcon } from "lucide-react";
import type { Desk } from "@/lib/creative/desks";

/** One glyph per Studio desk: the desk switcher, the overview's bay and the sidebar rows. */
export const DESK_ICONS: Record<Desk, LucideIcon> = {
  overview: LayoutGrid,
  video: Clapperboard,
  image: ImageIcon,
  enhance: ZoomIn,
  voice: AudioLines,
  youtube: MonitorPlay,
};
