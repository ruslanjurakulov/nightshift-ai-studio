import { Captions, FileAudio, FileVideo, Image as ImageIcon, type LucideIcon } from "lucide-react";
import type { MediaKind } from "@/lib/media";

/** One mark per kind, shared by the tiles, the badges and the viewer. */
export const KIND_ICON: Record<MediaKind, LucideIcon> = {
  image: ImageIcon,
  video: FileVideo,
  audio: FileAudio,
  caption: Captions,
};
