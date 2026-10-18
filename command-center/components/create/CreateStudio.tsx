"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import type { ChannelAgentConfig } from "@/lib/types";
import type { QueueJob, RunBackend } from "@/lib/runBackend";
import { AttemptsFullError, createAttempt } from "@/lib/create-attempt";
import { formatCredits } from "@/lib/credits";
import { fmt } from "@/lib/i18n";
import { readRunAnswer, unsureRunAnswer } from "@/lib/run-answer";
import { clearDraft, draftStore, readDraft, writeDraft, type DraftScope } from "@/lib/create-draft";
import { ExtraOffLink } from "@/components/usage/ExtraOffLink";
import { CreditEstimateLine, type PriceReport } from "@/components/credits/CreditEstimateLine";
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
  userId = "",
  orgId = null,
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
  /** The signed-in user's id from the server page (getUser()). It makes the idempotency key survive a reload of
   *  this tab; empty (not known) = the key stays in memory only. Never shown, and never stored in the clear. */
  userId?: string;
  /** The open organization when the page knows it: part of what the stored key is for. */
  orgId?: string | null;
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
  // The unfinished-draft memory (lib/create-draft.ts) needs to know whose form this is: user + organization + channel.
  // Without all three nothing is kept or restored.
  // What the form starts with when no draft applies: Discard goes back to exactly this.
  const baseline = {
    topic: initial?.brief ?? "",
    duration: initial?.duration || dna?.duration || "",
    voice: dna?.voice ?? "",
    look: "",
  };
  const baselineRef = useRef(baseline);
  const seenScope = useRef<string | null>(null);
  const draftScope: DraftScope | null = userId && orgId && channelId ? { userId, orgId, channelId } : null;
  const scopeKey = draftScope ? `${draftScope.userId}|${draftScope.orgId}|${draftScope.channelId}` : "";
  const scopeRef = useRef(draftScope);
  scopeRef.current = draftScope;
  // False until the stored draft (if any) has been looked at, so the first save cannot overwrite it with the empty form.
  const [draftChecked, setDraftChecked] = useState(false);
  const [restored, setRestored] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  // The one choice card that is open (length, voice or look): the rest stay a single line each.
  const [open, setOpen] = useState<Choice | null>(null);
  // Why the run did not start, in words that also say whether credits were taken or held (lib/run-answer.ts).
  const [creditError, setCreditError] = useState<string | null>(null);
  const [extraOff, setExtraOff] = useState(false);
  const [events, setEvents] = useState<Ev[]>([]);
  // Queue mode only: this channel's latest render_jobs, so a job still waiting
  // for the worker is visible as waiting, not as a run that never started.
  const [jobs, setJobs] = useState<QueueJob[] | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // What the price card is saying right now. A figure on screen is sent as the run's ceiling (`max_credits`);
  // while it is loading or unreadable the confirm waits, so a price nobody has seen is never confirmed.
  const [price, setPrice] = useState<PriceReport>({ state: "loading" });
  const shownPrice = price.state === "priced" ? price.credits : null;
  const priceHold = !!channelId && (price.state === "loading" || price.state === "failed");
  // Bumped to read the price again (the Retry of an unreadable price, or a run refused as `price_changed`).
  const [priceNonce, setPriceNonce] = useState(0);
  // One idempotency key per intent (lib/create-attempt.ts), per channel, kept for a retry of the same inputs.
  // The channel is part of what the key stands for (its signature), so another channel never gets this key.
  const [attempt] = useState(() => createAttempt());
  // A press already on its way: a second click in the same tick must not post again.
  const sending = useRef(false);
  // The server said this exact intent had already been started: shown as started, nothing new was held.
  const [replayed, setReplayed] = useState(false);
  // Bumped when an answer changes what the attempt knows (settled, unsure, blocked), so the form re-reads it.
  const [tick, setTick] = useState(0);
  // The error on screen is the "credits are held" one: it goes away when the input changes (a new intent).
  const [errorBlocked, setErrorBlocked] = useState(false);
  // After the confirm press the button that was focused goes away; the result (started, or why not)
  // is read from here, so keyboard and screen-reader focus never drops to the page.
  const statusRef = useRef<HTMLParagraphElement>(null);

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

  useEffect(() => {
    if (phase === "queued" || phase === "error") statusRef.current?.focus();
  }, [phase]);

  // Restore this tab's unfinished draft: after mount (sessionStorage does not exist on the server), only for the
  // same user + organization + channel, and never over a hand-off from Home's query, which is what the person just asked for.
  // Anything stored for another scope is removed by readDraft.
  useEffect(() => {
    const sc = scopeRef.current;
    setDraftChecked(false);
    setRestored(false);
    // The same form kept mounted while the person moves to another channel or organization: what is typed
    // belongs to the one they left, so it starts over (and is never saved under the new scope).
    baselineRef.current = baseline;
    if (seenScope.current !== null && seenScope.current !== scopeKey) {
      setBrief(baseline.topic);
      setDuration(baseline.duration);
      setVoice(baseline.voice);
      setStyle(baseline.look);
      setPhase((p) => (p === "confirm" || p === "error" ? "idle" : p));
    }
    seenScope.current = scopeKey;
    if (!sc) return;
    const draft = readDraft(draftStore(), sc);
    if (draft && !initial) {
      setBrief(draft.topic);
      setDuration(draft.duration);
      setVoice(draft.voice);
      setStyle(draft.look);
      setRestored(true);
    }
    setDraftChecked(true);
    // initial is a mount-time prop; the scope key is what changes who the draft belongs to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // Keep the draft as it is typed (debounced). Equal to the starting form means nothing to keep. A started
  // run clears it for good (phase queued), so it is not written back.
  useEffect(() => {
    const sc = scopeRef.current;
    if (!sc || !draftChecked || phase === "queued") return;
    const mine = { topic: brief, duration, voice: voice === CUSTOM_VOICE ? baselineRef.current.voice : voice, look: style };
    const b = baselineRef.current;
    const untouched = mine.topic.trim() === b.topic.trim() && mine.duration === b.duration && mine.voice === b.voice && mine.look.trim() === b.look;
    const timer = setTimeout(() => {
      // A form that started from Home's query leaves the stored draft alone until the person edits or discards:
      // that link is not a decision to throw their earlier text away.
      if (untouched) {
        if (!initial) clearDraft(draftStore(), sc);
      } else writeDraft(draftStore(), sc, mine);
    }, 400);
    return () => clearTimeout(timer);
    // initial is a mount-time prop (whether the form began from Home's query); it never changes who the draft is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief, duration, voice, style, phase, draftChecked, scopeKey]);

  function discardDraft() {
    const sc = scopeRef.current;
    if (sc) clearDraft(draftStore(), sc);
    const b = baselineRef.current;
    setBrief(b.topic);
    setDuration(b.duration);
    setVoice(b.voice);
    setStyle(b.look);
    setRestored(false);
    setPhase((p) => (p === "confirm" || p === "error" ? "idle" : p));
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

  // What the person decided, as the run's body (without the key and the price). Its JSON is the intent's signature.
  function runFields() {
    const topic = brief.trim().slice(0, 300);
    const dur = Number(duration);
    return {
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
    };
  }

  // This same intent waits for credits that are still held, or the scope is full of such intents (lib/create-attempt.ts).
  const isStopped = () => {
    const k = attempt.status(JSON.stringify(runFields()), scope);
    return k.blocked !== null || k.full;
  };

  async function create() {
    // A start that definitely failed while its credits are still held: this same intent is not sent again (lib/run-answer.ts).
    if (!channelId || sending.current || priceHold || isStopped()) return;
    sending.current = true;
    setPhase("starting");
    setCreditError(null);
    setExtraOff(false);
    setReplayed(false);
    const fields = runFields();
    const sig = JSON.stringify(fields);
    // One intent = one key: channel + topic + options. The price is NOT part of it (max_credits carries it), so a
    // double press or a retry keeps the key even when the price moved; a changed topic or option is a new video
    // and gets a new key. The key expires after 30 minutes. With a user id it is also kept in this tab's
    // sessionStorage (a hash of the intent, never the topic), so a reload after a lost answer reuses it and cannot
    // hold twice; without one it is in memory only (lib/create-attempt.ts).
    let idempotency_key: string;
    try {
      idempotency_key = attempt.keyFor(sig, scope);
    } catch (e) {
      // keyFor and status() read the same state, so this should not happen; if they ever disagree the form must not hang
      // in "starting". Nothing was sent, so no credits were taken or held.
      sending.current = false;
      setTick((n) => n + 1);
      const message = e instanceof AttemptsFullError ? t.create.flow.startTooMany : `${t.agents.runFailed} ${t.create.flow.notTaken}`;
      setCreditError(message);
      setExtraOff(false);
      setErrorBlocked(false);
      setPhase("error");
      return;
    }
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...fields,
          idempotency_key,
          // The price the card showed: a dearer estimate at the server is refused (409 price_changed), nothing held.
          ...(shownPrice !== null ? { max_credits: shownPrice } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      const answer = readRunAnswer(res, data, t, locale, attempt.isUnsure());
      // The answer is about THIS key. If the person changed the intent while it was on its way, what it taught
      // (settled, unsure, blocked) is recorded against that key only, and nothing is said about the new intent.
      const stale = intentRef.current !== sig;
      if (answer.outcome !== "failed") {
        attempt.settle(idempotency_key);
        setTick((n) => n + 1);
        // Started (or already started) is true of the intent that was sent. If the person has since changed the form,
        // it is not said about, and does not disable, what is on screen now (and their newer text stays as a draft).
        if (stale) {
          setPhase("idle");
          return;
        }
        // A started run (a replay of one included) ends the draft: it is not offered back for a second video.
        if (draftScope) clearDraft(draftStore(), draftScope);
        setReplayed(answer.outcome === "replay");
        setPhase("queued");
        return;
      }
      if (answer.settled) attempt.settle(idempotency_key);
      if (answer.unsure) attempt.markUnsure(idempotency_key);
      if (answer.blockedCredits !== null) attempt.markBlocked(answer.blockedCredits, idempotency_key);
      setTick((n) => n + 1);
      if (stale) {
        setPhase("idle");
        return;
      }
      if (answer.priceChanged) setPriceNonce((n) => n + 1);
      setCreditError(answer.message);
      setExtraOff(answer.extraOff);
      setErrorBlocked(answer.blockedCredits !== null);
      setPhase("error");
    } catch {
      // Unknown whether it arrived: the key is kept (and remembered as unsure), so trying again is safe.
      attempt.markUnsure(idempotency_key);
      setTick((n) => n + 1);
      if (intentRef.current !== sig) {
        setPhase("idle");
        return;
      }
      setCreditError(unsureRunAnswer(t).message);
      setErrorBlocked(false);
      setPhase("error");
    } finally {
      sending.current = false;
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter creates; Shift+Enter is a newline (a brief can be multi-line).
    if (e.key === "Enter" && !e.shiftKey && !blocked && phase !== "starting" && !stopped) {
      e.preventDefault();
      setPhase("confirm");
    }
  }

  const voiceId = voice === CUSTOM_VOICE ? customVoice.trim() : voice;
  // Who this attempt belongs to (for keeping its key across a reload) and what this intent is right now.
  const scope = userId && channelId ? { userId, orgId, channelId } : undefined;
  const intentSig = JSON.stringify(runFields());
  const intentRef = useRef(intentSig);
  intentRef.current = intentSig;
  // What this attempt knows about this intent (credits still held after a start that definitely failed, unsure, or
  // the scope full of such intents). It lives in sessionStorage, which the server render cannot see, so it is read
  // AFTER mount, never during render: the server and the first client render both show "not read yet", and the
  // hydration matches. Until it has been read for THIS intent, nothing can be sent: Make is disabled (a brief,
  // honest wait), and the notice appears one tick after mount.
  const statusStamp = `${userId}\0${orgId ?? ""}\0${channelId ?? ""}\0${intentSig}`;
  const [read, setRead] = useState<{ stamp: string; status: ReturnType<typeof attempt.status> } | null>(null);
  useEffect(() => {
    setRead({ stamp: statusStamp, status: channelId ? attempt.status(intentSig, scope) : { unsure: false, blocked: null, full: false } });
    // scope is derived from the stamp's parts; tick bumps when an answer changes what is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, statusStamp, tick]);
  const statusRead = !channelId || read?.stamp === statusStamp;
  const known = read?.stamp === statusStamp ? read.status : { unsure: false, blocked: null, full: false };
  const heldBlock = known.blocked;
  // Too many earlier requests are still waiting for their credits: a NEW intent is refused (no key, no request).
  const tooMany = known.full;
  const stopped = !statusRead || heldBlock !== null || tooMany;
  const heldText = tooMany ? t.create.flow.startTooMany : heldBlock === null ? null : heldBlock > 0 ? fmt(t.create.flow.startFailedHeld, { n: formatCredits(heldBlock, locale) }) : t.create.flow.startFailedHeldShort;
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
      {restored && phase !== "queued" && (
        <p className="fl-note" role="status" data-testid="draft-restored">
          {f.draftRestored}{" "}
          <button type="button" className="tap-link text-[var(--color-primary)] underline" onClick={discardDraft}>
            {f.draftDiscard}
          </button>
        </p>
      )}
      {dna && <ChannelDnaHint href={dna.href} />}

      {blocked && (
        <p className="fl-card fl-warn" role="status">
          {!channelId
            ? t.create.pickChannel
            : !githubConfigured
              ? // The environment variable names are the operator's; a customer reads a plain sentence.
                operator
                ? t.create.notConfigured
                : f.unavailable
              : t.create.needsAdmin}
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
        <CreditEstimateLine
          variant="card"
          showNotEnforced={operator}
          channelId={channelId}
          durationS={Number(duration) > 0 ? Number(duration) : null}
          onPrice={setPrice}
          refreshKey={priceNonce}
        />
        <p className="fl-hint">{f.holdNote}</p>

        {/* Create — asks once, because it spends money and can produce a video. The confirm is its own
            button (never the same element as "Make"), so a quick second tap cannot confirm by accident; it takes
            focus, stays focusable (aria-disabled, not disabled) while it starts, and says it is starting. */}
        <p className="sr-only" aria-live="polite">
          {phase === "confirm" ? f.confirmAnnounce : ""}
        </p>
        {phase === "confirm" || phase === "starting" ? (
          <div className="fl-actions">
            <button
              key="confirm"
              type="button"
              autoFocus
              // Retry (price unreadable) is a live button; only "starting" and "checking the price" are disabled.
              aria-disabled={phase === "starting" || (priceHold && price.state === "loading") || stopped}
              data-price-hold={priceHold ? price.state : undefined}
              onClick={() => {
                // Unreadable: the button is the retry. Loading: nothing to do until the figure arrives.
                if (stopped) return;
                if (phase === "confirm" && price.state === "failed") setPriceNonce((n) => n + 1);
                else if (phase === "confirm") void create();
              }}
              className="studio-cta fl-go"
            >
              {phase === "starting"
                ? t.create.starting
                : priceHold
                  ? price.state === "failed"
                    ? t.common.retry
                    : t.credits.priceChecking
                  : t.create.confirm}
            </button>
            {phase === "confirm" && (
              <button type="button" onClick={() => setPhase("idle")} className="btn-quiet fl-cancel">
                {t.create.cancel}
              </button>
            )}
          </div>
        ) : (
          <div className="fl-actions">
            <button
              key="make"
              type="button"
              disabled={blocked || phase === "queued" || stopped}
              onClick={() => setPhase("confirm")}
              className="studio-cta fl-go"
            >
              {t.create.create}
            </button>
          </div>
        )}
        <p className="fl-status" ref={statusRef} tabIndex={-1} aria-live="polite">
          {phase === "queued" ? (
            <span className="text-[var(--color-ok)]">{replayed ? f.alreadySent : t.create.queued}</span>
          ) : heldText !== null ? (
            // A start that definitely failed with its credits still held: said again after a reload, and for as long as
            // this same intent is the one on screen.
            <span className="text-[var(--color-fail)]">{heldText}</span>
          ) : phase === "error" && !errorBlocked ? (
            <span className="text-[var(--color-fail)]">
              {creditError ?? t.agents.runFailed}
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
          <p className="fl-hint">{f.notifyHint}</p>
          {/* A returning person's next step, without waiting here: see the videos, or start another. Make another is a
              plain link on purpose: a full load is what clears this form and starts a new attempt. */}
          <div className="fl-actions">
            <Link href={path("/videos")} className="btn-quiet">
              {f.seeVideos}
            </Link>
            <a href={path("/create")} className="btn-quiet">
              {f.makeAnother}
            </a>
          </div>
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
                      {/* A failure is one plain sentence for everyone (no vendor, no remedy). The operator's
                          own log header and tail stay available to the operator only. */}
                      {j.status === "failed" && (
                        <span className="min-w-0 flex-1 text-[var(--color-fail)]">
                          {t.create.jobError[j.errorCode ?? "unknown"]}
                          {j.creditsReturned === true && <> {t.create.creditsReturned}</>}
                        </span>
                      )}
                      {operator && j.error && (
                        <span className="min-w-0 flex-1 truncate text-[var(--color-muted)]" title={j.error}>
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
