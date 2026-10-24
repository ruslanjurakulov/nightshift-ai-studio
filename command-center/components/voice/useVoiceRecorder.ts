"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_RECORDING_SECONDS, MIN_RECORDING_SECONDS, sampleTypeFor } from "@/lib/custom-voice";

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
  | "denied"
  | "noDevice"
  | "failed";

export type Take = { blob: Blob; url: string; type: string; ext: string; seconds: number };

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

export function useVoiceRecorder() {
  // Always "idle" on the first render, so the server's HTML and the browser's agree; what this browser can do is read on mount.
  const [state, setState] = useState<RecorderState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  /** The length of the take that was thrown away for being too short, so the message can say how long it was. */
  const [shortBy, setShortBy] = useState<number | null>(null);
  /** The take stopped because it reached the limit (told to the person; a longer one is never recorded). */
  const [hitMax, setHitMax] = useState(false);

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

  const release = useCallback(() => {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
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
      const kind = sampleTypeFor(mime);
      const blob = new Blob(chunks.current, { type: kind?.type ?? mime });
      chunks.current = [];
      release();
      if (!alive.current) return;
      if (!kind || blob.size === 0) {
        setState("failed");
        return;
      }
      if (elapsed < MIN_RECORDING_SECONDS) {
        setShortBy(elapsed);
        setSeconds(0);
        setState("tooShort");
        return;
      }
      const clamped = Math.min(elapsed, MAX_RECORDING_SECONDS);
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
    setSeconds(0);
    setState("requesting");
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (!alive.current) return;
      const name = (e as { name?: string } | null)?.name ?? "";
      setState(name === "NotFoundError" || name === "OverconstrainedError" ? "noDevice" : name === "NotAllowedError" || name === "SecurityError" ? "denied" : "failed");
      return;
    }
    if (!alive.current) {
      media.getTracks().forEach((t) => t.stop());
      return;
    }
    stream.current = media;
    chunks.current = [];
    let rec: MediaRecorder;
    try {
      const mimeType = pickMime();
      rec = mimeType ? new MediaRecorder(media, { mimeType }) : new MediaRecorder(media);
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
    tick.current = setInterval(() => {
      const elapsed = (Date.now() - startedAt.current) / 1000;
      if (elapsed >= MAX_RECORDING_SECONDS) {
        setSeconds(MAX_RECORDING_SECONDS);
        setHitMax(true);
        stop();
        return;
      }
      setSeconds(Math.floor(elapsed));
    }, 250);
  }, [dropTake, finish, release, stop]);

  const reset = useCallback(() => {
    dropTake();
    setShortBy(null);
    setHitMax(false);
    setSeconds(0);
    setState(supported() ? (microphoneBlockedBySite() ? "blockedBySite" : "idle") : "unsupported");
  }, [dropTake]);

  return { state, seconds, take, shortBy, hitMax, start, stop, reset };
}
