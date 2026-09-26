"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { StatusPill } from "@/components/ui";
import { relativeTime } from "@/lib/format";
import { atLeast, type Role } from "@/lib/auth/roles-shared";
import {
  GOOGLE_PERMISSIONS_URL,
  missingScopes,
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
}: ChannelTokenPanelProps) {
  const { t } = useI18n();
  const tt = t.channelTokens;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justDisconnected, setJustDisconnected] = useState(false);

  const connected = Boolean(status?.connected);
  const actions = tokenPanelActions({ role, oauthConfigured, available, connected });
  const missing = connected && status ? missingScopes(status.scopes, requiredScopes) : [];
  const startHref = `/api/oauth/youtube/start?ref=${encodeURIComponent(channelId)}`;

  async function disconnect() {
    if (!window.confirm(tt.confirmDisconnect)) return;
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
    <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">{tt.title}</span>
        {available && (
          <StatusPill
            tone={connected ? (missing.length ? "warn" : "ok") : "idle"}
            label={connected ? tt.connected : status?.revoked_at ? tt.disconnected : tt.notConnected}
          />
        )}
      </div>

      {!available ? (
        <p className="mt-2 text-[11px] text-[var(--color-muted)]">{tt.notAvailable}</p>
      ) : (
        <>
          {status && (
            <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 mono text-[10px] text-[var(--color-muted)]">
              {status.youtube_channel_title || status.youtube_channel_id ? (
                <div>
                  <dt className="inline">{tt.account}: </dt>
                  <dd className="inline text-[var(--color-fg)]">
                    {status.youtube_channel_title ?? ""}
                    {status.youtube_channel_id ? ` (${status.youtube_channel_id})` : ""}
                  </dd>
                </div>
              ) : null}
              {connected && status.connected_at && (
                <div>
                  <dt className="inline">{tt.since}: </dt>
                  <dd className="inline text-[var(--color-fg)]">{relativeTime(status.connected_at)}</dd>
                </div>
              )}
              {connected && status.connected_by_email && (
                <div>
                  <dt className="inline">{tt.by}: </dt>
                  <dd className="inline text-[var(--color-fg)]">{status.connected_by_email}</dd>
                </div>
              )}
              {!connected && status.revoked_at && (
                <div>
                  <dt className="inline">{tt.disconnectedAt}: </dt>
                  <dd className="inline text-[var(--color-fg)]">{relativeTime(status.revoked_at)}</dd>
                </div>
              )}
              {connected && status.scopes.length > 0 && (
                <div>
                  <dt className="inline">{tt.scopes}: </dt>
                  <dd className="inline text-[var(--color-fg)]">{status.scopes.map(shortScope).join(", ")}</dd>
                </div>
              )}
            </dl>
          )}
          {missing.length > 0 && (
            <p className="mt-1.5 text-[11px] text-[var(--color-warn)]">
              {fmt(tt.missingScopes, { scopes: missing.map(shortScope).join(", ") })}
            </p>
          )}
          <p className="mt-1.5 text-[11px] text-[var(--color-muted)]">{tt.vaultNote}</p>

          {justDisconnected && (
            <p className="mt-2 text-[11px] text-[var(--color-fg)]" role="status">
              {tt.disconnectedNotice}{" "}
              <a
                href={GOOGLE_PERMISSIONS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-primary)] underline"
              >
                {tt.googlePermissions}
              </a>
            </p>
          )}
          {error && (
            <p className="mt-2 mono text-[11px] text-[var(--color-fail)]">{fmt(tt.disconnectFailed, { error })}</p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {actions.connect && (
              <a href={startHref} className="btn-sky pill px-4 py-1.5 text-[12px]">
                {connected ? tt.reconnect : tt.connect}
              </a>
            )}
            {actions.disconnect && (
              <button
                type="button"
                onClick={disconnect}
                disabled={busy || pending}
                className="btn-sky ghost pill px-4 py-1.5 text-[12px] disabled:opacity-50"
              >
                {busy ? tt.disconnecting : tt.disconnect}
              </button>
            )}
            {!actions.connect && !actions.disconnect && (
              <span className="text-[11px] text-[var(--color-muted)]">
                {atLeast(role, "admin") && !oauthConfigured ? tt.oauthNotConfigured : tt.viewerHint}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
