"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_RECORDING_SECONDS, MAX_RECORDING_TOLERANCE_SECONDS, MIN_RECORDING_SECONDS, sampleTypeFor } from "@/lib/custom-voice";

/**
 * Live recording in the browser, and nothing else: no file picker, no drag and drop, no import (v1 takes a live recording only,
 * docs/CUSTOM_VOICE.md). The length guard is here so that a recording outside 30 to 60 seconds is never offered for upload: shorter
 * is thrown away and the person is told, longer is stopped at the limit. The clock is the page's own and only a first line of
 * defence; the worker measures the decoded audio itself and believes nobody's header or clock.
 *
 * States:
 *  idle         nothing yet
 *  unsupported  no MediaRecorder or no microphone API in this browser (or none the bucket accepts a type from)
 *  blockedBySite the page's Permissions-Policy does not allow the microphone at all (not the person's choice; see the deploy note
 *               in docs/CUSTOM_VOICE.md): told apart from "denied" because the remedy is different
 *  requesting   waiting for the person's answer to the browser's microphone prompt
 *  recording    the clock is running
 *  recorded     a take within the guard is ready to listen to and to send
 *  tooShort     the take was shorter than the guard; discarded
 *  tooLong      the take ran past the limit (a paused or throttled tab); discarded, never shortened on screen with the longer audio kept
 *               (unless `keepOverLimit`: then it is `recorded`, with its real length and `overMax` set)
 *  denied       the person (or their browser settings) refused the microphone
 *  noDevice     no microphone found
 *  failed       anything else the recorder reported
 */
export type RecorderState =
  | "idle"
  | "unsupported"
  | "blockedBySite"
  | "requesting"
  | "recording"
  | "recorded"
  | "tooShort"
  | "tooLong"
  | "denied"
  | "noDevice"
  | "failed";

export type Take = { blob: Blob; url: string; type: string; ext: string; seconds: number };

/**
 * What a caller may change. The defaults are the custom voice's (a 30 to 60 second sample, the voice-samples bucket's
 * types), so that page is unchanged; the editor's voice-over passes its own limits and types and asks for a level meter.
 */
export interface RecorderOptions {
  /** A take shorter than this is thrown away (`tooShort`). */
  minSeconds?: number;
  /** The take is stopped at this length. */
  maxSeconds?: number;
  /** How far past `maxSeconds` a take may run before it is thrown away (`tooLong`): a paused tab. */
  toleranceSeconds?: number;
  /** The recorder's type -> the type and extension the take is kept as; null = not one the destination accepts. */
  typeFor?: (mime: string | null | undefined) => { type: string; ext: string } | null;
  /** Measure the input level while recording (`level`, 0..1), where the browser has Web Audio. */
  meter?: boolean;
  /**
   * A take that ran past `maxSeconds + toleranceSeconds` (a background tab whose timers were throttled, so the stop at
   * the limit came late) is KEPT, with its real length, instead of thrown away as `tooLong`. For a take that can be
   * trimmed afterwards (the editor's voice-over); the custom voice sample keeps the strict default.
   */
  keepOverLimit?: boolean;
  /** Passed to MediaRecorder: a known bit rate makes the size of a long take predictable. */
  audioBitsPerSecond?: number;
}

type AudioContextLike = {
  createMediaStreamSource: (s: MediaStream) => { connect: (n: unknown) => void; disconnect?: () => void };
  createAnalyser: () => { fftSize: number; getByteTimeDomainData: (a: Uint8Array) => void };
  close?: () => Promise<void> | void;
};

/** RMS of 8-bit time-domain samples (128 = silence) as 0..1, scaled so ordinary speech reads well up the meter. */
export function levelOf(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const v of samples) {
    const x = (v - 128) / 128;
    sum += x * x;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3);
}

/** Types tried in this order; the first the browser supports is used. Safari records audio/mp4, the others webm or ogg. */
const CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"];

type PolicyLike = { allowsFeature?: (feature: string) => boolean };

/** Does this page's Permissions-Policy forbid the microphone outright? Unknown (a browser without the API) counts as allowed. */
export function microphoneBlockedBySite(doc: Document = document): boolean {
  const d = doc as unknown as { permissionsPolicy?: PolicyLike; featurePolicy?: PolicyLike };
  const policy = d.permissionsPolicy ?? d.featurePolicy;
  try {
    return typeof policy?.allowsFeature === "function" && policy.allowsFeature("microphone") === false;
  } catch {
    return false;
  }
}

function supported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

function pickMime(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c));
}

export function useVoiceRecorder(options: RecorderOptions = {}) {
  // Read through a ref: the callbacks below stay the same across renders whatever object the caller passes.
  const opts = useRef(options);
  opts.current = options;
  // Always "idle" on the first render, so the server's HTML and the browser's agree; what this browser can do is read on mount.
  const [state, setState] = useState<RecorderState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  /** The length of a take that was thrown away for being too short or too long, so the message can say how long it was. */
  const [shortBy, setShortBy] = useState<number | null>(null);
  /** The take stopped because it reached the limit (told to the person; a longer one is never recorded). */
  const [hitMax, setHitMax] = useState(false);
  /** The kept take ran past the limit (`keepOverLimit`); its length is the measured one, not the limit. */
  const [overMax, setOverMax] = useState(false);
  /** The input level while recording (0..1), or null where it is not measured (no meter asked, no Web Audio). */
  const [level, setLevel] = useState<number | null>(null);

  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const url = useRef<string | null>(null);
  // Set when stop() was asked: onstop then builds the take. A recorder that stops for another reason (an error, an unplugged
  // device) must not produce one.
  const wanted = useRef(false);
  const alive = useRef(true);
  const audio = useRef<AudioContextLike | null>(null);
  const meterTick = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Bumped by cancel(): a microphone answer that arrives after it belongs to a request nobody wants any more. */
  const generation = useRef(0);

  const release = useCallback(() => {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
    if (meterTick.current) clearInterval(meterTick.current);
    meterTick.current = null;
    // The meter holds the stream too: its context is closed with it, or the browser keeps the input open.
    try {
      void audio.current?.close?.();
    } catch {
      // already closed
    }
    audio.current = null;
    if (alive.current) setLevel(null);
    // The microphone light goes off the moment recording ends, whatever ended it.
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  const dropTake = useCallback(() => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    setTake(null);
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!supported()) setState("unsupported");
    else if (microphoneBlockedBySite()) setState("blockedBySite");
    return () => {
      alive.current = false;
      wanted.current = false;
      try {
        if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
      } catch {
        // already stopped
      }
      release();
      if (url.current) URL.revokeObjectURL(url.current);
    };
  }, [release]);

  const finish = useCallback(
    (elapsed: number) => {
      const rec = recorder.current;
      const mime = (rec?.mimeType || chunks.current[0]?.type || "").toString();
      const kind = (opts.current.typeFor ?? sampleTypeFor)(mime);
      const blob = new Blob(chunks.current, { type: kind?.type ?? mime });
      chunks.current = [];
      release();
      if (!alive.current) return;
      if (!kind || blob.size === 0) {
        setState("failed");
        return;
      }
      const { minSeconds = MIN_RECORDING_SECONDS, maxSeconds = MAX_RECORDING_SECONDS, toleranceSeconds = MAX_RECORDING_TOLERANCE_SECONDS } =
        opts.current;
      if (elapsed < minSeconds) {
        setShortBy(elapsed);
        setSeconds(0);
        setState("tooShort");
        return;
      }
      // The page's clock stops the take at 60 within one tick; anything well past that means the timers were paused (a background
      // tab) while the recorder kept going. Showing "60 s" over a longer recording would be a measurement we did not make.
      const over = elapsed > maxSeconds + toleranceSeconds;
      if (over && !opts.current.keepOverLimit) {
        setShortBy(elapsed);
        setSeconds(0);
        setState("tooLong");
        return;
      }
      // Kept past the limit: shown as the length it really is, never as the limit (a measurement we did not make).
      const clamped = over ? Math.floor(elapsed) : Math.min(Math.floor(elapsed), maxSeconds);
      setOverMax(over);
      const objectUrl = URL.createObjectURL(blob);
      url.current = objectUrl;
      setSeconds(clamped);
      setTake({ blob, url: objectUrl, type: kind.type, ext: kind.ext, seconds: clamped });
      setState("recorded");
    },
    [release],
  );

  const stop = useCallback(() => {
    const rec = recorder.current;
    if (!rec || rec.state === "inactive") return;
    wanted.current = true;
    try {
      rec.stop();
    } catch {
      wanted.current = false;
      release();
      setState("failed");
    }
  }, [release]);

  /** A level meter on the live input: an AnalyserNode read ten times a second. Never connected to the speakers. */
  const startMeter = useCallback((media: MediaStream) => {
    const w = window as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
    const Ctx = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) return;
    try {
      const ctx = new Ctx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(media).connect(analyser);
      audio.current = ctx;
      const buf = new Uint8Array(analyser.fftSize);
      setLevel(0);
      meterTick.current = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        if (alive.current) setLevel(levelOf(buf));
      }, 100);
    } catch {
      // No meter is not a failed recording: the take goes on, the meter is simply not shown.
      audio.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    if (!supported()) {
      setState("unsupported");
      return;
    }
    if (microphoneBlockedBySite()) {
      setState("blockedBySite");
      return;
    }
    dropTake();
    setShortBy(null);
    setHitMax(false);
    setOverMax(false);
    setSeconds(0);
    setState("requesting");
    const mine = ++generation.current;
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (!alive.current || mine !== generation.current) return;
      const name = (e as { name?: string } | null)?.name ?? "";
      setState(name === "NotFoundError" || name === "OverconstrainedError" ? "noDevice" : name === "NotAllowedError" || name === "SecurityError" ? "denied" : "failed");
      return;
    }
    if (!alive.current || mine !== generation.current) {
      media.getTracks().forEach((t) => t.stop());
      return;
    }
    stream.current = media;
    chunks.current = [];
    let rec: MediaRecorder;
    try {
      const mimeType = pickMime();
      const bits = opts.current.audioBitsPerSecond;
      const recOpts: MediaRecorderOptions = { ...(mimeType ? { mimeType } : {}), ...(bits ? { audioBitsPerSecond: bits } : {}) };
      rec = Object.keys(recOpts).length > 0 ? new MediaRecorder(media, recOpts) : new MediaRecorder(media);
    } catch {
      release();
      setState("unsupported");
      return;
    }
    recorder.current = rec;
    wanted.current = false;
    rec.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) chunks.current.push(ev.data);
    };
    rec.onerror = () => {
      wanted.current = false;
      chunks.current = [];
      release();
      if (alive.current) setState("failed");
    };
    rec.onstop = () => {
      if (!wanted.current) return;
      wanted.current = false;
      finish((Date.now() - startedAt.current) / 1000);
    };
    startedAt.current = Date.now();
    try {
      rec.start();
    } catch {
      release();
      setState("failed");
      return;
    }
    setState("recording");
    if (opts.current.meter) startMeter(media);
    const maxSeconds = opts.current.maxSeconds ?? MAX_RECORDING_SECONDS;
    tick.current = setInterval(() => {
      const elapsed = (Date.now() - startedAt.current) / 1000;
      if (elapsed >= maxSeconds) {
        setSeconds(maxSeconds);
        setHitMax(true);
        stop();
        return;
      }
      setSeconds(Math.floor(elapsed));
    }, 250);
  }, [dropTake, finish, release, stop, startMeter]);

  const reset = useCallback(() => {
    dropTake();
    setShortBy(null);
    setHitMax(false);
    setOverMax(false);
    setSeconds(0);
    setState(supported() ? (microphoneBlockedBySite() ? "blockedBySite" : "idle") : "unsupported");
  }, [dropTake]);

  /** Throw away whatever is going on (a take in progress or a finished one) and release the microphone. No take is made. */
  const cancel = useCallback(() => {
    generation.current++;
    wanted.current = false;
    try {
      if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
    } catch {
      // already stopped
    }
    chunks.current = [];
    release();
    reset();
  }, [release, reset]);

  return { state, seconds, take, shortBy, hitMax, overMax, level, start, stop, reset, cancel };
}
