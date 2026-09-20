"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";

/**
 * "Run now" — trigger this channel's pipeline on demand.
 *
 * This spends money and can produce (and, with auto-publish on, publish) a
 * video, so it asks once before it fires: the first click arms a Confirm button
 * rather than starting the run. Confirm POSTs to /api/agent/run, which dispatches
 * the daily-video workflow for this channel on GitHub Actions — the server does
 * no heavy work, it just asks GitHub to start the same job the cron runs.
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
}: {
  /** The scoped channel's id, or null when "All channels" is selected. */
  channelId: string | null;
  /** Whether on-demand runs are wired (GITHUB_SECRETS_TOKEN/REPO present). */
  githubConfigured: boolean;
  /** "panel" = the Agents card; "inline" = a bare button for an action row. */
  variant?: "panel" | "inline";
  /** Override the button label (e.g. "Produce a video" on the dashboard). */
  label?: string;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorKey, setErrorKey] = useState<"unauthorized" | "failed">("failed");

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

  const blocked = !channelId || !githubConfigured;

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
    if (!channelId) return;
    setPhase("starting");
    const trimmed = topic.trim();
    const dur = Number(duration);
    const style = styleOverride.trim();
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: channelId,
          ...(trimmed ? { topic: trimmed } : {}),
          ...(duration && Number.isFinite(dur) && dur > 0 ? { duration: dur } : {}),
          ...(language ? { language } : {}),
          ...(style ? { visual_style: style } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorKey(data.error === "github_unauthorized" ? "unauthorized" : "failed");
        setPhase("error");
        return;
      }
      setPhase("queued");
    } catch {
      setErrorKey("failed");
      setPhase("error");
    }
  }

  const actions = (
    <div className="flex flex-wrap items-center gap-3">
      {phase === "confirm" ? (
        <>
          <button
            type="button"
            onClick={run}
            className="btn-sky is-solid pill px-5 py-2 text-[13px]"
            style={{ borderColor: "var(--color-warn)", color: "var(--color-warn)" }}
          >
            {t.agents.runConfirm}
          </button>
          <button
            type="button"
            onClick={() => setPhase("idle")}
            className="btn-sky is-quiet pill px-4 py-2 text-[13px]"
          >
            {t.agents.runCancel}
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={blocked || phase === "starting"}
          onClick={() => setPhase("confirm")}
          className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
        >
          {phase === "starting" ? t.agents.runStarting : label ?? t.agents.runBtn}
        </button>
      )}

      <span className="mono text-[11px]" aria-live="polite">
        {phase === "queued" ? (
          <span className="text-[var(--color-ok)]">{t.agents.runQueued}</span>
        ) : phase === "error" ? (
          <span className="text-[var(--color-fail)]">
            {errorKey === "unauthorized" ? t.agents.runUnauthorized : t.agents.runFailed}
          </span>
        ) : null}
      </span>
    </div>
  );

  if (variant === "inline") return actions;

  // Optional topic + "Ideas" suggestions. Only shown when a run is actually
  // possible, since the topic only reaches a real dispatch through `run()`.
  const topicBlock = (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
          {t.agents.runTopicLabel}
        </span>
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder={t.agents.runTopicPlaceholder}
          maxLength={300}
          className="pill border border-[var(--color-border)] bg-transparent px-4 py-2 text-[13px] outline-none transition-colors focus:border-[var(--color-primary)]"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={loadIdeas}
          disabled={ideasPhase === "loading"}
          className="btn-sky is-quiet pill px-3 py-1.5 text-[12px] disabled:opacity-40"
        >
          {ideasPhase === "loading" ? t.agents.runIdeasLoading : t.agents.runIdeas}
        </button>
        {ideasPhase === "error" && (
          <span className="mono text-[11px] text-[var(--color-fail)]">{t.agents.runIdeasFailed}</span>
        )}
        {ideasPhase === "loaded" && ideas.length === 0 && (
          <span className="mono text-[11px] text-[var(--color-muted)]">{t.agents.runIdeasEmpty}</span>
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
              className="pill inline-flex items-center gap-1.5 border border-[var(--color-border)] px-3 py-1 text-[12px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-fg)]"
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
    "pill border border-[var(--color-border)] bg-transparent px-4 py-2 text-[13px] outline-none transition-colors focus:border-[var(--color-primary)]";
  const controlsBlock = (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
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
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
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
        <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
          {t.agents.runStyleLabel}
        </span>
        <input
          type="text"
          value={styleOverride}
          onChange={(e) => setStyleOverride(e.target.value)}
          placeholder={t.agents.runStylePlaceholder}
          maxLength={300}
          className="pill border border-[var(--color-border)] bg-transparent px-4 py-2 text-[13px] outline-none transition-colors focus:border-[var(--color-primary)]"
        />
      </label>
    </div>
  );

  return (
    <div className="panel flex flex-col gap-3 p-4">
      <div>
        <h2 className="t-section">{t.agents.runTitle}</h2>
        <p className="mt-1 max-w-[72ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
          {t.agents.runHint}
        </p>
      </div>

      {!githubConfigured ? (
        <p className="text-[13px] text-[var(--color-warn)]">{t.agents.runNotConfigured}</p>
      ) : !channelId ? (
        <p className="text-[13px] text-[var(--color-warn)]">{t.agents.runPickChannel}</p>
      ) : null}

      {!blocked && topicBlock}
      {!blocked && controlsBlock}
      {actions}
    </div>
  );
}
