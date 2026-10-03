"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import type { ChannelAgentConfig } from "@/lib/types";
import type { QueueJob, RunBackend } from "@/lib/runBackend";
import { creditRunError, isExtraOffRefusal } from "@/lib/credits";
import { ExtraOffLink } from "@/components/usage/ExtraOffLink";
import { CreditEstimateLine } from "@/components/credits/CreditEstimateLine";
import { IMAGE_GENERATORS } from "@/lib/imageProviders";
import { TTS_MODELS, TTS_MODEL_LABELS, VOICES, isVoiceId } from "@/lib/ttsModels";
import { VoicePreviewButton } from "@/components/create/VoicePreviewButton";
import type { RunPrefill } from "@/lib/home";
import type { RunDna } from "@/lib/channel-dna";
import { ChannelDnaHint } from "@/components/studio/ChannelDnaHint";

const CUSTOM_VOICE = "__custom__";

/** A connected account the video can be made for (lib/connectedAccounts.ts). */
export interface CreateTarget {
  platform: "youtube" | "instagram" | "tiktok";
  id: string;
  name: string;
  connected: boolean;
}

const PLATFORM_LABEL: Record<CreateTarget["platform"], string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
};

/**
 * The Create studio — one page to type a topic, set the run's controls, press
 * Create, and watch the pipeline work.
 *
 * It is honest about this project's shape: generation is autonomous (it runs on
 * GitHub Actions, not synchronously in the browser), so Create DISPATCHES a run
 * and the progress panel below then polls the pipeline's own events — near
 * real-time, not an instant in-browser render. The per-run controls that the
 * pipeline actually reads (length, language, visual style + the topic) are here;
 * the model choices that are channel- or repo-level (narration voice, image and
 * video providers, scripter) are shown with a link to where they are set, so the
 * whole picture is on one page without pretending a control does something it
 * doesn't.
 */
type Ev = { ts: string; agent: string | null; event: string; status: string | null; video_id: string | null };
type Phase = "idle" | "confirm" | "starting" | "queued" | "error";

export function CreateStudio({
  channelId,
  githubConfigured,
  backend = "actions",
  agentConfig,
  canRun = true,
  operator = false,
  targets = [],
  initial = null,
  dna = null,
}: {
  channelId: string | null;
  githubConfigured: boolean;
  /** Where Run now sends the run (server env NIGHTSHIFT_RUN_BACKEND). */
  backend?: RunBackend;
  agentConfig: ChannelAgentConfig | null;
  /** Owner/admin of the channel's organization — what /api/agent/run
   *  requires. Presentation only; the route re-checks. */
  canRun?: boolean;
  /** Platform owner/admin: links into the operator's console (agents,
   *  providers, jobs) are shown only to them — anyone else would be sent back
   *  to the Command Center by the layout. */
  operator?: boolean;
  /** "Making this for:" — the organization's connected accounts. Optional to pick. */
  targets?: CreateTarget[];
  /** From Home's composer (lib/home runPrefillFromQuery): fills the form only.
   *  Create still asks for confirmation, with the price shown, as always. */
  initial?: RunPrefill | null;
  /** The channel's DNA (0056): where an empty field starts. Home's choices win; Create still asks. */
  dna?: (RunDna & { href: string }) | null;
}) {
  const { t, locale } = useI18n();
  const path = useChannelPath();

  const [brief, setBrief] = useState(initial?.brief ?? "");
  const [duration, setDuration] = useState(initial?.duration || dna?.duration || "");
  const [language, setLanguage] = useState(initial?.language || dna?.language || "");
  const [style, setStyle] = useState("");
  const [videoProvider, setVideoProvider] = useState("");
  const [imageProvider, setImageProvider] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  // "" = the channel's voice, a voice id, or CUSTOM_VOICE to type one in.
  const [voice, setVoice] = useState(dna?.voice ?? "");
  const [customVoice, setCustomVoice] = useState("");
  // "platform:id" of the account this video is for, or "" (none chosen).
  const [target, setTarget] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorKey, setErrorKey] = useState<"unauthorized" | "failed">("failed");
  // A refusal about credits (not enough, no estimate, not set up) — said
  // plainly, instead of the generic "couldn't start".
  const [creditError, setCreditError] = useState<string | null>(null);
  const [extraOff, setExtraOff] = useState(false);
  const [events, setEvents] = useState<Ev[]>([]);
  // Queue mode only: this channel's latest render_jobs, so a job still waiting
  // for the worker is visible as waiting, not as a run that never started.
  const [jobs, setJobs] = useState<QueueJob[] | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const blocked = !channelId || !githubConfigured || !canRun;

  async function loadEvents() {
    try {
      const res = await fetch("/api/agent/events", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.events)) setEvents(data.events as Ev[]);
      if (res.ok) setJobs(Array.isArray(data.jobs) ? (data.jobs as QueueJob[]) : null);
    } catch {
      /* a dropped poll is not an error worth showing */
    }
  }

  // Poll the pipeline's events while a run is in flight, so the panel is live.
  useEffect(() => {
    if (phase !== "queued") return;
    loadEvents();
    pollRef.current = setInterval(loadEvents, 4000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [phase]);

  async function create() {
    if (!channelId) return;
    setPhase("starting");
    setCreditError(null);
    const topic = brief.trim().slice(0, 300);
    const dur = Number(duration);
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: channelId,
          ...(topic ? { topic } : {}),
          ...(duration && Number.isFinite(dur) && dur > 0 ? { duration: dur } : {}),
          ...(language ? { language } : {}),
          ...(style.trim() ? { visual_style: style.trim() } : {}),
          ...(videoProvider ? { video_provider: videoProvider } : {}),
          ...(imageProvider ? { image_provider: imageProvider } : {}),
          ...(ttsModel ? { tts_model: ttsModel } : {}),
          ...(voiceId && isVoiceId(voiceId) ? { voice_id: voiceId } : {}),
          ...(target ? { publish_hint: target } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorKey(data.error === "github_unauthorized" ? "unauthorized" : "failed");
        setCreditError(creditRunError(data, t, locale));
        setExtraOff(isExtraOffRefusal(data));
        setPhase("error");
        return;
      }
      setPhase("queued");
    } catch {
      setErrorKey("failed");
      setPhase("error");
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter creates; Shift+Enter is a newline (a brief can be multi-line).
    if (e.key === "Enter" && !e.shiftKey && !blocked && phase !== "starting") {
      e.preventDefault();
      setPhase("confirm");
    }
  }

  const voiceId = voice === CUSTOM_VOICE ? customVoice.trim() : voice;
  const customVoiceInvalid = voice === CUSTOM_VOICE && customVoice.trim() !== "" && !isVoiceId(customVoice.trim());

  const selectClass =
    "studio-field min-h-[44px] w-full px-3 py-2 text-[16px] text-[var(--color-fg)] outline-none sm:min-h-[40px] sm:text-[13px]";

  const styleOf = (v: { id: string; style: string }) => (t.desk.voiceStyles as Record<string, string>)[v.id] ?? v.style;
  // The channel's voice in words. The provider and the raw id are the operator's to see.
  const voiceChip =
    agentConfig?.tts_provider === "edge"
      ? `Edge · ${agentConfig?.edge_tts_voice || "—"}`
      : `ElevenLabs · ${agentConfig?.elevenlabs_voice_id ? agentConfig.elevenlabs_voice_id.slice(0, 8) + "…" : "—"}`;

  const connectedTargets = targets.filter((a) => a.connected);

  return (
    <div id="run" className="flex scroll-mt-4 flex-col gap-4">
      {initial && <p className="text-[13px] text-[var(--color-muted)]">{t.create.prefilled}</p>}
      {dna && <ChannelDnaHint href={dna.href} />}
      {connectedTargets.length > 0 && (
        <div className="flex justify-center">
          <label className="flex flex-wrap items-center justify-center gap-2">
            <span className="studio-label">
              {t.publish.makingFor}
            </span>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className={selectClass}
              aria-describedby="making-for-hint"
            >
              <option value="">{t.publish.makingForNone}</option>
              {connectedTargets.map((a) => (
                <option key={`${a.platform}:${a.id}`} value={`${a.platform}:${a.id}`}>
                  {PLATFORM_LABEL[a.platform]} · {a.name}
                </option>
              ))}
            </select>
            <span id="making-for-hint" className="text-[11px] text-[var(--color-muted)]">
              {t.publish.makingForHint}
            </span>
          </label>
        </div>
      )}

      {blocked && (
        <p className="text-[13px] text-[var(--color-warn)]">
          {!channelId ? t.create.pickChannel : !githubConfigured ? t.create.notConfigured : t.create.needsAdmin}
        </p>
      )}

      {/* The prompt: a topic, an idea, or a short brief. */}
      <div className="studio-surface p-4">
        <label htmlFor="run-brief" className="studio-label mb-2 block">
          {t.home.promptLabel}
        </label>
        <textarea
          id="run-brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={onKeyDown}
          rows={4}
          maxLength={300}
          autoFocus={initial !== null}
          placeholder={t.create.placeholder}
          className="studio-field w-full resize-y px-3 py-3 text-[16px] leading-relaxed outline-none placeholder:text-[var(--color-muted)] sm:text-[15px]"
        />

        {/* Per-run controls the pipeline actually reads. */}
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="studio-label">{t.agents.runDurationLabel}</span>
            <select value={duration} onChange={(e) => setDuration(e.target.value)} className={selectClass}>
              <option value="">{t.agents.runOptChannel}</option>
              <option value="60">{t.agents.runDur1m}</option>
              <option value="180">{t.agents.runDur3m}</option>
              <option value="300">{t.agents.runDur5m}</option>
              <option value="600">{t.agents.runDur10m}</option>
              <option value="1200">{t.agents.runDur20m}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="studio-label">{t.agents.runLangLabel}</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} className={selectClass}>
              <option value="">{t.agents.runOptChannel}</option>
              <option value="Uzbek">O&apos;zbek</option>
              <option value="English">English</option>
              <option value="Arabic">العربية</option>
              <option value="Russian">Русский</option>
              <option value="Spanish">Español</option>
              <option value="Chinese">中文</option>
              <option value="Korean">한국어</option>
              <option value="Indonesian">Indonesia</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="studio-label">{t.agents.runStyleLabel}</span>
            <input value={style} onChange={(e) => setStyle(e.target.value)} placeholder={t.agents.runStylePlaceholder} maxLength={300} className={selectClass} />
          </label>
        </div>

        {/* Per-run model routing: which model turns stills into b-roll, and which
            supplies the imagery. Empty = the repo's configured default. */}
        {/* Provider-level routing is the platform operator's: a customer's run uses the
            channel's own setup, and customer screens never name a provider. */}
        {operator && (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className="studio-label">{t.create.videoModel}</span>
              <select value={videoProvider} onChange={(e) => setVideoProvider(e.target.value)} className={selectClass}>
                <option value="">{t.create.optDefault}</option>
                <option value="seedance">Seedance</option>
                <option value="kling">Kling</option>
                <option value="veo">Veo</option>
                <option value="higgsfield">Higgsfield</option>
                <option value="wan">Wan</option>
                <option value="minimax">MiniMax</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="studio-label">{t.create.imageModel}</span>
              <select value={imageProvider} onChange={(e) => setImageProvider(e.target.value)} className={selectClass}>
                <option value="">{t.create.optDefault}</option>
                <option value="pexels">Pexels (stock)</option>
                {IMAGE_GENERATORS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="studio-label">{t.create.voiceModel}</span>
              <select value={ttsModel} onChange={(e) => setTtsModel(e.target.value)} className={selectClass}>
                <option value="">{t.create.optDefault}</option>
                {TTS_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {TTS_MODEL_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {/* The narrator for this run only: the channel keeps its own voice.
            "Listen" plays the chosen voice (or the channel's) before running. */}
        <div className="mt-2 grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <label className="flex flex-col gap-1">
            <span className="studio-label">{t.create.voicePick}</span>
            <select value={voice} onChange={(e) => setVoice(e.target.value)} className={selectClass}>
              <option value="">{t.create.voiceChannel}</option>
              {VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {styleOf(v)}
                </option>
              ))}
              <option value={CUSTOM_VOICE}>{t.create.voiceCustom}</option>
            </select>
          </label>
          {voice === CUSTOM_VOICE && (
            <label className="flex flex-col gap-1">
              <span className="studio-label">{t.create.voiceCustomId}</span>
              <input
                value={customVoice}
                onChange={(e) => setCustomVoice(e.target.value)}
                placeholder="pNInz6obpgDQGcFmaJgB"
                maxLength={40}
                spellCheck={false}
                aria-invalid={customVoiceInvalid}
                className={selectClass + " mono"}
              />
              {customVoiceInvalid && (
                <span className="text-[11px] text-[var(--color-warn)]">{t.create.voiceCustomInvalid}</span>
              )}
            </label>
          )}
          <div className={voice === CUSTOM_VOICE ? "" : "sm:col-start-3"}>
            <VoicePreviewButton voiceId={voiceId || agentConfig?.elevenlabs_voice_id || ""} channelId={channelId} />
          </div>
        </div>

        {/* Models governed elsewhere — shown here, edited there. The provider and the
            raw voice id are the platform operator's; a customer's run uses the channel's. */}
        {operator && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-[var(--color-muted)]">{t.create.models}:</span>
          <span className="rounded-[var(--ns-r-chip)] border border-[var(--color-border)] px-2.5 py-1 text-[var(--color-muted)]">
            {t.create.voice}: {voiceChip}
          </span>
          {operator && (
            <>
              <Link href={path("/agents")} className="tap-link text-[var(--color-primary)] hover:underline">
                {t.create.editVoice}
              </Link>
              <Link href={path("/providers")} className="tap-link text-[var(--color-primary)] hover:underline">
                {t.create.editProviders}
              </Link>
            </>
          )}
        </div>
        )}

        {/* Create — asks once, because it spends money and can produce a video. */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {phase === "confirm" ? (
            <>
              <button
                type="button"
                onClick={create}
                className="studio-cta w-auto min-h-[44px] px-6 text-[14px]"
              >
                {t.create.confirm}
              </button>
              <button type="button" onClick={() => setPhase("idle")} className="btn-quiet min-h-[44px] px-4 text-[13px]">
                {t.create.cancel}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={blocked || phase === "starting"}
              onClick={() => setPhase("confirm")}
              className="studio-cta w-auto min-h-[44px] px-6 text-[14px]"
            >
              {phase === "starting" ? t.create.starting : t.create.create}
            </button>
          )}
          <span className="mono text-[11px]" aria-live="polite">
            {phase === "queued" ? (
              <span className="text-[var(--color-ok)]">{t.create.queued}</span>
            ) : phase === "error" ? (
              <span className="text-[var(--color-fail)]">
                {creditError ?? (errorKey === "unauthorized" ? t.agents.runUnauthorized : t.agents.runFailed)}
                {extraOff && (
                  <>
                    {" "}
                    <ExtraOffLink />
                  </>
                )}
              </span>
            ) : (
              <span className="text-[var(--color-muted)]">{t.create.enterHint}</span>
            )}
          </span>
        </div>
        {/* What this run should cost, before it is confirmed. */}
        <div className="mt-2">
          <CreditEstimateLine channelId={channelId} durationS={Number(duration) > 0 ? Number(duration) : null} />
        </div>
      </div>

      {/* Live progress: the pipeline's own events, refreshed while a run is up. */}
      {phase === "queued" && (
        <div className="ns-panel flex flex-col gap-2 p-4">
          <h2 className="ns-eyebrow">{t.create.progressTitle}</h2>
          <p className="text-[12px] text-[var(--color-muted)]">
            {backend === "queue" ? t.create.progressHintQueue : t.create.progressHint}
          </p>
          {backend === "queue" && jobs && jobs.length > 0 && (
            <ol className="flex flex-col gap-1.5" aria-label={t.create.queueTitle}>
              {jobs.slice(0, 3).map((j) => (
                <li key={j.id} className="flex flex-wrap items-center gap-3 text-[12px]">
                  <span className="mono shrink-0 text-[11px] text-[var(--color-muted)]">
                    {t.create.queueJob} #{j.id}
                  </span>
                  <span
                    className="shrink-0 text-[9px] uppercase tracking-[0.18em]"
                    style={{
                      color:
                        j.status === "succeeded"
                          ? "var(--color-ok)"
                          : j.status === "failed"
                            ? "var(--color-fail)"
                            : j.status === "running"
                              ? "var(--color-primary)"
                              : "var(--color-muted)",
                    }}
                  >
                    {t.create.queueStatus[j.status]}
                  </span>
                  {j.attempts > 1 && (
                    <span className="mono text-[10px] text-[var(--color-muted)]">
                      {t.create.queueAttempt} {j.attempts}
                    </span>
                  )}
                  {j.error && (
                    <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-fail)]" title={j.error}>
                      {j.error.split("\n")[0]}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
          {events.length === 0 ? (
            <p className="mono text-[12px] text-[var(--color-muted)]">{t.create.progressWaiting}</p>
          ) : (
            <ol className="mt-1 flex flex-col gap-1.5">
              {events.slice(0, 24).map((e, i) => (
                <li key={`${e.ts}-${i}`} className="flex items-center gap-3 text-[12px]">
                  <span className="mono w-14 shrink-0 text-[10px] text-[var(--color-muted)]">
                    {(e.ts ?? "").slice(11, 19)}
                  </span>
                  <span className="mono shrink-0 text-[11px] text-[var(--color-primary)]">{e.agent ?? "system"}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]">{e.event}</span>
                  {e.status && (
                    <span
                      className="shrink-0 text-[9px] uppercase tracking-[0.18em]"
                      style={{
                        color:
                          e.status === "completed"
                            ? "var(--color-ok)"
                            : e.status === "failed"
                              ? "var(--color-fail)"
                              : "var(--color-primary)",
                      }}
                    >
                      {e.status}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
          {operator && (
            <Link href={path("/jobs")} className="mt-1 text-[12px] text-[var(--color-primary)] hover:underline">
              {t.create.openJobs}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
