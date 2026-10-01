import { AudioLines, Film, Image as ImageIcon, Languages, Mic, Play, Scissors, Wand2, ZoomIn, type LucideIcon } from "lucide-react";
import type { StudioCapability } from "@/lib/creative/studio";

/** One mark per Studio tool, shared by the tabs, the templates and the result cards. */
export const TOOL_ICONS: Record<StudioCapability, LucideIcon> = {
  t2i: ImageIcon,
  t2v: Film,
  tts: Mic,
  edit: Wand2,
  i2v: Play,
  upscale: ZoomIn,
  remove_bg: Scissors,
  voice_change: AudioLines,
  dub: Languages,
};
