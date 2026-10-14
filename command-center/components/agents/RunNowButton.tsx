"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useToast } from "@/components/feedback/ToastProvider";
import { AttemptsFullError, createAttempt } from "@/lib/create-attempt";
import { formatCredits } from "@/lib/credits";
import { fmt } from "@/lib/i18n";
import { readRunAnswer, unsureRunAnswer } from "@/lib/run-answer";
import { ExtraOffLink } from "@/components/usage/ExtraOffLink";
import { CreditEstimateLine, type PriceReport } from "@/components/credits/CreditEstimateLine";

/**
 * "Run now" — trigger this channel's pipeline on demand.
 *
 * This spends money and can produce (and, with auto-publish on, publish) a
 * video, so it asks once before it fires: the first click arms a Confirm button
 * rather than starting the run. Confirm POSTs to /api/agent/run, which dispatches
 * the daily-video workflow for this channel on GitHub Actions — the server does
 * no heavy work, it just asks GitHub to start the same job the cron runs.
 *
 * The run carries an idempotency key (one per intent, kept for a retry of the same inputs, so a double
 * click or a lost answer cannot hold credits twice) and, when the estimate line is showing a price, that
 * price as `max_credits`. While the price is loading or unreadable the confirm waits, so a price nobody has
 * seen is never confirmed. See lib/create-attempt.ts and lib/run-answer.ts, which CreateStudio shares.
 *
 * Two presentations, same logic:
 * - `variant="panel"` (default) is the Agents-page card, with a title and hint,
 *   and its own warnings when there is no single channel or GitHub isn't wired.
 * - `variant="inline"` is just the button, for a hero action row. The caller
 *   only renders it when a run is actually possible, so it carries no warnings.
 */
type Phase = "idle" | "confirm" | "starting" | "queued" | "error";

export function RunNowButton({
  channelId,
  githubConfigured,
  variant = "panel",
  label,
  canRun = true,
  userId = "",
  orgId = null,
}: {
  /** The scoped channel's id, or null when "All channels" is selected. */
  channelId: string | null;
  /** Whether on-demand runs are wired (GITHUB_SECRETS_TOKEN/REPO present). */
  githubConfigured: boolean;
  /** "panel" = the Agents card; "inline" = a bare button for an action row. */
  variant?: "panel" | "inline";
  /** Override the button label (e.g. "Produce a video" on the dashboard). */
  label?: string;
  /** Whether the caller is an owner/admin of the channel's organization — the
   *  role /api/agent/run requires. Presentation only; the route re-checks. */
  canRun?: boolean;
  /** The signed-in user's id from the server page (getUser()): lets the idempotency key survive a reload of this
   *  tab. Empty (not known) = memory only. Never shown, never stored in the clear. */
  userId?: string;
  /** The open organization when the page knows it: part of what the stored key is for. */
  orgId?: string | null;
}) {
  const { t, locale } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [creditError, setCreditError] = useState<string | null>(null);
  const [extraOff, setExtraOff] = useState(false);
  const toast = useToast();
  // What the estimate line says (it is mounted while the confirm is open): a figure is the run's ceiling.
  const [price, setPrice] = useState<PriceReport>({ state: "loading" });
  const shownPrice = price.state === "priced" ? price.credits : null;
  const priceHold = !!channelId && (price.state === "loading" || price.state === "failed");
  const [retryNonce, setRetryNonce] = useState(0);
  // The channel is part of what the key stands for (its signature), so another channel never gets this key.
  const [attempt] = useState(() => createAttempt());
  const sending = useRef(false);
  const [replayed, setReplayed] = useState(false);
  // Bumped when an answer changes what the attempt knows (settled, unsure, blocked), so the button re-reads it.
  const [tick, setTick] = useState(0);
  // The error on screen is the "credits are held" one: it goes away when the input changes (a new intent).
  const [errorBlocked, setErrorBlocked] = useState(false);

  // Optional per-run topic + data-backed suggestions (panel variant only).
  type Idea = { label: string; source: "demand" | "proven" };
  type IdeasPhase = "idle" | "loading" | "loaded" | "error";
  const [topic, setTopic] = useState("");
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [ideasPhase, setIdeasPhase] = useState<IdeasPhase>("idle");

  // Optional per-run controls. Empty = the channel's own setting, so a plain
  // run behaves exactly as before. Duration is seconds ("" = channel target).
  const [duration, setDuration] = useState("");
  const [language, setLanguage] = useState("");
  const [styleOverride, setStyleOverride] = useState("");

  const blocked = !channelId || !githubConfigured || !canRun;

  // What the person decided, as the run's body (without the key and the price). Its JSON is the intent's signature.
  function runFields() {
    const trimmed = topic.trim();
    const dur = Number(duration);
    const style = styleOverride.trim();
    return {
      channel_id: channelId,
      ...(trimmed ? { topic: trimmed } : {}),
      ...(duration && Number.isFinite(dur) && dur > 0 ? { duration: dur } : {}),
      ...(language ? { language } : {}),
      ...(style ? { visual_style: style } : {}),
    };
  }
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

  async function loadIdeas() {
    setIdeasPhase("loading");
    try {
      const res = await fetch("/api/agent/ideas");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setIdeasPhase("error");
        return;
      }
      setIdeas(Array.isArray(data.ideas) ? (data.ideas as Idea[]) : []);
      setIdeasPhase("loaded");
    } catch {
      setIdeasPhase("error");
    }
  }

  // This same intent waits for credits that are still held, or the scope is full of such intents (lib/create-attempt.ts).
  const isStopped = () => {
    const k = attempt.status(JSON.stringify(runFields()), scope);
    return k.blocked !== null || k.full;
  };

  async function run() {
    // A start that definitely failed while its credits are still held: this same intent is not sent again (lib/run-answer.ts).
    if (!channelId || sending.current || priceHold || isStopped()) return;
    sending.current = true;
    setPhase("starting");
    setCreditError(null);
    setExtraOff(false);
    setReplayed(false);
    const fields = runFields();
    const sig = JSON.stringify(fields);
    // One intent = one key: channel + topic + options, NOT the price (max_credits carries that), 30-minute expiry.
    // With a user id it is also kept in this tab's sessionStorage as a hash (never the topic), so a reload after a
    // lost answer reuses it; without one it is in memory only (lib/create-attempt.ts).
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
      toast.error(message);
      return;
    }
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...fields,
          idempotency_key,
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
        if (answer.outcome === "started") toast.success(t.agents.runQueued);
        // Started (or already started) is true of the intent that was sent. If the person has since changed the form,
        // it is not said about, and does not disable, what is on screen now.
        if (stale) {
          setPhase("idle");
          return;
        }
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
      setCreditError(answer.message);
      setExtraOff(answer.extraOff);
      setErrorBlocked(answer.blockedCredits !== null);
      setPhase("error");
      toast.error(answer.message);
    } catch {
      // Unknown whether it arrived: the key is kept (and remembered as unsure), so trying again is safe.
      attempt.markUnsure(idempotency_key);
      setTick((n) => n + 1);
      if (intentRef.current !== sig) {
        setPhase("idle");
        return;
      }
      const unsure = unsureRunAnswer(t).message;
      setCreditError(unsure);
      setErrorBlocked(false);
      setPhase("error");
      toast.error(unsure);
    } finally {
      sending.current = false;
    }
  }

  const actions = (
    <div className="flex flex-wrap items-center gap-3">
      {phase === "confirm" ? (
        <>
          <button
            type="button"
            aria-disabled={(priceHold && price.state === "loading") || stopped}
            data-price-hold={priceHold ? price.state : undefined}
            onClick={() => {
              // Unreadable: the button is the retry. Loading: nothing until the figure arrives.
              if (stopped) return;
              if (price.state === "failed") setRetryNonce((n) => n + 1);
              else void run();
            }}
            className="btn-primary text-sm"
            style={{ borderColor: "var(--color-warn)", color: "var(--color-warn)" }}
          >
            {priceHold ? (price.state === "failed" ? t.common.retry : t.credits.priceChecking) : t.agents.runConfirm}
          </button>
          <button
            type="button"
            onClick={() => setPhase("idle")}
            className="btn-quiet text-sm"
          >
            {t.agents.runCancel}
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={blocked || phase === "starting" || stopped}
          onClick={() => {
            setPrice({ state: "loading" });
            setPhase("confirm");
          }}
          className="btn-primary text-sm disabled:opacity-40"
        >
          {phase === "starting" ? t.agents.runStarting : label ?? t.agents.runBtn}
        </button>
      )}

      <span className="tnum text-sm" aria-live="polite">
        {phase === "queued" ? (
          <span className="text-[var(--color-ok)]">{replayed ? t.create.flow.alreadySent : t.agents.runQueued}</span>
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
      </span>
      {/* The estimate before the run is confirmed (nothing before 0020). */}
      {phase === "confirm" && (
        <div className="basis-full">
          <CreditEstimateLine
            channelId={channelId}
            durationS={Number(duration) > 0 ? Number(duration) : null}
            onPrice={setPrice}
            refreshKey={retryNonce}
          />
        </div>
      )}
    </div>
  );

  if (variant === "inline") return actions;

  // Optional topic + "Ideas" suggestions. Only shown when a run is actually
  // possible, since the topic only reaches a real dispatch through `run()`.
  const topicBlock = (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-sm text-[var(--color-muted)]">
          {t.agents.runTopicLabel}
        </span>
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder={t.agents.runTopicPlaceholder}
          maxLength={300}
          className="ns-field"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={loadIdeas}
          disabled={ideasPhase === "loading"}
          className="btn-quiet text-sm disabled:opacity-40"
        >
          {ideasPhase === "loading" ? t.agents.runIdeasLoading : t.agents.runIdeas}
        </button>
        {ideasPhase === "error" && (
          <span className="tnum text-sm text-[var(--color-fail)]">{t.agents.runIdeasFailed}</span>
        )}
        {ideasPhase === "loaded" && ideas.length === 0 && (
          <span className="tnum text-sm text-[var(--color-muted)]">{t.agents.runIdeasEmpty}</span>
        )}
      </div>

      {ideas.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {ideas.map((idea) => (
            <button
              key={`${idea.source}:${idea.label}`}
              type="button"
              onClick={() => setTopic(idea.label)}
              title={idea.source === "demand" ? t.agents.runIdeaDemand : t.agents.runIdeaProven}
              className="rounded-[var(--ns-r-key)] inline-flex items-center gap-1.5 border border-[var(--color-border)] px-3 min-h-[44px] text-sm text-[var(--color-muted)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-fg)]"
            >
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{
                  background:
                    idea.source === "demand" ? "var(--color-primary)" : "var(--color-ok)",
                }}
              />
              {idea.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  // Per-run controls: length, language and look. Each defaults to "the
  // channel's own", so leaving them untouched runs exactly as before.
  const selectClass =
    "ns-field";
  const controlsBlock = (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-sm text-[var(--color-muted)]">
            {t.agents.runDurationLabel}
          </span>
          <select value={duration} onChange={(e) => setDuration(e.target.value)} className={selectClass}>
            <option value="">{t.agents.runOptChannel}</option>
            <option value="180">{t.agents.runDur3m}</option>
            <option value="300">{t.agents.runDur5m}</option>
            <option value="600">{t.agents.runDur10m}</option>
            <option value="1200">{t.agents.runDur20m}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-[var(--color-muted)]">
            {t.agents.runLangLabel}
          </span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className={selectClass}>
            <option value="">{t.agents.runOptChannel}</option>
            <option value="English">English</option>
            <option value="Arabic">العربية</option>
            <option value="Russian">Русский</option>
            <option value="Spanish">Español</option>
            <option value="Chinese">中文</option>
            <option value="Korean">한국어</option>
            <option value="Indonesian">Indonesia</option>
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-[var(--color-muted)]">
          {t.agents.runStyleLabel}
        </span>
        <input
          type="text"
          value={styleOverride}
          onChange={(e) => setStyleOverride(e.target.value)}
          placeholder={t.agents.runStylePlaceholder}
          maxLength={300}
          className="ns-field"
        />
      </label>
    </div>
  );

  return (
    <div className="panel ns-desk flex flex-col gap-3">
      <div>
        <h2 className="t-panel">{t.agents.runTitle}</h2>
        <p className="mt-1 max-w-[72ch] text-sm leading-relaxed text-[var(--color-muted)]">
          {t.agents.runHint}
        </p>
      </div>

      {!githubConfigured ? (
        <p className="text-sm text-[var(--color-warn)]">{t.agents.runNotConfigured}</p>
      ) : !channelId ? (
        <p className="text-sm text-[var(--color-warn)]">{t.agents.runPickChannel}</p>
      ) : !canRun ? (
        <p className="text-sm text-[var(--color-muted)]">{t.agents.runNeedsAdmin}</p>
      ) : null}

      {!blocked && topicBlock}
      {!blocked && controlsBlock}
      {actions}
    </div>
  );
}
