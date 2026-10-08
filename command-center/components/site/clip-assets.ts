/**
 * The clips' files, imported (so each is a hashed file served from this origin) in a module the browser bundle includes:
 * LoopClip, a Client Component, reads them from here. They must not be imported only by Server Components, because the
 * build then writes the files for the server bundle and not into /_next/static/media/ (the page would point at a 404).
 * tests/site-engage-6.test.tsx keeps LoopClip the one reader.
 */
import caravanMp4 from "@/components/site/clips/caravan.mp4";
import caravanWebm from "@/components/site/clips/caravan.webm";
import caravanSmMp4 from "@/components/site/clips/caravan-sm.mp4";
import caravanSmWebm from "@/components/site/clips/caravan-sm.webm";
import mistMp4 from "@/components/site/clips/mist.mp4";
import mistWebm from "@/components/site/clips/mist.webm";
import mistSmMp4 from "@/components/site/clips/mist-sm.mp4";
import mistSmWebm from "@/components/site/clips/mist-sm.webm";
import coastMp4 from "@/components/site/clips/coast.mp4";
import coastWebm from "@/components/site/clips/coast.webm";
import coastSmMp4 from "@/components/site/clips/coast-sm.mp4";
import coastSmWebm from "@/components/site/clips/coast-sm.webm";

export const CLIPS = {
  caravan: { mp4: caravanMp4, webm: caravanWebm, smMp4: caravanSmMp4, smWebm: caravanSmWebm },
  mist: { mp4: mistMp4, webm: mistWebm, smMp4: mistSmMp4, smWebm: mistSmWebm },
  coast: { mp4: coastMp4, webm: coastWebm, smMp4: coastSmMp4, smWebm: coastSmWebm },
} as const;
export type ClipId = keyof typeof CLIPS;
