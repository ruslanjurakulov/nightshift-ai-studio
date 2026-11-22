import { useSyncExternalStore } from "react";

/**
 * Which one of the page's clips has its sound on, if any. The owner's decision of 2026-11-22: every video on the site is cinematic
 * and has sound. Browsers only autoplay a muted video, so every clip starts muted; a visitor turns one clip's sound on with its
 * toggle (components/site/SoundToggle.tsx). One at a time: two clips talking over each other is noise, so turning one on mutes
 * whichever had it. A module-level store, like the page's pause switch (lib/site/motion.ts), because the clips are separate React
 * trees in separate cards.
 *
 * Only a clip whose files carry an audio track ever registers here (the export's measured `audio`, tools/export_showcase.py), and
 * only while its video is in the page (never under reduced motion, Save-Data or a slow link, where LoopClip shows the still), so
 * no toggle can claim sound that is not there (CLAUDE.md #5). A clip registers under a key (a sample's job id) so a toggle placed
 * outside the clip's own box (the landing's first screen, whose picture sits under its words) can find it.
 */
const videos = new Map<string, HTMLVideoElement>();
/** What a clip does, inside the click, before its sound can be heard (LoopClip: switch from a silent small file to the full one). */
const prepares = new Map<HTMLVideoElement, () => void>();
let audible: HTMLVideoElement | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

/**
 * A clip with sound is in the page under `key`; it starts muted. `prepare` runs inside the click that turns its sound on (a user
 * gesture, which a browser requires for an audible play()). Returns its removal.
 */
export function registerSound(key: string, v: HTMLVideoElement, prepare?: () => void): () => void {
  v.muted = true;
  videos.set(key, v);
  if (prepare) prepares.set(v, prepare);
  notify();
  return () => {
    if (videos.get(key) === v) videos.delete(key);
    prepares.delete(v);
    if (audible === v) audible = null;
    notify();
  };
}

/**
 * Turns `v`'s sound on (and every other registered clip's off) or off. Called from the toggle's click, a user gesture, so a
 * browser lets a playing video unmute. It never starts or pauses anything itself: playing stays the clip's own rules (on screen,
 * a turn, the page's pause switch), so a clip paused by the switch stays paused, unmuted, until those rules let it play. The clip's
 * `prepare` may reload a playing clip from its full file and play it on from the same moment (LoopClip).
 */
export function setSoundOn(v: HTMLVideoElement, on: boolean): void {
  for (const other of videos.values()) if (other !== v) other.muted = true;
  v.muted = !on;
  audible = on ? v : audible === v ? null : audible;
  notify();
  if (on) prepares.get(v)?.();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** The video registered under `key`, or null (no such clip, no sound, or its video is not in the page). */
export function useSoundVideo(key: string): HTMLVideoElement | null {
  return useSyncExternalStore(
    subscribe,
    () => videos.get(key) ?? null,
    () => null,
  );
}

/** Whether `v` is the clip whose sound is on. False on the server and before the video exists. */
export function useSoundOn(v: HTMLVideoElement | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => v !== null && audible === v,
    () => false,
  );
}

/** For tests: forget every clip. */
export function resetSoundForTests(): void {
  videos.clear();
  prepares.clear();
  audible = null;
  notify();
}
