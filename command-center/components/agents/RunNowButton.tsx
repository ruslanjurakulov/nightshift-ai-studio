"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useToast } from "@/components/feedback/ToastProvider";
import { createAttempt } from "@/lib/create-attempt";
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

  async function run() {
    if (!channelId || sending.current || priceHold) return;
    sending.current = true;
    setPhase("starting");
    setCreditError(null);
    setExtraOff(false);
    setReplayed(false);
    const trimmed = topic.trim();
    const dur = Number(duration);
    const style = styleOverride.trim();
    const fields = {
      channel_id: channelId,
      ...(trimmed ? { topic: trimmed } : {}),
      ...(duration && Number.isFinite(dur) && dur > 0 ? { duration: dur } : {}),
      ...(language ? { language } : {}),
      ...(style ? { visual_style: style } : {}),
    };
    // One intent = one key: channel + topic + options, NOT the price (max_credits carries that), in memory only,
    // 30-minute expiry. A reload loses it, so a reload after a lost answer CAN hold twice (the unstarted first
    // hold then expires on its own, about 3 hours).
    const idempotency_key = attempt.keyFor(JSON.stringify(fields));
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
      if (answer.outcome !== "failed") {
        attempt.settle();
        setReplayed(answer.outcome === "replay");
        setPhase("queued");
        if (answer.outcome === "started") toast.success(t.agents.runQueued);
        return;
      }
      if (answer.settled) attempt.settle();
      if (answer.unsure) attempt.markUnsure();
      setCreditError(answer.message);
      setExtraOff(answer.extraOff);
      setPhase("error");
      toast.error(answer.message);
    } catch {
      // Unknown whether it arrived: the key is kept (and remembered as unsure), so trying again is safe.
      attempt.markUnsure();
      const unsure = unsureRunAnswer(t).message;
      setCreditError(unsure);
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
            aria-disabled={priceHold && price.state === "loading"}
            data-price-hold={priceHold ? price.state : undefined}
            onClick={() => {
              // Unreadable: the button is the retry. Loading: nothing until the figure arrives.
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
          disabled={blocked || phase === "starting"}
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
        ) : phase === "error" ? (
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
