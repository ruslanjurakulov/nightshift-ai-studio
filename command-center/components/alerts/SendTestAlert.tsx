"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { postOperator } from "@/lib/operator-post";
import { operatorFailureText } from "@/lib/setup-errors";

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
  const [why, setWhy] = useState<string | null>(null);

  async function send() {
    if (state === "sending") return;
    setState("sending");
    setWhy(null);
    // Success is the server saying it wrote the row: a redirect, a sign-in page, `ok:false` and `recorded:false` are not.
    const out = await postOperator("/api/alerts/test");
    if (!out.ok) {
      // Slack got it but the feed row was not written: say exactly that, not a generic "could not send".
      setWhy(out.data.delivered === true && out.data.recorded === false ? t.ownerTruth.testDeliveredNotSaved : operatorFailureText(t, out, t.alerts.testFailed));
      setState("error");
      return;
    }
    setState("sent");
    // Reload so the freshly-written feed row shows without a manual refresh.
    setTimeout(() => window.location.reload(), 600);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={send}
        disabled={state === "sending"}
        className="btn-primary text-sm disabled:opacity-40"
      >
        {state === "sending" ? t.alerts.sending : t.alerts.sendTest}
      </button>
      {state === "sent" && (
        <span className="tnum text-sm text-[var(--color-primary)]" role="status">
          {t.alerts.testSent}
        </span>
      )}
      {state === "error" && (
        <span
          className="tnum text-sm"
          style={{ color: "var(--color-warn)" }}
          role="status"
        >
          {why ?? t.alerts.testFailed}
        </span>
      )}
    </div>
  );
}
