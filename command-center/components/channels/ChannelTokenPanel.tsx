"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
import { relativeTime } from "@/lib/format";
import { atLeast, type Role } from "@/lib/auth/roles-shared";
import {
  GOOGLE_PERMISSIONS_URL,
  missingScopes,
  type OperatorYoutubeState,
  shortScope,
  tokenPanelActions,
  type ChannelTokenStatus,
} from "@/lib/channel-tokens";

export interface ChannelTokenPanelProps {
  channelId: string;
  /** channel_token_status() row for this channel, or null when never connected. */
  status: ChannelTokenStatus | null;
  /** False when migration 0022 is not applied (the RPC does not exist). */
  available: boolean;
  role: Role;
  oauthConfigured: boolean;
  /** The scopes the connect flow requests (lib/server/google-oauth.ts). */
  requiredScopes: string[];
  /** The operator's own channel (migration 0115): Connect / Reconnect only, and the status words come from
   *  what the bot reported (`operatorState`: connected / expired / not connected). */
  operator?: boolean;
  operatorState?: OperatorYoutubeState;
}

/**
 * A customer channel's YouTube connection (migration 0022): who connected
 * which YouTube channel and when, with which permissions — never the token,
 * which this page cannot see — plus Connect and Disconnect for the
 * organization's owners/admins. The buttons are presentation; the routes and
 * the database check the role again.
 */
export function ChannelTokenPanel({
  channelId,
  status,
  available,
  role,
  oauthConfigured,
  requiredScopes,
  operator = false,
  operatorState,
}: ChannelTokenPanelProps) {
  const { t, locale } = useI18n();
  const tt = t.channelTokens;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justDisconnected, setJustDisconnected] = useState(false);
  const { confirm, dialog } = useConfirm();

  const connected = Boolean(status?.connected);
  const actions = tokenPanelActions({ role, oauthConfigured, available, connected, operator });
  // The operator's channel reads "expired" when the bot's last live check found the token dead; the button then
  // says Reconnect even though a connection is on file.
  const expired = operator && operatorState === "expired";
  const viaSecret = operator && operatorState === "connected" && !connected;
  const missing = connected && status ? missingScopes(status.scopes, requiredScopes) : [];
  const startHref = `/api/oauth/youtube/start?ref=${encodeURIComponent(channelId)}`;

  async function disconnect() {
    if (!(await confirm({ title: tt.disconnect, message: tt.confirmDisconnect, confirmLabel: tt.disconnect }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/channels/youtube-token/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel_id: channelId }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setJustDisconnected(true);
      startTransition(() => router.refresh());
    } catch {
      setError("network");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="g2-sub-block">
      <div className="g2-sub-head">
        <h4 className="g2-label">{tt.title}</h4>
        {available && (
          <StatusLamp
            tone={expired ? "fail" : connected || viaSecret ? (missing.length ? "warn" : "ok") : "idle"}
            label={
              expired
                ? tt.expired
                : connected || viaSecret
                  ? tt.connected
                  : status?.revoked_at
                    ? tt.disconnected
                    : tt.notConnected
            }
          />
        )}
      </div>

      {!available ? (
        <p className="g2-note">{tt.notAvailable}</p>
      ) : (
        <>
          {status && (
            <dl className="g2-inline-dl">
              {status.youtube_channel_title || status.youtube_channel_id ? (
                <div>
                  <dt>{tt.account}: </dt>
                  <dd>
                    {status.youtube_channel_title ?? ""}
                    {status.youtube_channel_id ? ` (${status.youtube_channel_id})` : ""}
                  </dd>
                </div>
              ) : null}
              {connected && status.connected_at && (
                <div>
                  <dt>{tt.since}: </dt>
                  <dd>{relativeTime(status.connected_at, locale)}</dd>
                </div>
              )}
              {connected && status.connected_by_email && (
                <div>
                  <dt>{tt.by}: </dt>
                  <dd>{status.connected_by_email}</dd>
                </div>
              )}
              {!connected && status.revoked_at && (
                <div>
                  <dt>{tt.disconnectedAt}: </dt>
                  <dd>{relativeTime(status.revoked_at, locale)}</dd>
                </div>
              )}
              {connected && status.scopes.length > 0 && (
                <div>
                  <dt>{tt.scopes}: </dt>
                  <dd>{status.scopes.map(shortScope).join(", ")}</dd>
                </div>
              )}
            </dl>
          )}
          {missing.length > 0 && (
            <p className="g2-warn">
              {fmt(tt.missingScopes, { scopes: missing.map(shortScope).join(", ") })}
            </p>
          )}
          {expired && (
            <p className="g2-warn" role="alert">
              {tt.expiredHint}
            </p>
          )}
          {viaSecret && <p className="g2-note">{tt.viaSecret}</p>}
          <p className="g2-note">{operator ? tt.operatorNote : tt.vaultNote}</p>

          {justDisconnected && (
            <p className="g2-note" role="status">
              {tt.disconnectedNotice}{" "}
              <a
                href={GOOGLE_PERMISSIONS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="g2-link"
              >
                {tt.googlePermissions}
              </a>
            </p>
          )}
          {error && (
            <p className="g2-fail tnum">{fmt(tt.disconnectFailed, { error })}</p>
          )}

          <div className="g2-actions">
            {actions.connect && (
              <a href={startHref} className="btn-quiet">
                {connected || expired || viaSecret ? tt.reconnect : tt.connect}
              </a>
            )}
            {actions.disconnect && (
              <button
                type="button"
                onClick={disconnect}
                disabled={busy || pending}
                className="btn-quiet disabled:opacity-50"
              >
                {busy ? tt.disconnecting : tt.disconnect}
              </button>
            )}
            {!actions.connect && !actions.disconnect && (
              <span className="g2-note">
                {atLeast(role, "admin") && !oauthConfigured ? tt.oauthNotConfigured : tt.viewerHint}
              </span>
            )}
          </div>
        </>
      )}
      {dialog}
    </div>
  );
}
