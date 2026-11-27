"use client";

import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useMotionPaused, useMotionTap } from "@/lib/site/motion";
import { useClipsHeld } from "@/lib/site/clip-hold";
import { CLIPS, type ClipId } from "@/components/site/clip-assets";
import { clipRendition } from "@/lib/site/renditions";
import { useClipNear, useClipTurn, usePageVisible } from "@/components/site/clip-turns";
import { registerSound, setSoundLive, setSoundOn } from "@/lib/site/sound";
import { SoundToggle } from "@/components/site/SoundToggle";

type NetworkInformation = { saveData?: boolean; effectiveType?: string };

/**
 * The renditions of one loop: 1280 and 640 wide, each in WebM and MP4; and a larger one only where the source was larger (never an
 * upscale). WebM is optional: a Studio piece on the landing (components/site/StudioClip.tsx) is one MP4, and a `<source>` naming a
 * file that is not there would cost a failed request before the browser tried the MP4.
 */
export type ClipSources = { mp4: string; webm?: string; smMp4: string; smWebm?: string; lg?: { mp4: string; webm: string; audio?: true } };

/**
 * Only a browser's autoplay refusal of an audible play() means "this clip may not make sound now". Anything else (an AbortError
 * from a load() or pause() that interrupted it, a decode error) says nothing about sound, and must not switch it off.
 */
function refusedSound(e: unknown, v: HTMLVideoElement): boolean {
  return (e as DOMException | undefined)?.name === "NotAllowedError" && !v.muted;
}

/** Whether a clip may be fetched and played at all: never under reduced motion, never on Save-Data or a slow link. */
export function clipsAllowed(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const c = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (c?.saveData) return false;
  if (c?.effectiveType && /^(slow-2g|2g|3g)$/.test(c.effectiveType)) return false;
  return true;
}

/**
 * A silent loop of stock footage over its own first frame (components/site/samples.tsx CLIPS; the footage is a Pexels
 * contributor's, credited on the picture). The still under it is the clip's frame 0 and is the poster, and stays in the
 * page exactly as it was, so with this component absent, not yet loaded, blocked or switched off the picture is the
 * still and nothing else changes.
 *
 * It follows these rules, each one tested:
 * - never rendered, so never fetched, under prefers-reduced-motion or on Save-Data or a slow connection;
 * - nothing is downloaded until it is wanted: the first screen's clip after the page has loaded and gone idle (so the still,
 *   not the clip, is what the page's LCP measures), every other clip when it comes within half a screen of the viewport
 *   (`preload="none"` until then, `auto` from then, so it is already buffered when it is seen);
 * - every clip that shows at least 35% of itself plays, as many at once as the screen shows (components/site/clip-turns.ts,
 *   which holds the measurement and the safety cap); one that is waiting for its turn or has stalled shows its poster, never a
 *   stopped frame, and one that played and had to stop resumes where it was the moment it may play again;
 * - one rendition, chosen when it mounts: 640 x 360 below 860 px of screen or for a frame that is never wider than about 560 px
 *   (`compact`: a small frame on a wide screen does not need the 1280 file and its first-load cost), 1280 x 720 otherwise (a `media` attribute on a video's
 *   `source` is not honoured by browsers, so the choice is made here);
 * - muted, looping, inline, no controls, hidden from assistive technology (the still's description covers it); `poster` is the
 *   still itself at its phone width (the file a phone's picture already shows, so it is usually already in the cache), and the WebM is listed first, the MP4 after it
 *   (a browser takes the first it can play; Safari on a phone takes the MP4);
 * - paused while off screen, while the page's pause switch is pressed (lib/site/motion.ts) or the Shorts feed is open over the
 *   page (lib/site/clip-hold.ts), and in a hidden tab; a tap on the picture presses that switch, and a second one releases it
 *   (lib/site/motion.ts motionTap);
 * - the container's `data-live` says it is playing, which swaps the badge from "Example frame (stock footage)" to "Example clip
 *   (stock footage)" and fades the clip in over the still. It is taken away again whenever the clip stops for any reason but one
 *   of the page's holds (off screen, no turn, buffering), so the still, not a frozen frame, is what shows; under a hold the frame
 *   the visitor stopped on stays;
 * - sound (owner decision 2026-11-22): it still starts muted (a browser autoplays nothing else), and only a clip whose files carry
 *   an audio track (`audio`, measured by tools/export_showcase.py, never assumed) gets a speaker toggle (components/site/
 *   SoundToggle.tsx) and turns its sound on through it, one clip at a time (lib/site/sound.ts). No video in the page (reduced
 *   motion, Save-Data, a slow link) means no toggle.
 */
export function LoopClip({
  clip,
  sources: own,
  poster,
  early = false,
  position,
  compact = false,
  together = false,
  captions,
  audio = false,
  soundKey,
  soundToggle = true,
}: {
  poster: string;
  /**
   * Captions for a clip with spoken words (a Studio piece, components/site/StudioClip.tsx): shown by default, because every clip
   * here plays muted and the words are otherwise lost.
   */
  captions?: { src: string; srcLang: string; label: string };
  early?: boolean;
  position?: string;
  compact?: boolean;
  /**
   * A grid of small loops (the gallery, the model tiles): each is the 640 px file on every screen, because a grid's tile is never a
   * large picture. It plays by the same rule as every clip (on screen, a turn), all of a grid's tiles in view at once.
   */
  together?: boolean;
  /** The files carry an audio track (the export's measured flag). False, the default, for anything that never said so. */
  audio?: boolean;
  /** The key a toggle placed elsewhere finds this clip by (lib/site/sound.ts); a sample passes its job id. */
  soundKey?: string;
  /** False where the clip's box is under other content and the place renders `<SoundToggle clip={soundKey} />` itself. */
  soundToggle?: boolean;
} & (
  | { clip: ClipId; sources?: undefined }
  /** A model sample's own files (components/site/showcase-assets.ts, read by ShowcaseClip): the same rules, other files. */
  | { clip?: undefined; sources: ClipSources }
)) {
  const sources: ClipSources = own ?? CLIPS[clip as ClipId];
  const ref = useRef<HTMLVideoElement>(null);
  const paused = useMotionPaused();
  // The Shorts feed is open over the page (lib/site/clip-hold.ts): the clips under it hold their frame.
  const held = useClipsHeld();
  const [allowed, setAllowed] = useState(false);
  // A phone gets the 640 x 360 rendition (about a quarter of the bytes); a screen of 860 px or more the 1280 x 720 one, and a
  // sample with a larger file (`sources.lg`) that one on a screen with the pixels for it (lib/site/renditions.ts).
  const [size, setSize] = useState<"sm" | "md" | "lg">("md");
  // Whether the file is chosen. Only a clip with a larger file waits: that choice needs its frame's real width, which exists
  // once the video is in the page, and nothing may play (and fetch the 1280 file) before it is made.
  const [sized, setSized] = useState(false);
  const [wanted, setWanted] = useState(false);
  const visible = usePageVisible();
  // The page's holds: the visitor's switch, the Shorts feed, a hidden tab. Under one of them the clip keeps the frame it stopped on.
  const hold = paused || held || !visible;
  const near = useClipNear(ref, allowed);
  // A turn is asked for only while nothing holds the clip, so a held clip never keeps another from playing.
  const turn = useClipTurn(ref, sized && wanted && !hold, allowed);
  const ownKey = useId();
  const key = soundKey ?? ownKey;

  const sizeNow = useRef(size);
  sizeNow.current = size;
  const holdNow = useRef(hold);
  holdNow.current = hold;
  const mayPlay = useRef(false);
  mayPlay.current = sized && wanted && turn && !hold;
  // Sound turned on while the page held the clip: the full file is fetched only when it plays again (never a load() under a
  // hold, which would also drop the frame the visitor stopped on). The moment to resume from, or null.
  const swapLater = useRef<number | null>(null);
  const resumeAt = useRef<number | null>(null);
  // Sound only where the file that would play carries it: the 1280 copies do when `audio`, a larger file only when it says so.
  const canSound = audio && (size !== "lg" || sources.lg?.audio === true);

  // A clip with sound joins the one-at-a-time registry only while its video is in the page, so a toggle exists only then.
  // The 640 copies are silent (tools/export_showcase.py: they are the phone and grid files, and sound would add about a quarter
  // to a median one), so a clip playing one switches to its full file when the visitor turns the sound on: the bytes of sound
  // are spent only for the one who asked. Inside the click, so the audible play() is the gesture's (a browser refuses one that
  // is not); it carries on from the same moment. Should the browser refuse it, or the full file fail to load, the toggle goes
  // back to off and the clip plays on muted (from its small file after a failure): the toggle never says "on" over silence.
  useEffect(() => {
    const v = ref.current;
    if (!allowed || !canSound || !v) return;
    const prepare = () => {
      if (sizeNow.current !== "sm" || sources.mp4 === sources.smMp4) return;
      if (holdNow.current) {
        swapLater.current = v.currentTime;
        return;
      }
      const at = v.currentTime;
      const wasPlaying = !v.paused;
      flushSync(() => setSize("md"));
      reload(v, at, wasPlaying);
    };
    return registerSound(key, v, prepare);
  }, [allowed, canSound, key, sources.mp4, sources.smMp4]);

  /** Loads the file now chosen and carries on from `at`; on an error, back to the small silent file with the sound off. */
  function reload(v: HTMLVideoElement, at: number, play: boolean) {
    const seek = () => {
      try {
        v.currentTime = at;
      } catch {
        // A file that cannot seek yet starts from its beginning; the sound is still the one asked for.
      }
    };
    // A <source> that fails fires `error` on itself, not on the video: caught on the way down.
    const failed = () => {
      done();
      flushSync(() => setSize("sm"));
      setSoundOn(v, false);
      v.load();
      v.addEventListener("loadedmetadata", seek, { once: true });
      if (mayPlay.current) void Promise.resolve(v.play()).catch(() => undefined);
    };
    const done = () => {
      v.removeEventListener("error", failed, true);
      v.removeEventListener("canplay", done);
    };
    v.addEventListener("error", failed, true);
    v.addEventListener("canplay", done);
    v.load();
    v.addEventListener("loadedmetadata", seek, { once: true });
    if (play)
      void Promise.resolve(v.play()).catch((e) => {
        if (!refusedSound(e, v)) return;
        setSoundOn(v, false);
        void Promise.resolve(v.play()).catch(() => undefined);
      });
  }

  // The postponed swap, once the new file is chosen (the play effect below asked for it).
  useEffect(() => {
    const v = ref.current;
    if (!v || size !== "md" || resumeAt.current === null) return;
    const at = resumeAt.current;
    resumeAt.current = null;
    reload(v, at, mayPlay.current);
  }, [size]);

  useEffect(() => {
    if (!clipsAllowed()) return;
    const wide = window.matchMedia("(min-width: 860px)").matches;
    const small = compact || together || !wide;
    setSize(small ? "sm" : "md");
    setSized(small || !sources.lg);
    setAllowed(true);
  }, [compact, together, sources.lg]);

  // A clip with a larger file: measured on its own frame (CSS width x device pixel ratio), not on the window, because a clip in
  // a card on a wide screen is still a small picture. Switching the file before anything played costs one load() and no bytes.
  useEffect(() => {
    const v = ref.current;
    if (!allowed || sized || !v) return;
    const c = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    const frame = (v.parentElement ?? v).getBoundingClientRect().width;
    const next = clipRendition({ small: false, hasLarge: true, devicePixels: frame * (window.devicePixelRatio || 1), fast: !c?.effectiveType || c.effectiveType === "4g" });
    setSize(next);
    setSized(true);
  }, [allowed, sized]);
  useEffect(() => {
    if (size === "lg") ref.current?.load();
  }, [size]);

  // When the clip may start: the first screen's after load and idle, the rest at once (each then waits to be near and on screen).
  useEffect(() => {
    const v = ref.current;
    if (!allowed || !v) return;
    const stops: Array<() => void> = [];
    if (early) {
      let timer = 0;
      const go = () => {
        const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
        if (idle) idle(() => setWanted(true), { timeout: 2000 });
        else timer = window.setTimeout(() => setWanted(true), 1200);
      };
      if (document.readyState === "complete") go();
      else window.addEventListener("load", go, { once: true });
      stops.push(() => {
        window.removeEventListener("load", go);
        window.clearTimeout(timer);
      });
    } else if (document.readyState === "complete") {
      setWanted(true);
    } else {
      // Before the page has loaded, the first screen's clip (`early`) is the only one that may start: every other clip waits for
      // the load and an idle moment after it, queued behind the early one's own idle callback (registered when it mounted).
      let timer = 0;
      const later = () => {
        const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
        if (idle) idle(() => setWanted(true), { timeout: 3000 });
        else timer = window.setTimeout(() => setWanted(true), 1500);
      };
      window.addEventListener("load", later, { once: true });
      stops.push(() => {
        window.removeEventListener("load", later);
        window.clearTimeout(timer);
      });
    }
    const box = v.parentElement;
    const mark = () => {
      box?.setAttribute("data-live", "true");
      setSoundLive(v, true);
    };
    // A stall mid-loop (a slow link) goes back to the still rather than holding a half-loaded frame; a blip shorter than this
    // (the loop's own seek back to 0) does not flash the still.
    let stall = 0;
    const waiting = () => {
      window.clearTimeout(stall);
      stall = window.setTimeout(() => {
        if (!v.paused && v.readyState < 3) {
          box?.removeAttribute("data-live");
          setSoundLive(v, false);
        }
      }, 400);
    };
    v.addEventListener("playing", mark);
    v.addEventListener("waiting", waiting);
    stops.push(() => {
      v.removeEventListener("playing", mark);
      v.removeEventListener("waiting", waiting);
      window.clearTimeout(stall);
      setSoundLive(v, false);
    });
    return () => stops.forEach((s) => s());
  }, [allowed, early]);

  // Play while it has a turn and nothing holds it. play() carries on from where it stopped, so a clip that scrolled away and back
  // resumes rather than starting over; its poster shows only until its next frame ("playing" puts data-live back).
  useEffect(() => {
    const v = ref.current;
    if (!allowed || !v) return;
    // A browser may refuse an audible play() outside a press (a clip whose sound was turned on while it was held or off screen):
    // the sound goes back to off and the clip plays on muted, rather than standing still under a toggle that says "on".
    if (sized && wanted && turn && !hold) {
      // Sound was turned on during a hold: fetch the full file now, and play it once chosen (the effect on `size` above).
      if (swapLater.current !== null) {
        const at = swapLater.current;
        swapLater.current = null;
        if (!v.muted && sizeNow.current === "sm") {
          resumeAt.current = at;
          setSize("md");
          return;
        }
      }
      void Promise.resolve(v.play()).catch((e) => {
        if (!refusedSound(e, v)) return;
        setSoundOn(v, false);
        void Promise.resolve(v.play()).catch(() => undefined);
      });
    } else {
      v.pause();
      if (!hold) {
        v.parentElement?.removeAttribute("data-live");
        setSoundLive(v, false);
      }
    }
  }, [allowed, sized, wanted, turn, hold]);

  // A tap on the picture is the pointer's pause: one delegated listener for the whole page (lib/site/motion.ts motionTap), which
  // also covers a still poster that drifts when no clip may play.
  useMotionTap();

  if (!allowed) return null;
  return (
    <>
      <video ref={ref} className="nx-clip" muted loop playsInline preload={wanted && near ? "auto" : "none"} poster={poster} disablePictureInPicture aria-hidden tabIndex={-1} style={position ? { objectPosition: position } : undefined}>
        {(() => {
          const webm = size === "sm" ? sources.smWebm : size === "lg" && sources.lg ? sources.lg.webm : sources.webm;
          return webm ? <source src={webm} type="video/webm" /> : null;
        })()}
        <source src={size === "sm" ? sources.smMp4 : size === "lg" && sources.lg ? sources.lg.mp4 : sources.mp4} type="video/mp4" />
        {/* After every source: the HTML content model puts tracks last. */}
        {captions && <track kind="captions" src={captions.src} srcLang={captions.srcLang} label={captions.label} default />}
      </video>
      {canSound && soundToggle && <SoundToggle clip={key} />}
    </>
  );
}
