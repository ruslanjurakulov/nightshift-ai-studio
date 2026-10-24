"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { createClient } from "@/lib/supabase/client";
import { TEST_STEP_WIRED, isSettled, type ActiveAttachment, type RpcProblem, type VoiceProfileView } from "@/lib/custom-voice";
import { readAttachments, readProfiles, type VoiceClient } from "@/lib/custom-voice-api";
import { NewVoiceFlow } from "./NewVoiceFlow";
import { VoiceCard } from "./VoiceCard";

/** How often a request still being checked is looked at, and for how long on its own. */
const POLL_MS = 5000;
const POLL_LIMIT_MS = 10 * 60 * 1000;

type Load = "loading" | "ready" | "failed" | "unavailable";

/**
 * The custom voice page: what it is and what it does not prove, the person's voices, and the way to add one. The page that mounts
 * this is dark unless the owner switched CUSTOM_VOICE_ENABLED on (app/(app)/[channel]/agents/voice/page.tsx).
 */
export function CustomVoice({
  channelId,
  orgId,
  testStepWired = TEST_STEP_WIRED,
}: {
  channelId: string | null;
  orgId: string | null;
  /** Overridable for tests; the real page always uses the constant. */
  testStepWired?: boolean;
}) {
  const { t, locale } = useI18n();
  const d = t.customVoice;
  const [load, setLoad] = useState<Load>("loading");
  const [profiles, setProfiles] = useState<VoiceProfileView[]>([]);
  const [attachments, setAttachments] = useState<ActiveAttachment[]>([]);
  const [adding, setAdding] = useState(false);
  const [paused, setPaused] = useState(false);
  // Bumped by "Check again": the timer of a stopped poll is gone, so starting over needs the effect below to run again.
  const [epoch, setEpoch] = useState(0);
  const polledSince = useRef<number | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const client = createClient() as unknown as VoiceClient | null;
    if (!client) {
      setLoad("failed");
      return;
    }
    const [p, a] = await Promise.all([readProfiles(client), readAttachments(client)]);
    if (!alive.current) return;
    if (!p.ok) {
      // The table is not there (0117 not applied) or not readable: the same honest "not available" as the request's refusal.
      setLoad(failureLoad(p.problem));
      return;
    }
    setProfiles(p.profiles);
    setAttachments(a.ok ? a.attachments : []);
    setLoad("ready");
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  // A request still being checked changes by itself, so it is looked at every few seconds, for ten minutes at most. Everything
  // else only changes when the person acts, and then the card asks again.
  const waiting = profiles.some((p) => !isSettled(p.status));
  useEffect(() => {
    if (!waiting) {
      polledSince.current = null;
      setPaused(false);
      return;
    }
    if (polledSince.current === null) polledSince.current = Date.now();
    const timer = setInterval(() => {
      if (polledSince.current !== null && Date.now() - polledSince.current > POLL_LIMIT_MS) {
        clearInterval(timer);
        setPaused(true);
        return;
      }
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh, epoch]);

  const checkAgain = () => {
    polledSince.current = null;
    setPaused(false);
    setEpoch((n) => n + 1);
    void refresh();
  };

  return (
    <div className="flex flex-col gap-6">
      {locale !== "en" && (
        // Visible, not only a comment in the source: the ru and uz sentences are machine drafts (docs/CUSTOM_VOICE.md, V3-G4).
        <p className="g2-note" role="note" data-testid="machine-translation-note">
          {d.machineTranslationNote}
        </p>
      )}
      <section className="ns-panel" aria-labelledby="cv-intro">
        <div className="p-4 flex flex-col gap-3">
          <h2 id="cv-intro" className="g2-label">
            {d.introTitle}
          </h2>
          <p>{d.introBody}</p>
          <ol className="list-decimal pl-5 flex flex-col gap-1">
            <li>{d.how1}</li>
            <li>{d.how2}</li>
            <li>{d.how3}</li>
            <li>{d.how4}</li>
          </ol>
          <h3 className="g2-strong">{d.limitsTitle}</h3>
          <p>{d.limitsBody}</p>
          <p className="g2-note">{d.recordOnlyBody}</p>
          <p className="g2-note">{d.deletionBody}</p>
        </div>
      </section>

      <section aria-labelledby="cv-voices" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="cv-voices" className="g2-label">
            {d.yourVoices}
          </h2>
          {!adding && load === "ready" && (
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
              {d.addVoice}
            </button>
          )}
        </div>

        {adding && (
          <NewVoiceFlow
            orgId={orgId}
            onClose={() => setAdding(false)}
            onSent={() => {
              checkAgain();
            }}
          />
        )}

        <div role="status" aria-live="polite">
          {load === "loading" && <p>{d.loading}</p>}
          {waiting && !paused && <p className="g2-note">{d.checkingStatus}</p>}
          {waiting && paused && <p className="g2-note">{d.checkingPaused}</p>}
        </div>

        {load === "unavailable" && (
          <div className="ns-panel" data-tone="sunken">
            <div className="p-4 flex flex-col gap-1">
              <h3 className="g2-strong">{d.notAvailableTitle}</h3>
              <p>{d.notAvailableBody}</p>
            </div>
          </div>
        )}
        {load === "failed" && (
          <p className="g2-fail" role="alert">
            {d.loadFailed}{" "}
            <button type="button" className="btn-quiet" onClick={checkAgain}>
              {d.retry}
            </button>
          </p>
        )}
        {load === "ready" && profiles.length === 0 && !adding && <p>{d.noVoices}</p>}
        {load === "ready" && profiles.length > 0 && (
          <ul className="flex flex-col gap-3 list-none p-0 m-0">
            {profiles.map((p) => {
              const mine = attachments.filter((a) => a.profileId === p.id);
              const here = channelId !== null && mine.some((a) => a.channelId === channelId && a.slot === "narrator");
              return (
                <VoiceCard
                  key={p.id}
                  profile={p}
                  channelId={channelId}
                  attachedHere={here}
                  attachedCount={mine.filter((a) => a.channelId !== channelId).length}
                  testStepWired={testStepWired}
                  onChanged={() => void refresh()}
                />
              );
            })}
          </ul>
        )}
        {load === "ready" && (
          <div>
            <button type="button" className="btn-quiet" onClick={checkAgain}>
              {d.refresh}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function failureLoad(problem: RpcProblem): Load {
  return problem === "notAvailable" ? "unavailable" : "failed";
}
