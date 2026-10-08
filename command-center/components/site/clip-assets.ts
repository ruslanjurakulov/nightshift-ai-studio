/**
 * The clips' files, imported (so each is a hashed file served from this origin) in a module the browser bundle includes:
 * LoopClip, a Client Component, reads them from here. They must not be imported only by Server Components, because the
 * build then writes the files for the server bundle and not into /_next/static/media/ (the page would point at a 404).
 * tests/site-engage-6.test.tsx keeps LoopClip the one reader.
 */
import silkroadMp4 from "@/components/site/clips/silkroad.mp4";
import silkroadWebm from "@/components/site/clips/silkroad.webm";
import libraryMp4 from "@/components/site/clips/library.mp4";
import libraryWebm from "@/components/site/clips/library.webm";
import valleyMp4 from "@/components/site/clips/valley.mp4";
import valleyWebm from "@/components/site/clips/valley.webm";
import silkroadSmMp4 from "@/components/site/clips/silkroad-sm.mp4";
import silkroadSmWebm from "@/components/site/clips/silkroad-sm.webm";
import librarySmMp4 from "@/components/site/clips/library-sm.mp4";
import librarySmWebm from "@/components/site/clips/library-sm.webm";
import valleySmMp4 from "@/components/site/clips/valley-sm.mp4";
import valleySmWebm from "@/components/site/clips/valley-sm.webm";

export const CLIPS = {
  silkroad: { mp4: silkroadMp4, webm: silkroadWebm, smMp4: silkroadSmMp4, smWebm: silkroadSmWebm },
  library: { mp4: libraryMp4, webm: libraryWebm, smMp4: librarySmMp4, smWebm: librarySmWebm },
  valley: { mp4: valleyMp4, webm: valleyWebm, smMp4: valleySmMp4, smWebm: valleySmWebm },
} as const;
export type ClipId = keyof typeof CLIPS;
