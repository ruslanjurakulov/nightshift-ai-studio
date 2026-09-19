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
 * It needs one channel. With "All channels" selected there is no single target,
 * so the button is disabled and the panel says to pick a channel — better than a
 * button that fans out to every channel from one click.
 */
type Phase = "idle" | "confirm" | "starting" | "queued" | "error";

export function RunNowButton({
  channelId,
  githubConfigured,
}: {
  /** The scoped channel's id, or null when "All channels" is selected. */
  channelId: string | null;
  /** Whether on-demand runs are wired (GITHUB_SECRETS_TOKEN/REPO present). */
  githubConfigured: boolean;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorKey, setErrorKey] = useState<"unauthorized" | "failed">("failed");

  const blocked = !channelId || !githubConfigured;

  async function run() {
    if (!channelId) return;
    setPhase("starting");
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: channelId }),
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
            {phase === "starting" ? t.agents.runStarting : t.agents.runBtn}
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
    </div>
  );
}
