"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { fmt } from "@/lib/i18n";
import type { ChannelRow } from "@/lib/types";
import { isValidChannelId, slugifyChannelId, voiceOwners } from "@/lib/channels";

/**
 * Guided channel creation.
 *
 * Three things are deliberate:
 *
 * 1. **The channel is created PAUSED**, always, with no option here to create
 *    it active. Creating a channel must never start publishing; activating is a
 *    separate, explicit act on the Channels page once YouTube is connected.
 * 2. **Keys are forwarded, not stored.** The API keys step writes straight into
 *    the bot repository's GitHub Actions secrets through a server route: the
 *    value is sealed to the repo's public key, PUT to GitHub, and dropped. It
 *    is never part of the Supabase insert, never in an event, never logged, and
 *    the field is cleared the moment GitHub accepts it. Nothing about a key is
 *    readable from this dashboard afterwards — not even its length.
 * 3. **The channel cannot be created until YouTube confirms it.** The Data API
 *    key the operator just typed is used for one read of channels.list, which
 *    proves both halves at once: the key works, and the id or handle names a
 *    real channel. The avatar and counts that come back are public facts, and
 *    they are what tells the operator they opened the right channel.
 *
 *    This used to be optional, and that is how a channel came to exist whose
 *    entire contents were a typed name, a typed niche and a guessed voice id.
 *    Confirmation is now the gate: no proof, no row. The same rule is enforced
 *    in the database (migration 0005) and in the scheduler, because a rule that
 *    lives only in a form is a rule until someone uses the API.
 * 4. **Each channel gets its own ElevenLabs voice.** The voice is picked from
 *    the account's real voice list rather than typed, and a voice another
 *    channel already uses cannot be chosen — two channels in one voice sound
 *    like one channel with two names.
 *
 * The write goes to `channels` only, via the authenticated insert policy added
 * by migration 0001. No data table is writable from here.
 */

// The voice step sits *after* keys on purpose: picking from the account's real
// voice list needs the ElevenLabs key, and asking for a voice id before the key
// is what made a free-text field the only possible design.
const STEPS = [
  "identity",
  "niche",
  "content",
  "visual",
  "schedule",
  "keys",
  "voice",
  "connect",
  "activate",
] as const;

type Step = (typeof STEPS)[number];

type Voice = {
  voiceId: string;
  name: string;
  category: string;
  previewUrl: string;
  labels: string;
};

type ChannelInfo = {
  channelId: string;
  title: string;
  customUrl: string;
  description: string;
  country: string;
  publishedAt: string;
  thumbnail: string;
  subscribers: string | null;
  videos: string | null;
  views: string | null;
};

/**
 * `orgId` is the organization the new channel belongs to — the current one,
 * resolved on the server. Null before migration 0018, when the column does not
 * exist and must not be sent. `initialNiche` / `initialLanguage` are what the
 * person answered on /welcome: a starting value for the form, nothing more.
 */
export function AddChannelWizard({
  orgId = null,
  initialNiche = null,
  initialLanguage = null,
}: { orgId?: string | null; initialNiche?: string | null; initialLanguage?: string | null } = {}) {
  const { t } = useI18n();
  const router = useRouter();
  const path = useChannelPath();

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [channelId, setChannelId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [niche, setNiche] = useState(initialNiche ?? "");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [nicheRules, setNicheRules] = useState("");
  const [language, setLanguage] = useState(initialLanguage ?? "English");
  const [duration, setDuration] = useState(300);
  const [ttsProvider, setTtsProvider] = useState("edge");
  const [edgeVoice, setEdgeVoice] = useState("en-US-ChristopherNeural");
  const [elevenVoice, setElevenVoice] = useState("");
  const [visualStyle, setVisualStyle] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [hour, setHour] = useState<number | "">(15);
  const [scheduleEnabled, setScheduleEnabled] = useState(true);
  const [credentialRef, setCredentialRef] = useState("");
  const [youtubeChannelId, setYoutubeChannelId] = useState("");
  const [handle, setHandle] = useState("");

  // Secret values. These live in component state for as long as it takes to
  // hand them to GitHub, and are cleared the moment GitHub accepts them.
  const [geminiKey, setGeminiKey] = useState("");
  const [pexelsKey, setPexelsKey] = useState("");
  const [elevenKey, setElevenKey] = useState("");
  const [ytDataKey, setYtDataKey] = useState("");
  const [clientSecretJson, setClientSecretJson] = useState("");
  const [tokenJson, setTokenJson] = useState("");

  const [ghRepo, setGhRepo] = useState<string | null>(null);
  const [ghConfigured, setGhConfigured] = useState<boolean | null>(null);

  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [info, setInfo] = useState<ChannelInfo | null>(null);

  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [voicesBusy, setVoicesBusy] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  // voice id -> the channel already narrating in it. Read from the registry so
  // the picker can refuse a collision instead of the database doing it later.
  const [takenVoices, setTakenVoices] = useState<Record<string, string>>({});

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushed, setPushed] = useState<{ name: string; result: string }[] | null>(null);
  const [created, setCreated] = useState(false);

  const effectiveId = idTouched ? channelId : slugifyChannelId(name);
  const idValid = isValidChannelId(effectiveId);
  const secret = useMemo(() => {
    const key = credentialRef || effectiveId || "channel";
    return "CHRONOS_YT_TOKEN_" + key.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }, [credentialRef, effectiveId]);

  // Ask the server whether forwarding is wired up at all, so the keys step can
  // say what is missing instead of failing at the last click.
  useEffect(() => {
    let alive = true;
    fetch("/api/setup/secrets")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        setGhConfigured(Boolean(d.configured));
        setGhRepo(d.repo || null);
      })
      .catch(() => {
        if (alive) setGhConfigured(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Which ElevenLabs voices are spoken for. Read once: the picker greys them
  // out, so a collision is impossible to select rather than rejected on save.
  useEffect(() => {
    let alive = true;
    const supabase = createClient();
    if (!supabase) return;
    supabase
      .from("channels")
      .select("channel_id,name,agent_config")
      .then(({ data }) => {
        if (!alive || !data) return;
        setTakenVoices(voiceOwners(data as ChannelRow[]));
      });
    return () => {
      alive = false;
    };
  }, []);

  const current: Step = STEPS[step];
  const voiceTakenBy = elevenVoice ? takenVoices[elevenVoice] : undefined;
  // An ElevenLabs channel needs a voice that exists and that nobody else uses.
  const voiceReady =
    ttsProvider !== "elevenlabs" || (Boolean(elevenVoice) && !voiceTakenBy);
  // Nothing past "connect" is reachable without proof, so the Create button at
  // the end can never be pressed on an unconfirmed channel.
  const canAdvance =
    current === "identity"
      ? Boolean(name.trim()) && idValid
      : current === "voice"
        ? voiceReady
        : current === "connect"
          ? Boolean(info)
          : true;

  /** The secrets the operator actually filled in, keyed by their GitHub name. */
  function pendingSecrets(): Record<string, string> {
    const out: Record<string, string> = {};
    if (geminiKey.trim()) out.GEMINI_API_KEY = geminiKey.trim();
    if (pexelsKey.trim()) out.PEXELS_API_KEY = pexelsKey.trim();
    if (elevenKey.trim()) out.ELEVENLABS_API_KEY = elevenKey.trim();
    if (ytDataKey.trim()) out.YOUTUBE_DATA_API_KEY = ytDataKey.trim();
    if (clientSecretJson.trim()) out.YOUTUBE_CLIENT_SECRET_JSON = clientSecretJson.trim();
    if (tokenJson.trim()) out[secret] = tokenJson.trim();
    const yt = info?.channelId || youtubeChannelId.trim();
    if (yt) out.YOUTUBE_CHANNEL_ID = yt;
    return out;
  }

  async function loadVoices() {
    setVoicesBusy(true);
    setVoicesError(null);
    try {
      const res = await fetch("/api/setup/voices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: elevenKey.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setVoicesError(
          data.error === "key_rejected"
            ? fmt(t.channels.voiceKeyRejected, { reason: data.reason || "401" })
            : data.error === "missing_key"
              ? t.channels.voiceNeedsKey
              : t.channels.voiceFailed,
        );
        return;
      }
      setVoices(data.voices as Voice[]);
    } catch {
      setVoicesError(t.channels.voiceFailed);
    } finally {
      setVoicesBusy(false);
    }
  }

  async function verify() {
    setVerifyBusy(true);
    setVerifyError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/setup/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: ytDataKey.trim(),
          channelId: youtubeChannelId.trim(),
          handle: handle.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setVerifyError(
          data.error === "key_rejected"
            ? t.channels.verifyKeyRejected
            : data.error === "channel_not_found"
              ? t.channels.verifyNotFound
              : data.error === "missing_key"
                ? t.channels.verifyNeedsKey
                : t.channels.verifyFailed,
        );
        return;
      }
      setInfo(data as ChannelInfo);
      // The confirmed id is authoritative — a handle lookup fills the field in.
      if (data.channelId) setYoutubeChannelId(data.channelId);
    } catch {
      setVerifyError(t.channels.verifyFailed);
    } finally {
      setVerifyBusy(false);
    }
  }

  async function create() {
    const supabase = createClient();
    if (!supabase) return;

    // The last line of defence in the browser. The button is already disabled
    // without proof and the "connect" step will not advance without it, but a
    // channel nobody confirmed must not be creatable by any path from here.
    // The database refuses to ACTIVATE such a row and the scheduler refuses to
    // run it, so the three checks agree rather than one of them being load-bearing.
    if (!info) {
      setError(t.channels.verifyRequired);
      return;
    }
    if (ttsProvider === "elevenlabs" && !voiceReady) {
      setError(
        voiceTakenBy
          ? fmt(t.channels.voiceTakenWarn, { channel: voiceTakenBy })
          : t.channels.voiceRequired,
      );
      return;
    }

    setBusy(true);
    setError(null);

    // 1. Hand the keys to GitHub first. If this fails the channel is not
    //    created, so a retry does not leave a duplicate row behind.
    const secrets = pendingSecrets();
    if (Object.keys(secrets).length > 0 && ghConfigured) {
      setStage(t.channels.pushingSecrets);
      try {
        const res = await fetch("/api/setup/secrets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secrets }),
        });
        const data = await res.json();
        if (!res.ok) {
          setBusy(false);
          setStage(null);
          setError(
            data.error === "github_unauthorized"
              ? t.channels.secretsUnauthorized
              : t.channels.secretsFailed,
          );
          return;
        }
        setPushed(data.written ?? []);
        // Accepted by GitHub — drop every value from the browser.
        setGeminiKey("");
        setPexelsKey("");
        setElevenKey("");
        setYtDataKey("");
        setClientSecretJson("");
        setTokenJson("");
      } catch {
        setBusy(false);
        setStage(null);
        setError(t.channels.secretsFailed);
        return;
      }
    }

    // 2. Create the channel row — configuration only, no credential material.
    setStage(t.channels.creating);
    const now = new Date().toISOString();
    const { error: err } = await supabase.from("channels").insert({
      channel_id: effectiveId,
      // The org it is created in; RLS requires editor there (migration 0018).
      ...(orgId ? { org_id: orgId } : {}),
      name: name.trim(),
      niche: niche.trim(),
      // Not negotiable: a new channel does not publish until a human says so.
      status: "PAUSED",
      agent_config: {
        language,
        target_duration_seconds: duration,
        tts_provider: ttsProvider,
        edge_tts_voice: edgeVoice,
        ...(elevenVoice ? { elevenlabs_voice_id: elevenVoice } : {}),
        ...(systemPrompt.trim() ? { system_prompt: systemPrompt.trim() } : {}),
        ...(nicheRules.trim() ? { niche_rules: nicheRules.trim() } : {}),
        ...(visualStyle.trim() ? { visual_style_prompt: visualStyle.trim() } : {}),
        // Always sent, even when empty: an explicit [] means "watch nobody",
        // which is not the same as inheriting the process-wide env var.
        competitor_channel_ids: competitors
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
      },
      schedule_config: {
        publish_hour_utc: hour === "" ? null : Number(hour),
        enabled: scheduleEnabled,
      },
      // A reference only — the token itself never reaches this app. The public
      // channel facts confirmed above are safe to keep: they are the proof the
      // right channel was opened.
      // Proof, not decoration: `verified_at` is what the database checks
      // before it will let this channel be ACTIVE, and what the scheduler
      // checks before it will spend anything on it. None of it is secret —
      // every field came back from a public channels.list read.
      credential_ref: {
        provider: "youtube",
        ref: credentialRef.trim() || effectiveId,
        youtube_channel_id: info.channelId,
        youtube_title: info.title,
        youtube_thumbnail: info.thumbnail,
        youtube_custom_url: info.customUrl,
        subscriber_count: info.subscribers ?? "",
        video_count: info.videos ?? "",
        verified_at: now,
      },
      created_at: now,
      updated_at: now,
    });
    setBusy(false);
    setStage(null);
    if (err) {
      setError(err.message);
      return;
    }
    setCreated(true);
    router.refresh();
  }

  if (created) {
    return (
      <div className="section-card page-rise flex flex-col items-start gap-4">
        <p className="text-sm text-[var(--color-ok)]">{t.channels.created}</p>
        {info && <ChannelProof info={info} t={t} />}
        {pushed && pushed.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-[12px] text-[var(--color-ok)]">
              {fmt(t.channels.secretsPushed, { n: pushed.length, repo: ghRepo ?? "GitHub" })}
            </p>
            <ul className="mono flex flex-col gap-0.5 text-[11px] text-[var(--color-muted)]">
              {pushed.map((s) => (
                <li key={s.name}>
                  {s.name} — {s.result === "created" ? t.channels.secretWritten : t.channels.secretUpdated}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="max-w-[70ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
          {fmt(t.channels.connectHint, { id: effectiveId, secret })}
        </p>
        <button
          type="button"
          onClick={() => router.push(path("/channels"))}
          className="btn-sky pill px-5 py-2.5 text-[13px]"
        >
          {t.channels.title} →
        </button>
      </div>
    );
  }

  return (
    <div className="panel flex flex-col gap-4 p-5">
      <ol className="flex flex-wrap gap-1.5">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === step ? "step" : undefined}
            className="rounded px-2 py-0.5 text-[9px] uppercase tracking-[0.22em]"
            style={{
              background: i === step ? "var(--color-panel-2)" : "transparent",
              color:
                i === step
                  ? "var(--color-primary)"
                  : i < step
                    ? "var(--color-fg)"
                    : "var(--color-muted)",
            }}
          >
            {i + 1}. {stepLabel(s, t)}
          </li>
        ))}
      </ol>

      <div className="flex min-h-[190px] flex-col gap-3">
        {current === "identity" && (
          <>
            <Field label={t.channels.name}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Extinct World"
                className={inputClass}
              />
            </Field>
            <Field label={t.channels.id} hint={t.channels.idHint}>
              <input
                value={effectiveId}
                onChange={(e) => {
                  setIdTouched(true);
                  setChannelId(e.target.value);
                }}
                placeholder="extinct-world"
                className={inputClass}
                aria-invalid={Boolean(effectiveId) && !idValid}
              />
            </Field>
          </>
        )}

        {current === "niche" && (
          <Field label={t.channels.niche}>
            <input
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="Prehistoric History"
              className={inputClass}
            />
          </Field>
        )}

        {current === "content" && (
          <>
            <Field label={t.channels.systemPrompt}>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={3}
                className={inputClass}
              />
            </Field>
            <Field label={t.channels.contentRules}>
              <textarea
                value={nicheRules}
                onChange={(e) => setNicheRules(e.target.value)}
                rows={2}
                className={inputClass}
              />
            </Field>
            <Field label={t.channels.competitors} hint={t.channels.competitorsHint}>
              <input
                value={competitors}
                onChange={(e) => setCompetitors(e.target.value)}
                placeholder="UCxxxxxxxx, UCyyyyyyyy"
                className={inputClass}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t.channels.language}>
                <input value={language} onChange={(e) => setLanguage(e.target.value)} className={inputClass} />
              </Field>
              <Field label={t.channels.targetDuration}>
                <input
                  type="number"
                  min={60}
                  max={3600}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value) || 300)}
                  className={inputClass}
                />
              </Field>
            </div>
          </>
        )}

        {current === "voice" && (
          <>
            <Field label="TTS">
              <select value={ttsProvider} onChange={(e) => setTtsProvider(e.target.value)} className={inputClass}>
                <option value="edge">edge</option>
                <option value="elevenlabs">elevenlabs</option>
              </select>
            </Field>
            {ttsProvider === "edge" ? (
              <Field label={t.channels.voice}>
                <input value={edgeVoice} onChange={(e) => setEdgeVoice(e.target.value)} className={inputClass} />
              </Field>
            ) : (
              <>
                {/* Picked, never typed. A voice id is twenty characters of
                    noise that nobody remembers, so a free-text field can only
                    ever collect a guess. */}
                {voices === null ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={loadVoices}
                      disabled={voicesBusy || !elevenKey.trim()}
                      className="btn-sky pill px-5 py-2.5 text-[13px] disabled:opacity-40"
                    >
                      {voicesBusy ? t.channels.voiceLoading : t.channels.voiceLoad}
                    </button>
                    {!elevenKey.trim() && (
                      <span className="text-[11px] text-[var(--color-muted)]">
                        {t.channels.voiceNeedsKey}
                      </span>
                    )}
                  </div>
                ) : voices.length === 0 ? (
                  <p className="text-[12px] text-[var(--color-warn)]">{t.channels.voiceNone}</p>
                ) : (
                  <Field label={t.channels.voiceChoose}>
                    <select
                      value={elevenVoice}
                      onChange={(e) => setElevenVoice(e.target.value)}
                      className={inputClass}
                    >
                      <option value="">{t.channels.voicePick}</option>
                      {voices.map((v) => {
                        const owner = takenVoices[v.voiceId];
                        return (
                          <option key={v.voiceId} value={v.voiceId} disabled={Boolean(owner)}>
                            {v.name}
                            {v.labels ? ` — ${v.labels}` : ""}
                            {owner ? ` (${fmt(t.channels.voiceTaken, { channel: owner })})` : ""}
                          </option>
                        );
                      })}
                    </select>
                  </Field>
                )}
                {voicesError && <p className="text-[12px] text-[var(--color-fail)]">{voicesError}</p>}
                {voiceTakenBy && (
                  <p className="text-[12px] text-[var(--color-fail)]">
                    {fmt(t.channels.voiceTakenWarn, { channel: voiceTakenBy })}
                  </p>
                )}
                {/* Hear it before committing a channel to it. */}
                {elevenVoice && voices?.find((v) => v.voiceId === elevenVoice)?.previewUrl && (
                  <audio
                    controls
                    preload="none"
                    src={voices.find((v) => v.voiceId === elevenVoice)!.previewUrl}
                    className="w-full max-w-[360px]"
                  />
                )}
              </>
            )}
          </>
        )}

        {current === "visual" && (
          <Field label={t.channels.visualStyle}>
            <textarea
              value={visualStyle}
              onChange={(e) => setVisualStyle(e.target.value)}
              rows={3}
              placeholder="Cinematic prehistoric documentary: primeval forests, volcanic skies, fossil beds."
              className={inputClass}
            />
          </Field>
        )}

        {current === "schedule" && (
          <>
            <Field label={t.channels.scheduleHour}>
              <input
                type="number"
                min={0}
                max={23}
                value={hour}
                onChange={(e) => setHour(e.target.value === "" ? "" : Number(e.target.value))}
                className={inputClass}
              />
            </Field>
            <label className="flex items-center gap-2 text-[12px] text-[var(--color-fg)]">
              <input
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
              />
              {t.channels.scheduleEnabled}
            </label>
          </>
        )}

        {current === "keys" && (
          <>
            <p className="max-w-[72ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
              {t.channels.keysHint}
            </p>
            {ghConfigured === false ? (
              <p className="max-w-[72ch] text-[12px] leading-relaxed text-[var(--color-warn)]">
                {t.channels.keysNotConfigured}
              </p>
            ) : (
              ghRepo && (
                <p className="mono text-[11px] text-[var(--color-muted)]">
                  {fmt(t.channels.keysTarget, { repo: ghRepo })}
                </p>
              )
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Secret label={t.channels.keyGemini} value={geminiKey} onChange={setGeminiKey} name="GEMINI_API_KEY" />
              <Secret label={t.channels.keyPexels} value={pexelsKey} onChange={setPexelsKey} name="PEXELS_API_KEY" />
              <Secret label={t.channels.keyEleven} value={elevenKey} onChange={setElevenKey} name="ELEVENLABS_API_KEY" />
              <Secret
                label={t.channels.keyYoutubeData}
                value={ytDataKey}
                onChange={setYtDataKey}
                name="YOUTUBE_DATA_API_KEY"
                hint={t.channels.keyYoutubeDataHint}
              />
            </div>
            <Field label={t.channels.keyClientSecret} hint="YOUTUBE_CLIENT_SECRET_JSON">
              <textarea
                value={clientSecretJson}
                onChange={(e) => setClientSecretJson(e.target.value)}
                rows={2}
                spellCheck={false}
                autoComplete="off"
                placeholder='{"installed":{…}}'
                className={inputClass}
              />
            </Field>
            <Field label={t.channels.keyToken} hint={fmt(t.channels.keyTokenHint, { secret })}>
              <textarea
                value={tokenJson}
                onChange={(e) => setTokenJson(e.target.value)}
                rows={2}
                spellCheck={false}
                autoComplete="off"
                placeholder='{"refresh_token":"…"}'
                className={inputClass}
              />
            </Field>
          </>
        )}

        {current === "connect" && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="credential ref">
                <input
                  value={credentialRef}
                  onChange={(e) => setCredentialRef(e.target.value)}
                  placeholder={effectiveId}
                  className={inputClass}
                />
              </Field>
              <Field label={`${t.channels.youtube} channel id`} hint={t.channels.handleHint}>
                <input
                  value={youtubeChannelId}
                  onChange={(e) => setYoutubeChannelId(e.target.value)}
                  placeholder="UC…"
                  className={inputClass}
                />
              </Field>
            </div>
            <Field label={t.channels.handle}>
              <input
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="@extinctworld"
                className={inputClass}
              />
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={verify}
                disabled={verifyBusy || !ytDataKey.trim() || (!youtubeChannelId.trim() && !handle.trim())}
                className="btn-sky pill px-5 py-2.5 text-[13px] disabled:opacity-40"
              >
                {verifyBusy ? t.channels.verifying : t.channels.verify}
              </button>
              {!ytDataKey.trim() && (
                <span className="text-[11px] text-[var(--color-muted)]">{t.channels.verifyNeedsKey}</span>
              )}
            </div>

            {verifyError && <p className="text-[12px] text-[var(--color-fail)]">{verifyError}</p>}
            {info ? (
              <ChannelProof info={info} t={t} />
            ) : (
              <p className="max-w-[72ch] text-[12px] leading-relaxed text-[var(--color-warn)]">
                {t.channels.verifyRequired}
              </p>
            )}

            <p className="max-w-[72ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
              {fmt(t.channels.connectHint, { id: effectiveId || "…", secret })}
            </p>
          </>
        )}

        {current === "activate" && (
          <>
            {info ? (
              <ChannelProof info={info} t={t} />
            ) : (
              <p className="max-w-[72ch] text-[12px] leading-relaxed text-[var(--color-warn)]">
                {t.channels.verifyRequired}
              </p>
            )}
            <p className="max-w-[72ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
              {t.channels.activateHint}
            </p>
          </>
        )}
      </div>

      {stage && <p className="text-[12px] text-[var(--color-muted)]">{stage}</p>}
      {error && <p className="mono text-[11px] text-[var(--color-fail)]">{t.channels.createFailed}: {error}</p>}

      <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-3">
        <button
          type="button"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0 || busy}
          className="btn-sky ghost pill px-5 py-2.5 text-[13px] disabled:opacity-40"
        >
          {t.channels.back}
        </button>
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            onClick={() => setStep((s) => s + 1)}
            disabled={!canAdvance}
            className="btn-sky pill px-5 py-2.5 text-[13px] disabled:opacity-40"
          >
            {t.channels.next}
          </button>
        ) : (
          <button
            type="button"
            onClick={create}
            disabled={busy || !idValid || !name.trim() || !info || !voiceReady}
            className="btn-sky is-solid pill px-5 py-2.5 text-[13px] disabled:opacity-40"
          >
            {busy ? t.channels.creating : t.channels.create}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The channel as YouTube itself reports it: avatar, name, handle and counts.
 *
 * Every figure here came back from channels.list moments ago. A count YouTube
 * hides (subscriber counts can be private) reads "hidden" rather than 0 — an
 * unknown is never rendered as a number.
 */
function ChannelProof({ info, t }: { info: ChannelInfo; t: Dict }) {
  const stat = (v: string | null) => (v === null ? t.channels.hidden : Number(v).toLocaleString());
  return (
    <div className="flex flex-wrap items-center gap-5 rounded-[18px] border border-[var(--color-border)] bg-[var(--color-panel-2)] p-4">
      {info.thumbnail && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={info.thumbnail}
          alt=""
          width={64}
          height={64}
          className="h-16 w-16 shrink-0 rounded-full border border-[var(--color-border)] object-cover"
        />
      )}
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--color-ok)]">
          {t.channels.verified}
        </div>
        <div className="mt-1.5 truncate text-[17px] font-semibold">{info.title}</div>
        <div className="mono truncate text-[11px] text-[var(--color-muted)]">
          {info.customUrl || info.channelId}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-2 sm:ml-auto">
        <Stat label={t.channels.subscribers} value={stat(info.subscribers)} />
        <Stat label={t.channels.videoCount} value={stat(info.videos)} />
        <Stat label={t.channels.viewCount} value={stat(info.views)} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-[0.24em] text-[var(--color-muted)]">{label}</div>
      <div className="mono mt-1 text-[15px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus-visible:border-[var(--color-primary-dim)]";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-[var(--color-muted)]">{hint}</span>}
    </label>
  );
}

/**
 * A key field. Masked, never autofilled, never autocompleted — a password
 * manager must not learn these, and a screen recording must not capture them.
 */
function Secret({
  label,
  name,
  value,
  onChange,
  hint,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint ?? name}>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder="••••••••"
        className={inputClass}
      />
    </Field>
  );
}

type Dict = ReturnType<typeof useI18n>["t"];

function stepLabel(step: Step, t: Dict): string {
  switch (step) {
    case "identity":
      return t.channels.stepIdentity;
    case "niche":
      return t.channels.stepNiche;
    case "content":
      return t.channels.stepContent;
    case "voice":
      return t.channels.stepVoice;
    case "visual":
      return t.channels.stepVisual;
    case "schedule":
      return t.channels.stepSchedule;
    case "keys":
      return t.channels.stepKeys;
    case "connect":
      return t.channels.stepConnect;
    default:
      return t.channels.stepActivate;
  }
}
