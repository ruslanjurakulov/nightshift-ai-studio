"use client";

import { useState } from "react";
import { AppName, withParts } from "@/components/oauth/AppName";
import { OAuthNotice } from "@/components/oauth/OAuthShell";

/**
 * Allow or deny one connection. The only thing this form can send is the
 * single-use secret of THIS request (made for this signed-in person by the
 * server), the decision and a spending limit; the app, its redirect address and
 * the scopes live in the database row the secret names, so nothing about them
 * can be changed here. It posts with fetch (JSON, same origin), not a form:
 * the page's CSP allows form posts only to ourselves, and the answer is a
 * redirect to the app's registered address, which a form post would be blocked
 * from following.
 */

export interface ConsentText {
  /** 0176: the opt-in line for studio:create (shown only when the app asked for it). */
  studioOptIn?: string;
  limitLabel: string;
  limitHint: string;
  limitInvalid: string;
  /** "{app} can spend up to {n} credits a month", said back as the person types. */
  limitEcho: string;
  limitEchoOne: string;
  limitEchoZero: string;
  allow: string;
  deny: string;
  working: string;
  failed: string;
  expired: string;
  sessionEnded: string;
  /** The person's live-connection cap (0093). */
  tooManyConnections: string;
  /** Connections approved in a rolling day, revoked ones included (0147). */
  tooManyToday: string;
}

// A refusal names its remedy (rule 6); anything unknown is the generic "failed".
function refusalText(error: string | undefined, text: ConsentText): string {
  switch (error) {
    case "expired":
      return text.expired;
    case "invalid_limit":
      return text.limitInvalid;
    case "too_many_connections":
      return text.tooManyConnections;
    case "too_many_connections_today":
      return text.tooManyToday;
    default:
      return text.failed;
  }
}

export function ConsentForm({
  secret,
  app,
  locale,
  defaultLimit,
  maxLimit,
  offerStudio = false,
  text,
}: {
  secret: string;
  app: string;
  locale: string;
  defaultLimit: number;
  maxLimit: number;
  /** The app asked for studio:create: offer it as a separate, unticked choice (Lens/Breach on 0176). */
  offerStudio?: boolean;
  text: ConsentText;
}) {
  const [limit, setLimit] = useState(String(defaultLimit));
  // Spending on Studio generations is never part of the default: the person ticks it, or the connection does not get it.
  const [studio, setStudio] = useState(false);
  const [busy, setBusy] = useState<null | "allow" | "deny">(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = /^\d{1,6}$/.test(limit.trim()) ? Number(limit.trim()) : NaN;
  const limitOk = Number.isInteger(parsed) && parsed >= 0 && parsed <= maxLimit;

  async function send(decision: "allow" | "deny") {
    setError(null);
    if (decision === "allow" && !limitOk) {
      setError(text.limitInvalid);
      return;
    }
    setBusy(decision);
    try {
      const res = await fetch("/oauth/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ request: secret, decision, limit: decision === "allow" ? parsed : null, studio: decision === "allow" && offerStudio && studio }),
      });
      const type = res.headers.get("content-type") ?? "";
      if (!type.includes("application/json")) {
        // The gate answered with the sign-in page: the session ended.
        setError(text.sessionEnded);
        setBusy(null);
        return;
      }
      const body = (await res.json()) as { redirect?: string; error?: string };
      if (res.ok && typeof body.redirect === "string") {
        window.location.assign(body.redirect);
        return;
      }
      setError(refusalText(body.error, text));
    } catch {
      setError(text.failed);
    }
    setBusy(null);
  }

  // What the person is about to grant, in one sentence, from the number now in the box.
  const echo = !limitOk ? null : parsed === 0 ? text.limitEchoZero : parsed === 1 ? text.limitEchoOne : text.limitEcho;
  const n = limitOk ? new Intl.NumberFormat(locale).format(parsed) : "";

  return (
    // Nothing here submits by itself: a form with one text field submits on
    // Enter even with no submit button, and Enter in the limit box must not be
    // read as "Allow". Only a deliberate press of Allow or Deny sends a decision.
    <form className="fl-card" onSubmit={(e) => e.preventDefault()}>
      {offerStudio && text.studioOptIn && (
        <label className="flex items-start gap-3 text-base leading-snug">
          <input type="checkbox" className="mt-1 size-5 shrink-0" checked={studio} onChange={(e) => setStudio(e.target.checked)} />
          <span>{text.studioOptIn}</span>
        </label>
      )}
      <label className="st-field">
        <span>{text.limitLabel}</span>
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          required
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          aria-invalid={!limitOk}
          aria-describedby="oauth-limit-hint oauth-limit-echo"
        />
        <small id="oauth-limit-hint">{text.limitHint}</small>
      </label>
      <p id="oauth-limit-echo" className="st-body min-h-[3.25em] border-l-[3px] border-[var(--ns-text)] pl-3 font-semibold text-[var(--ns-text)] [overflow-wrap:anywhere]" aria-live="polite">
        {echo ? withParts(echo, { app: <AppName name={app} />, n }) : text.limitInvalid}
      </p>
      {error && <OAuthNotice tone="fail">{error}</OAuthNotice>}
      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <button type="button" className="st-key" data-block="true" disabled={busy !== null} onClick={() => void send("allow")}>
          {busy === "allow" ? text.working : text.allow}
        </button>
        <button type="button" className="st-key" data-tone="quiet" data-block="true" disabled={busy !== null} onClick={() => void send("deny")}>
          {busy === "deny" ? text.working : text.deny}
        </button>
      </div>
    </form>
  );
}
