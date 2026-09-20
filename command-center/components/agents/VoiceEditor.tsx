"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import type { ChannelAgentConfig } from "@/lib/types";

/**
 * Choose the channel's narration voice — and hear it first.
 *
 * The pipeline reads this channel's `tts_provider` / `elevenlabs_voice_id` /
 * `edge_tts_voice` on every run, so the voice picked here is the voice EVERY
 * run uses — the scheduled autopilot run, a "Run now", a Short — until it is
 * changed here and a new run starts. That is the whole point: pick the voice
 * once, activate autopilot, and it keeps narrating in that voice.
 *
 * ElevenLabs voices are listed from the account (never typed): click a voice to
 * preview it, pick the one you like, and Save. The API key is used for exactly
 * one call to list the voices and is never stored — same contract as the
 * channel wizard and the /api/setup/voices route. Editing writes only the three
 * voice fields into `agent_config`, merged over the config loaded with the page.
 */
type Voice = {
  voiceId: string;
  name: string;
  category: string;
  previewUrl: string;
  labels: string;
};

export function VoiceEditor({
  channelId,
  agentConfig,
}: {
  channelId: string | null;
  agentConfig: ChannelAgentConfig | null;
}) {
  const { t } = useI18n();
  const [provider, setProvider] = useState<string>(agentConfig?.tts_provider || "elevenlabs");
  const [edgeVoice, setEdgeVoice] = useState<string>(agentConfig?.edge_tts_voice || "");
  const [selected, setSelected] = useState<string>(agentConfig?.elevenlabs_voice_id || "");

  const [apiKey, setApiKey] = useState("");
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [loadPhase, setLoadPhase] = useState<"idle" | "loading" | "error">("idle");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const disabled = !channelId;

  function touch() {
    if (state !== "idle") setState("idle");
  }

  async function loadVoices() {
    const key = apiKey.trim();
    if (!key) return;
    setLoadPhase("loading");
    try {
      const res = await fetch("/api/setup/voices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadPhase("error");
        return;
      }
      setVoices(Array.isArray(data.voices) ? (data.voices as Voice[]) : []);
      setLoadPhase("idle");
    } catch {
      setLoadPhase("error");
    }
  }

  function preview(v: Voice) {
    const el = audioRef.current;
    if (!el || !v.previewUrl) return;
    if (playingId === v.voiceId) {
      el.pause();
      setPlayingId(null);
      return;
    }
    el.src = v.previewUrl;
    el.play().then(
      () => setPlayingId(v.voiceId),
      () => setPlayingId(null),
    );
  }

  async function save() {
    if (!channelId || state === "saving") return;
    const supabase = createClient();
    if (!supabase) return;
    setState("saving");
    // Only the voice fields change; everything else in the blob is preserved.
    const next: ChannelAgentConfig = {
      ...(agentConfig ?? {}),
      tts_provider: provider,
      ...(provider === "elevenlabs"
        ? { elevenlabs_voice_id: selected }
        : { edge_tts_voice: edgeVoice.trim() }),
    };
    const { error } = await supabase
      .from("channels")
      .update({ agent_config: next, updated_at: new Date().toISOString() })
      .eq("channel_id", channelId);
    setState(error ? "error" : "saved");
  }

  const inputClass =
    "pill border border-[var(--color-border)] bg-transparent px-4 py-2 text-[13px] outline-none transition-colors focus:border-[var(--color-primary)]";

  return (
    <div className="panel flex flex-col gap-4 p-4">
      <div>
        <h2 className="t-section">{t.voice.title}</h2>
        <p className="mt-1 max-w-[72ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
          {t.voice.hint}
        </p>
        <p className="mt-1 max-w-[72ch] text-[11px] leading-relaxed text-[var(--color-primary)]">
          {t.voice.usedNote}
        </p>
      </div>

      {disabled && <p className="text-[13px] text-[var(--color-warn)]">{t.voice.pickChannel}</p>}

      {!disabled && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
              {t.voice.provider}
            </span>
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                touch();
              }}
              className={inputClass}
            >
              <option value="elevenlabs">ElevenLabs</option>
              <option value="edge">Edge (free)</option>
            </select>
          </label>

          {provider === "edge" ? (
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
                {t.voice.edgeLabel}
              </span>
              <input
                value={edgeVoice}
                onChange={(e) => {
                  setEdgeVoice(e.target.value);
                  touch();
                }}
                placeholder="en-US-AriaNeural"
                className={inputClass}
              />
            </label>
          ) : (
            <>
              {/* One-shot key to list the account's voices; never stored. */}
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
                    {t.voice.keyLabel}
                  </span>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={t.voice.keyPlaceholder}
                    className={inputClass}
                  />
                </label>
                <button
                  type="button"
                  onClick={loadVoices}
                  disabled={loadPhase === "loading" || !apiKey.trim()}
                  className="btn-sky pill px-5 py-2 text-[13px] disabled:opacity-40"
                >
                  {loadPhase === "loading" ? t.voice.loading : t.voice.load}
                </button>
              </div>
              {loadPhase === "error" && (
                <p className="text-[12px] text-[var(--color-fail)]">{t.voice.error}</p>
              )}
              {voices !== null && voices.length === 0 && (
                <p className="text-[12px] text-[var(--color-warn)]">{t.voice.none}</p>
              )}

              {/* Tap a voice to hear it; the highlighted one is the selection. */}
              {voices && voices.length > 0 && (
                <ul className="flex max-h-[380px] flex-col gap-2 overflow-y-auto">
                  {voices.map((v) => {
                    const isSel = selected === v.voiceId;
                    return (
                      <li key={v.voiceId}>
                        <div
                          className="flex items-center gap-3 rounded-[14px] border p-2.5 transition-colors"
                          style={{
                            borderColor: isSel ? "var(--color-primary)" : "var(--color-border)",
                            background: isSel ? "var(--color-panel-2)" : "transparent",
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => preview(v)}
                            disabled={!v.previewUrl}
                            aria-label={t.voice.preview}
                            className="btn-sky is-quiet pill size-8 shrink-0 text-[13px] disabled:opacity-30"
                          >
                            {playingId === v.voiceId ? "⏸" : "▶"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSelected(v.voiceId);
                              touch();
                            }}
                            className="min-w-0 flex-1 text-left"
                          >
                            <div className="truncate text-[13px] text-[var(--color-fg)]">{v.name}</div>
                            {v.labels && (
                              <div className="truncate text-[11px] text-[var(--color-muted)]">
                                {v.labels}
                              </div>
                            )}
                          </button>
                          {isSel && (
                            <span className="mono shrink-0 text-[10px] uppercase tracking-[0.18em] text-[var(--color-primary)]">
                              {t.voice.selected}
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {/* Shared hidden player, driven by the row buttons. */}
              <audio ref={audioRef} preload="none" onEnded={() => setPlayingId(null)} className="hidden" />
            </>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={
                disabled ||
                state === "saving" ||
                (provider === "elevenlabs" && !selected) ||
                (provider === "edge" && !edgeVoice.trim())
              }
              className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
            >
              {state === "saving" ? t.voice.saving : t.voice.save}
            </button>
            <span className="mono text-[11px]" aria-live="polite">
              {state === "saved" ? (
                <span className="text-[var(--color-ok)]">{t.voice.saved}</span>
              ) : state === "error" ? (
                <span className="text-[var(--color-fail)]">{t.voice.failed}</span>
              ) : null}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
