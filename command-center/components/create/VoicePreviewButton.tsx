"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { isVoiceId } from "@/lib/ttsModels";

/**
 * Listen to a narrator voice before choosing it. Plays the clip the
 * voice_previews workflow prepared (private bucket, signed URL from
 * /api/voices/preview). A voice without a clip yet — a custom id — is asked
 * for once, then polled until the clip exists (about a minute).
 */

type State = "idle" | "loading" | "preparing" | "playing" | "failed";

const POLL_MS = 5000;
const POLL_TRIES = 36; // three minutes

async function signedUrl(voiceId: string): Promise<string | null> {
  const res = await fetch(`/api/voices/preview?voice_id=${encodeURIComponent(voiceId)}`);
  if (!res.ok) throw new Error("preview_lookup_failed");
  const data = (await res.json()) as { ready?: boolean; url?: string };
  return data.ready && data.url ? data.url : null;
}

export function VoicePreviewButton({ voiceId, channelId }: { voiceId: string; channelId: string | null }) {
  const { t } = useI18n();
  const [state, setState] = useState<State>("idle");
  const audio = useRef<HTMLAudioElement | null>(null);
  const cancelled = useRef(false);

  // A different voice, or leaving the page, stops whatever was playing or polling.
  useEffect(() => {
    cancelled.current = false;
    setState("idle");
    return () => {
      cancelled.current = true;
      audio.current?.pause();
      audio.current = null;
    };
  }, [voiceId]);

  const valid = isVoiceId(voiceId);

  function play(url: string) {
    audio.current?.pause();
    const a = new Audio(url);
    audio.current = a;
    a.onended = () => setState("idle");
    a.onerror = () => setState("failed");
    setState("playing");
    a.play().catch(() => setState("failed"));
  }

  async function onClick() {
    if (state === "playing") {
      audio.current?.pause();
      setState("idle");
      return;
    }
    if (!valid || state === "loading" || state === "preparing") return;
    setState("loading");
    try {
      const url = await signedUrl(voiceId);
      if (url) return play(url);
      if (!channelId) return setState("failed");
      const res = await fetch("/api/voices/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_id: voiceId, channel_id: channelId }),
      });
      if (!res.ok) return setState("failed");
      setState("preparing");
      for (let i = 0; i < POLL_TRIES; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (cancelled.current) return;
        const ready = await signedUrl(voiceId);
        if (ready) return play(ready);
      }
      setState("failed");
    } catch {
      if (!cancelled.current) setState("failed");
    }
  }

  const label =
    state === "playing" ? t.create.voiceStop : state === "preparing" ? t.create.voicePreparing : t.create.voiceListen;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={!valid || state === "loading" || state === "preparing"}
        aria-label={label}
        title={label}
        className="btn-sky is-quiet pill inline-flex items-center justify-center gap-2 px-4 py-2 text-[12px] disabled:opacity-50"
      >
        {state === "loading" || state === "preparing" ? (
          <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
        ) : state === "playing" ? (
          <Square aria-hidden className="size-3.5" />
        ) : (
          <Play aria-hidden className="size-3.5" />
        )}
        <span>{label}</span>
      </button>
      <span aria-live="polite" className="text-[11px] text-[var(--color-muted)]">
        {state === "preparing" ? t.create.voicePreparingHint : state === "failed" ? t.create.voicePreviewFailed : ""}
      </span>
    </div>
  );
}
