"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";

type State = "idle" | "sending" | "sent" | "error";

/**
 * The admin-only "Send test alert" button. POSTs to /api/alerts/test, which
 * writes a row into the durable feed and (only if the Slack webhook is present
 * in the server runtime) delivers it. Nothing sensitive is sent in the body.
 *
 * After a successful send the page is refreshed so the new feed row appears.
 */
export function SendTestAlert() {
  const { t } = useI18n();
  const [state, setState] = useState<State>("idle");

  async function send() {
    if (state === "sending") return;
    setState("sending");
    try {
      const res = await fetch("/api/alerts/test", { method: "POST" });
      if (!res.ok) {
        setState("error");
        return;
      }
      setState("sent");
      // Reload so the freshly-written feed row shows without a manual refresh.
      setTimeout(() => window.location.reload(), 600);
    } catch {
      setState("error");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={send}
        disabled={state === "sending"}
        className="btn-sky pill px-4 py-1.5 text-[13px] disabled:opacity-40"
      >
        {state === "sending" ? t.alerts.sending : t.alerts.sendTest}
      </button>
      {state === "sent" && (
        <span className="mono text-[12px] text-[var(--color-primary)]" role="status">
          {t.alerts.testSent}
        </span>
      )}
      {state === "error" && (
        <span
          className="mono text-[12px]"
          style={{ color: "var(--color-warn, #e2a03f)" }}
          role="status"
        >
          {t.alerts.testFailed}
        </span>
      )}
    </div>
  );
}
