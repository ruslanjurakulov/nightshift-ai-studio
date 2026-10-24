"use client";

import { useId, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/client";
import {
  CONSENT_TEXT_IS_PLACEHOLDER,
  CONSENT_TEXT_VERSION,
  DECLARATION_KEYS,
  MAX_RECORDING_SECONDS,
  MIN_RECORDING_SECONDS,
  NAME_MAX,
  NAME_MIN,
  newIdempotencyKey,
  type DeclarationKey,
  type RpcProblem,
  type StartedRequest,
} from "@/lib/custom-voice";
import { startVoiceRequest, uploadSample, type UploadProblem, type VoiceClient } from "@/lib/custom-voice-api";
import { useVoiceRecorder, type RecorderState } from "./useVoiceRecorder";
import { problemText } from "./messages";

type Step = "consent" | "record" | "sent";
type D = Dictionary["customVoice"];

const DECLARATION_TEXT = {
  own_voice: "decOwnVoice",
  sole_speaker: "decSoleSpeaker",
  over_18: "decOver18",
  voice_data_to_provider: "decDataToPartner",
  no_impersonation: "decNoImpersonation",
} as const satisfies Record<DeclarationKey, string>;

const noneChecked = (): Record<DeclarationKey, boolean> => ({
  own_voice: false,
  sole_speaker: false,
  over_18: false,
  voice_data_to_provider: false,
  no_impersonation: false,
});

/**
 * Add a voice: the declarations, the phrase, the live recording, the upload. It stops when the recording is sent; the card in the
 * list takes over from there (the status is polled by the page, not here).
 *
 * Order matters. The phrase is made by the database and only comes back from the request, so the request is the FIRST call: before
 * it nothing is recorded, uploaded or stored. While the request function is not granted (docs/CUSTOM_VOICE.md) that call is the one
 * that answers "not available yet", and nothing else has happened.
 */
export function NewVoiceFlow({ orgId, onSent, onClose }: { orgId: string | null; onSent: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const d = t.customVoice;
  const uid = useId();
  const [step, setStep] = useState<Step>("consent");
  const [name, setName] = useState("");
  const [checked, setChecked] = useState<Record<DeclarationKey, boolean>>(noneChecked);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<RpcProblem | null>(null);
  const [started, setStarted] = useState<StartedRequest | null>(null);
  const [upload, setUpload] = useState<"idle" | "sending" | UploadProblem | "done">("idle");
  const rec = useVoiceRecorder();
  // One key per request: a retry of the very same request is a replay, a request that changed gets a new one.
  const idem = useRef<{ sig: string; key: string } | null>(null);
  // Set on the first tap, before the next render: state alone lags, and a fast second tap would ask twice (two requests, or two
  // uploads of the one take).
  const lock = useRef(false);

  // A browser that cannot record must not spend one of the day's few requests to find out.
  const cannotRecord = rec.state === "unsupported" || rec.state === "blockedBySite";
  const trimmed = name.trim();
  const nameOk = trimmed.length >= NAME_MIN && trimmed.length <= NAME_MAX;
  const allChecked = DECLARATION_KEYS.every((k) => checked[k]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (lock.current || cannotRecord || !nameOk || !allChecked) return;
    const client = createClient() as unknown as VoiceClient | null;
    if (!client) {
      setProblem("failed");
      return;
    }
    const sig = JSON.stringify([trimmed, checked, orgId]);
    if (!idem.current || idem.current.sig !== sig) idem.current = { sig, key: newIdempotencyKey() };
    lock.current = true;
    setBusy(true);
    setProblem(null);
    const res = await startVoiceRequest(client, { name: trimmed, declarations: checked, orgId, idem: idem.current.key });
    lock.current = false;
    setBusy(false);
    if (!res.ok) {
      setProblem(res.problem);
      return;
    }
    setStarted(res.started);
    setStep("record");
  }

  async function send() {
    const take = rec.take;
    const client = createClient() as unknown as VoiceClient | null;
    if (!take || !started || !client || lock.current) return;
    lock.current = true;
    setUpload("sending");
    const res = await uploadSample(client, started, take.blob, { type: take.type, ext: take.ext });
    lock.current = false;
    if (!res.ok) {
      setUpload(res.problem);
      return;
    }
    setUpload("done");
    setStep("sent");
    onSent();
  }

  if (problem === "notAvailable") {
    return (
      <section className="ns-panel" data-tone="sunken" aria-labelledby={`${uid}-na`}>
        <div className="p-4 flex flex-col gap-3">
          <h2 id={`${uid}-na`} className="g2-label">
            {d.notAvailableTitle}
          </h2>
          <p role="status">{d.notAvailableBody}</p>
          <div>
            <button type="button" className="btn-quiet" onClick={onClose}>
              {d.close}
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (step === "sent") {
    return (
      <section className="ns-panel" data-tone="sunken">
        <div className="p-4 flex flex-col gap-3">
          <p role="status">{d.uploadDone}</p>
          <div>
            <button type="button" className="btn-quiet" onClick={onClose}>
              {d.close}
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (step === "record" && started) {
    const expires = started.expiresAt
      ? new Date(started.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : null;
    const sending = upload === "sending";
    return (
      <section className="ns-panel" data-tone="sunken" aria-labelledby={`${uid}-rec`}>
        <div className="p-4 flex flex-col gap-4">
          <h2 id={`${uid}-rec`} className="g2-label">
            {d.recordTitle}
          </h2>
          <div>
            <p className="g2-note" id={`${uid}-phrase-label`}>
              {d.phraseLabel}
            </p>
            {/* The phrase is the database's own words, checked to be lower-case words before it gets here. */}
            <p lang="en" aria-labelledby={`${uid}-phrase-label`} className="text-xl font-semibold tracking-wide break-words" data-testid="phrase">
              {started.phrase}
            </p>
            <p className="g2-note mt-1">{fmt(d.phraseHelp, { min: MIN_RECORDING_SECONDS, max: MAX_RECORDING_SECONDS })}</p>
            {expires && <p className="g2-note">{fmt(d.expiresNote, { time: expires })}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {rec.state === "recording" ? (
              <button type="button" className="btn-primary" onClick={rec.stop}>
                {d.stopRecording}
              </button>
            ) : rec.state === "recorded" ? (
              <>
                <button type="button" className="btn-primary" onClick={() => void send()} disabled={sending}>
                  {sending ? d.uploading : upload === "network" || upload === "failed" ? d.retryUpload : d.uploadRecording}
                </button>
                <button type="button" className="btn-quiet" onClick={() => { setUpload("idle"); rec.reset(); }} disabled={sending}>
                  {d.reRecord}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-primary"
                onClick={() => void rec.start()}
                disabled={rec.state === "requesting" || rec.state === "unsupported" || rec.state === "blockedBySite"}
              >
                {rec.state === "tooShort" ? d.reRecord : d.startRecording}
              </button>
            )}
            <button type="button" className="btn-quiet" onClick={onClose} disabled={sending}>
              {d.cancel}
            </button>
          </div>

          {(rec.state === "recording" || rec.state === "recorded") && (
            <p className="tnum" role="timer" aria-label={d.timerLabel}>
              {fmt(d.timerValue, { seconds: rec.seconds, max: MAX_RECORDING_SECONDS })}
            </p>
          )}
          {rec.take && (
            <audio controls src={rec.take.url} aria-label={d.listenLabel} className="w-full max-w-full" />
          )}

          <div role="status" aria-live="polite" className="flex flex-col gap-1" data-testid="recorder-status">
            <p>{recorderLine(rec.state, rec.seconds, rec.shortBy, rec.hitMax, d)}</p>
            {upload === "sending" && <p>{d.uploading}</p>}
            {upload !== "idle" && upload !== "sending" && upload !== "done" && (
              <p className="g2-fail" role="alert">
                {uploadText(upload, d)}
              </p>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <form className="ns-panel" data-tone="sunken" onSubmit={(e) => void submit(e)} aria-labelledby={`${uid}-consent`} noValidate>
      <div className="p-4 flex flex-col gap-4">
        <h2 id={`${uid}-consent`} className="g2-label">
          {d.consentTitle}
        </h2>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-name`} className="g2-strong">
            {d.nameLabel}
          </label>
          <input
            id={`${uid}-name`}
            type="text"
            autoComplete="off"
            maxLength={NAME_MAX + 20}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setProblem(null);
            }}
            aria-describedby={`${uid}-name-hint`}
            aria-invalid={trimmed.length > 0 && !nameOk ? true : undefined}
            className="ns-field w-full max-w-md"
          />
          <span id={`${uid}-name-hint`} className="g2-note">
            {d.nameHint}
          </span>
        </div>

        <fieldset className="flex flex-col gap-2 border-0 p-0 m-0">
          <legend className="g2-strong mb-1">{d.declarationsLegend}</legend>
          {DECLARATION_KEYS.map((key) => (
            <label key={key} className="flex items-start gap-2">
              <input
                type="checkbox"
                required
                className="mt-1 shrink-0"
                checked={checked[key]}
                onChange={(e) => {
                  setChecked((c) => ({ ...c, [key]: e.target.checked }));
                  setProblem(null);
                }}
              />
              <span>{d[DECLARATION_TEXT[key]]}</span>
            </label>
          ))}
        </fieldset>

        <div className="flex flex-col gap-1" aria-labelledby={`${uid}-ct`} role="group">
          <h3 id={`${uid}-ct`} className="g2-strong">
            {d.consentTextTitle}
          </h3>
          {CONSENT_TEXT_IS_PLACEHOLDER && (
            <p className="g2-fail" data-testid="consent-placeholder">
              <strong>{d.consentPlaceholderMarker}</strong>
            </p>
          )}
          <p className="g2-note">{d.consentPlaceholderBody}</p>
          <p className="g2-note tnum">{fmt(d.consentVersion, { version: CONSENT_TEXT_VERSION })}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn-primary" disabled={busy || cannotRecord || !nameOk || !allChecked}>
            {busy ? d.requesting : d.continue}
          </button>
          <button type="button" className="btn-quiet" onClick={onClose} disabled={busy}>
            {d.cancel}
          </button>
        </div>

        <div role="status" aria-live="polite">
          {busy && <p>{d.requesting}</p>}
          {cannotRecord && <p className="g2-fail">{recorderLine(rec.state, 0, null, false, d)}</p>}
          {problem && (
            <p className="g2-fail" role="alert">
              {problemText(problem, d)}
            </p>
          )}
        </div>
      </div>
    </form>
  );
}

function recorderLine(
  state: RecorderState,
  seconds: number,
  shortBy: number | null,
  hitMax: boolean,
  d: D,
): string {
  switch (state) {
    case "requesting":
      return d.recRequesting;
    case "recording":
      // Rounded down to ten seconds so a screen reader is told the time now and then, not every second.
      return fmt(d.recRecording, { seconds: Math.floor(seconds / 10) * 10 });
    case "recorded":
      return `${fmt(d.recReady, { seconds })}${hitMax ? ` ${fmt(d.recMaxReached, { max: MAX_RECORDING_SECONDS })}` : ""}`;
    case "tooShort":
      return fmt(d.recTooShort, { seconds: Math.floor(shortBy ?? 0), min: MIN_RECORDING_SECONDS });
    case "unsupported":
      return d.recUnsupported;
    case "blockedBySite":
      return d.recBlockedBySite;
    case "denied":
      return d.recDenied;
    case "noDevice":
      return d.recNoDevice;
    case "failed":
      return d.recFailed;
    default:
      return "";
  }
}

function uploadText(p: UploadProblem, d: D): string {
  switch (p) {
    case "expired":
      return d.uploadExpired;
    case "exists":
      return d.uploadExists;
    case "tooLarge":
      return d.uploadTooLarge;
    case "network":
      return d.uploadNetwork;
    default:
      return d.uploadFailed;
  }
}
