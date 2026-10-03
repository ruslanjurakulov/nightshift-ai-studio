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
import { StatusLamp } from "@/components/ui/StatusLamp";
import { Check, ChevronDown } from "lucide-react";
import "@/components/create/flow.css";

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
type Choice = "length" | "voice" | "look";
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
  // The one choice card that is open (length, voice or look): the rest stay a single line each.
  const [open, setOpen] = useState<Choice | null>(null);
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

  const selectClass = "fl-select";

  const styleOf = (v: { id: string; style: string }) => (t.desk.voiceStyles as Record<string, string>)[v.id] ?? v.style;
  // The channel's voice in words. The provider and the raw id are the operator's to see.
  const voiceChip =
    agentConfig?.tts_provider === "edge"
      ? `Edge · ${agentConfig?.edge_tts_voice || "—"}`
      : `ElevenLabs · ${agentConfig?.elevenlabs_voice_id ? agentConfig.elevenlabs_voice_id.slice(0, 8) + "…" : "—"}`;

  const connectedTargets = targets.filter((a) => a.connected);
  const f = t.create.flow;

  const lengths: { value: string; label: string }[] = [
    { value: "", label: f.lengthDefault },
    { value: "60", label: t.agents.runDur1m },
    { value: "180", label: t.agents.runDur3m },
    { value: "300", label: t.agents.runDur5m },
    { value: "600", label: t.agents.runDur10m },
    { value: "1200", label: t.agents.runDur20m },
  ];
  const lengthText = lengths.find((l) => l.value === duration)?.label ?? f.lengthDefault;
  const picked = VOICES.find((v) => v.id === voice);
  const voiceText = voice === CUSTOM_VOICE ? voiceId || f.voiceOwn : picked ? picked.name : f.voiceDefault;
  const lookText = style.trim() || f.lookDefault;
  const examples = [f.ex1, f.ex2, f.ex3];

  // The newest queue job is the one just made; without a queue only "started" is known.
  const jobStatus = backend === "queue" && jobs && jobs.length > 0 ? jobs[0].status : null;

  const choice = (id: Choice, label: string, value: string, panel: React.ReactNode) => {
    const on = open === id;
    return (
      <div className="fl-choice-wrap" data-open={on ? "true" : undefined}>
        <button
          type="button"
          className="fl-choice"
          aria-expanded={on}
          aria-controls={`fl-panel-${id}`}
          onClick={() => setOpen(on ? null : id)}
        >
          <span className="fl-choice-text">
            <span className="fl-choice-label">{label}</span>
            <span className="fl-choice-value">{value}</span>
          </span>
          <ChevronDown aria-hidden className="fl-choice-chevron" />
        </button>
        {on && (
          <div id={`fl-panel-${id}`} className="fl-panel">
            {panel}
          </div>
        )}
      </div>
    );
  };

  const radio = (checked: boolean, onPick: () => void, label: React.ReactNode, sub?: React.ReactNode) => (
    <button type="button" role="radio" aria-checked={checked} onClick={onPick} className="fl-option">
      <span aria-hidden className="fl-option-mark">
        {checked && <Check className="size-3.5" strokeWidth={3} />}
      </span>
      <span className="fl-option-text">
        <span>{label}</span>
        {sub && <span className="fl-option-sub">{sub}</span>}
      </span>
    </button>
  );

  return (
    <div id="run" className="fl scroll-mt-4">
      {initial && <p className="fl-note">{t.create.prefilled}</p>}
      {dna && <ChannelDnaHint href={dna.href} />}

      {blocked && (
        <p className="fl-card fl-warn" role="status">
          {!channelId ? t.create.pickChannel : !githubConfigured ? t.create.notConfigured : t.create.needsAdmin}
        </p>
      )}

      {/* 1 — what is it about: one field, three ways to start. */}
      <section className="fl-card" aria-labelledby="fl-topic-title">
        <h2 id="fl-topic-title" className="fl-q">
          <label htmlFor="run-brief">{f.topicTitle}</label>
        </h2>
        <textarea
          id="run-brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          maxLength={300}
          autoFocus={initial !== null}
          placeholder={t.create.placeholder}
          aria-describedby="fl-topic-hint"
          className="fl-topic"
        />
        <p id="fl-topic-hint" className="fl-hint">
          {f.topicHint}
        </p>
        <div className="fl-try" role="group" aria-label={f.tryOne}>
          <span className="fl-try-label">{f.tryOne}</span>
          {examples.map((ex) => (
            <button key={ex} type="button" className="ns-chip" onClick={() => setBrief(ex)}>
              {ex}
            </button>
          ))}
        </div>
      </section>

      {/* 2 — look, length, voice: three big cards, each already set to something sensible. */}
      <section className="fl-card" aria-labelledby="fl-look-title">
        <h2 id="fl-look-title" className="fl-q">
          {f.lookTitle}
        </h2>
        <div className="fl-choices">
          {choice(
            "length",
            f.lengthLabel,
            lengthText,
            <div role="radiogroup" aria-label={t.agents.runDurationLabel} className="fl-options">
              {lengths.map((l) => (
                <span key={l.value || "default"}>{radio(duration === l.value, () => setDuration(l.value), l.label)}</span>
              ))}
            </div>,
          )}
          {choice(
            "voice",
            f.voiceLabel,
            voiceText,
            <>
              <div role="radiogroup" aria-label={t.create.voicePick} className="fl-options">
                {radio(voice === "", () => setVoice(""), f.voiceDefault)}
                {VOICES.map((v) => (
                  <span key={v.id}>{radio(voice === v.id, () => setVoice(v.id), v.name, styleOf(v))}</span>
                ))}
                {radio(voice === CUSTOM_VOICE, () => setVoice(CUSTOM_VOICE), f.voiceOwn)}
              </div>
              {voice === CUSTOM_VOICE && (
                <label className="fl-field">
                  <span>{t.create.voiceCustomId}</span>
                  <input
                    value={customVoice}
                    onChange={(e) => setCustomVoice(e.target.value)}
                    placeholder="pNInz6obpgDQGcFmaJgB"
                    maxLength={40}
                    spellCheck={false}
                    aria-invalid={customVoiceInvalid}
                    className={selectClass + " font-mono"}
                    dir="ltr"
                  />
                  {customVoiceInvalid && <span className="text-[var(--color-warn)]">{t.create.voiceCustomInvalid}</span>}
                </label>
              )}
              <VoicePreviewButton voiceId={voiceId || agentConfig?.elevenlabs_voice_id || ""} channelId={channelId} />
            </>,
          )}
          {choice(
            "look",
            f.lookLabel,
            lookText,
            <>
              <div role="radiogroup" aria-label={f.lookLabel} className="fl-options">
                {radio(style.trim() === "", () => setStyle(""), f.lookDefault)}
              </div>
              <label className="fl-field">
                <span>{f.lookField}</span>
                <input
                  value={style}
                  onChange={(e) => setStyle(e.target.value)}
                  placeholder={f.lookPlaceholder}
                  maxLength={300}
                  className={selectClass}
                />
              </label>
            </>,
          )}
        </div>

        <details className="fl-more">
          <summary>{f.more}</summary>
          <div className="fl-more-body">
            <label className="fl-field">
              <span>{t.agents.runLangLabel}</span>
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

            {connectedTargets.length > 0 && (
              <label className="fl-field">
                <span>{t.publish.makingFor}</span>
                <select value={target} onChange={(e) => setTarget(e.target.value)} className={selectClass} aria-describedby="making-for-hint">
                  <option value="">{t.publish.makingForNone}</option>
                  {connectedTargets.map((a) => (
                    <option key={`${a.platform}:${a.id}`} value={`${a.platform}:${a.id}`}>
                      {PLATFORM_LABEL[a.platform]} · {a.name}
                    </option>
                  ))}
                </select>
                <span id="making-for-hint" className="fl-hint">
                  {t.publish.makingForHint}
                </span>
              </label>
            )}

            {/* Provider-level routing is the platform operator's: a customer's run uses the
                channel's own setup, and customer screens never name a provider. */}
            {operator && (
              <>
                <label className="fl-field">
                  <span>{t.create.videoModel}</span>
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
                <label className="fl-field">
                  <span>{t.create.imageModel}</span>
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
                <label className="fl-field">
                  <span>{t.create.voiceModel}</span>
                  <select value={ttsModel} onChange={(e) => setTtsModel(e.target.value)} className={selectClass}>
                    <option value="">{t.create.optDefault}</option>
                    {TTS_MODELS.map((m) => (
                      <option key={m} value={m}>
                        {TTS_MODEL_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-[var(--color-muted)]">{t.create.models}:</span>
                  <span className="font-mono text-[var(--color-muted)]">
                    {t.create.voice}: {voiceChip}
                  </span>
                  <Link href={path("/agents")} className="tap-link text-[var(--color-primary)] hover:underline">
                    {t.create.editVoice}
                  </Link>
                  <Link href={path("/providers")} className="tap-link text-[var(--color-primary)] hover:underline">
                    {t.create.editProviders}
                  </Link>
                </div>
              </>
            )}
          </div>
        </details>
      </section>

      {/* 3 — the price, said plainly before the button; 4 — the one button. */}
      <section className="fl-card" aria-labelledby="fl-price-title">
        <h2 id="fl-price-title" className="fl-q">
          {f.priceTitle}
        </h2>
        <CreditEstimateLine variant="card" channelId={channelId} durationS={Number(duration) > 0 ? Number(duration) : null} />
        <p className="fl-hint">{f.holdNote}</p>

        {/* Create — asks once, because it spends money and can produce a video. */}
        {phase === "confirm" ? (
          <div className="fl-actions">
            <button type="button" onClick={create} className="studio-cta fl-go">
              {t.create.confirm}
            </button>
            <button type="button" onClick={() => setPhase("idle")} className="btn-quiet fl-cancel">
              {t.create.cancel}
            </button>
          </div>
        ) : (
          <div className="fl-actions">
            <button
              type="button"
              disabled={blocked || phase === "starting" || phase === "queued"}
              onClick={() => setPhase("confirm")}
              className="studio-cta fl-go"
            >
              {phase === "starting" ? t.create.starting : t.create.create}
            </button>
          </div>
        )}
        <p className="fl-status" aria-live="polite">
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
          ) : null}
        </p>
      </section>

      {/* Live progress, in plain words; every step stays one tap away. */}
      {phase === "queued" && (
        <section className="fl-card" aria-labelledby="fl-watch-title">
          <h2 id="fl-watch-title" className="fl-q">
            {f.watchTitle}
          </h2>
          <p className="fl-watch">
            <StatusLamp
              tone={jobStatus === "succeeded" ? "ok" : jobStatus === "failed" ? "fail" : jobStatus === "cancelled" ? "idle" : "run"}
              live={jobStatus === null || jobStatus === "queued" || jobStatus === "running"}
              label={jobStatus ? f.status[jobStatus] : f.started}
            />
          </p>
          <details className="fl-more">
            <summary>{f.details}</summary>
            <div className="fl-more-body">
              <p className="fl-hint">{backend === "queue" ? t.create.progressHintQueue : t.create.progressHint}</p>
              {backend === "queue" && jobs && jobs.length > 0 && (
                <ol className="flex flex-col gap-1.5" aria-label={t.create.queueTitle}>
                  {jobs.slice(0, 3).map((j) => (
                    <li key={j.id} className="flex flex-wrap items-center gap-3 text-sm">
                      <span className="tnum shrink-0 text-[var(--color-muted)]">
                        {t.create.queueJob} #{j.id}
                      </span>
                      <span className="shrink-0">{t.create.queueStatus[j.status]}</span>
                      {j.attempts > 1 && (
                        <span className="tnum text-[var(--color-muted)]">
                          {t.create.queueAttempt} {j.attempts}
                        </span>
                      )}
                      {j.error && (
                        <span className="min-w-0 flex-1 truncate text-[var(--color-fail)]" title={j.error}>
                          {j.error.split("\n")[0]}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {events.length === 0 ? (
                <p className="tnum text-sm text-[var(--color-muted)]">{t.create.progressWaiting}</p>
              ) : (
                <ol className="flex flex-col gap-1.5">
                  {events.slice(0, 24).map((e, i) => (
                    <li key={`${e.ts}-${i}`} className="flex items-center gap-3 text-sm">
                      <span className="tnum w-16 shrink-0 text-[var(--color-muted)]">{(e.ts ?? "").slice(11, 19)}</span>
                      <span className="shrink-0 text-[var(--color-primary)]">{e.agent ?? "system"}</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]">{e.event}</span>
                      {e.status && <span className="shrink-0 text-[var(--color-muted)]">{e.status}</span>}
                    </li>
                  ))}
                </ol>
              )}
              {operator && (
                <Link href={path("/jobs")} className="text-sm text-[var(--color-primary)] hover:underline">
                  {t.create.openJobs}
                </Link>
              )}
            </div>
          </details>
        </section>
      )}
    </div>
  );
}
