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
import coastMp4 from "@/components/site/clips/coast.mp4";
import coastWebm from "@/components/site/clips/coast.webm";
import coastSmMp4 from "@/components/site/clips/coast-sm.mp4";
import coastSmWebm from "@/components/site/clips/coast-sm.webm";
import cloudMp4 from "@/components/site/clips/cloud.mp4";
import cloudWebm from "@/components/site/clips/cloud.webm";
import cloudSmMp4 from "@/components/site/clips/cloud-sm.mp4";
import cloudSmWebm from "@/components/site/clips/cloud-sm.webm";
import potteryMp4 from "@/components/site/clips/pottery.mp4";
import potteryWebm from "@/components/site/clips/pottery.webm";
import potterySmMp4 from "@/components/site/clips/pottery-sm.mp4";
import potterySmWebm from "@/components/site/clips/pottery-sm.webm";
import floatingMp4 from "@/components/site/clips/floating.mp4";
import floatingWebm from "@/components/site/clips/floating.webm";
import floatingSmMp4 from "@/components/site/clips/floating-sm.mp4";
import floatingSmWebm from "@/components/site/clips/floating-sm.webm";
import loomMp4 from "@/components/site/clips/loom.mp4";
import loomWebm from "@/components/site/clips/loom.webm";
import loomSmMp4 from "@/components/site/clips/loom-sm.mp4";
import loomSmWebm from "@/components/site/clips/loom-sm.webm";

export const CLIPS = {
  caravan: { mp4: caravanMp4, webm: caravanWebm, smMp4: caravanSmMp4, smWebm: caravanSmWebm },
  coast: { mp4: coastMp4, webm: coastWebm, smMp4: coastSmMp4, smWebm: coastSmWebm },
  cloud: { mp4: cloudMp4, webm: cloudWebm, smMp4: cloudSmMp4, smWebm: cloudSmWebm },
  pottery: { mp4: potteryMp4, webm: potteryWebm, smMp4: potterySmMp4, smWebm: potterySmWebm },
  floating: { mp4: floatingMp4, webm: floatingWebm, smMp4: floatingSmMp4, smWebm: floatingSmWebm },
  loom: { mp4: loomMp4, webm: loomWebm, smMp4: loomSmMp4, smWebm: loomSmWebm },
} as const;
export type ClipId = keyof typeof CLIPS;
