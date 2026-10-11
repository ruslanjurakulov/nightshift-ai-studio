"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
import { relativeTime } from "@/lib/format";
import type { Role } from "@/lib/auth/roles-shared";
import {
  PLATFORM_PERMISSIONS_URL,
  SOCIAL_PLATFORMS,
  accountLabel,
  socialPanelActions,
  type SocialAccount,
  type SocialPlatform,
  type SocialResult,
} from "@/lib/social-accounts";
import { PlatformLogo } from "@/components/social/PlatformLogo";

export interface SocialAccountsPanelProps {
  accounts: SocialAccount[];
  /** False when 0028 is not applied, or there is no organization. */
  available: boolean;
  hasOrg: boolean;
  role: Role;
  configured: Record<SocialPlatform, boolean>;
  /** The `?social=` result of a connect that just came back, if any. */
  result: { platform: SocialPlatform; word: SocialResult } | null;
}

/**
 * The organization's Instagram and TikTok accounts (migration 0028): avatar,
 * name and a "connected" check for each — never a token, which this page
 * cannot see — plus Connect / Disconnect for the organization's editors+.
 * When a platform's app is not configured on the deployment, its button reads
 * "not available yet" instead of starting a flow that cannot finish.
 */
export function SocialAccountsPanel({ accounts, available, hasOrg, role, configured, result }: SocialAccountsPanelProps) {
  const { t } = useI18n();
  const ts = t.socialAccounts;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState<SocialPlatform | null>(null);
  const { confirm, dialog } = useConfirm();

  const name = (p: SocialPlatform) => (p === "instagram" ? ts.instagram : ts.tiktok);

  async function disconnect(account: SocialAccount) {
    if (!(await confirm({ title: ts.disconnect, message: ts.confirmDisconnect, confirmLabel: ts.disconnect }))) return;
    setBusy(account.id);
    setError(null);
    try {
      const res = await fetch("/api/social-accounts/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: account.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setDisconnected(account.platform);
      startTransition(() => router.refresh());
    } catch {
      setError("network");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="g2-section" aria-labelledby="social-accounts-title">
      <header>
        <h2 id="social-accounts-title" className="g2-h2">
          {ts.title}
        </h2>
        <p className="g2-sub">{ts.subtitle}</p>
      </header>

      {result && (
        <p
          className={result.word === "connected" ? "g2-ok" : "g2-warn"}
          role="status"
        >
          {fmt(ts.results[result.word], { platform: name(result.platform) })}
        </p>
      )}

      {!hasOrg ? (
        <p className="g2-note">{ts.noOrg}</p>
      ) : !available ? (
        <p className="g2-note">{ts.notMigrated}</p>
      ) : (
        <div className="g2-platforms">
          {SOCIAL_PLATFORMS.map((platform) => {
            const rows = accounts.filter((a) => a.platform === platform);
            const actions = socialPanelActions({ role, configured: configured[platform], available });
            return (
              <div key={platform} className="g2-platform">
                <div className="g2-platform-name">
                  <PlatformLogo platform={platform} size={20} />
                  <h3 className="g2-h3">{name(platform)}</h3>
                </div>

                {rows.length === 0 ? (
                  <p className="g2-note">{ts.none}</p>
                ) : (
                  <ul className="g2-accounts">
                    {rows.map((a) => (
                      <li key={a.id}>
                        <div className="flex min-w-0 items-center gap-3">
                          {a.avatar_url ? (
                            <span className="g2-avatar">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={a.avatar_url} alt="" width={32} height={32} referrerPolicy="no-referrer" />
                            </span>
                          ) : (
                            <span className="g2-avatar">
                              <PlatformLogo platform={platform} size={16} />
                            </span>
                          )}
                          <div className="min-w-0">
                            <div className="truncate text-[0.9375rem] font-medium text-[var(--color-fg)]">{accountLabel(a)}</div>
                            <div className="tnum text-[13px] text-[var(--color-muted)]">
                              {a.username && a.display_name ? `@${a.username} · ` : ""}
                              {a.connected_at ? fmt(ts.since, { when: relativeTime(a.connected_at) }) : ""}
                            </div>
                          </div>
                        </div>
                        <div className="g2-actions">
                          <StatusLamp
                            tone={a.status === "connected" ? "ok" : a.status === "expired" ? "warn" : "fail"}
                            label={a.status === "connected" ? ts.connected : a.status === "expired" ? ts.expired : ts.error}
                          />
                          {actions.disconnect && (
                            <button
                              type="button"
                              onClick={() => disconnect(a)}
                              disabled={busy !== null || pending}
                              className="btn-quiet disabled:opacity-50"
                            >
                              {busy === a.id ? ts.disconnecting : ts.disconnect}
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="g2-actions">
                  {actions.connect ? (
                    <a href={`/api/oauth/${platform}/start`} className="btn-quiet">
                      {rows.length ? ts.connectAnother : fmt(ts.connect, { platform: name(platform) })}
                    </a>
                  ) : !configured[platform] ? (
                    <span className="g2-note" title={fmt(ts.notConfiguredHint, { platform: name(platform) })}>
                      {fmt(ts.notAvailableYet, { platform: name(platform) })}
                    </span>
                  ) : (
                    <span className="g2-note">{ts.viewerHint}</span>
                  )}
                </div>
                {platform === "tiktok" && <p className="g2-note">{ts.tiktokPrivateNote}</p>}
              </div>
            );
          })}
        </div>
      )}

      {available && <p className="g2-note">{ts.vaultNote}</p>}
      {disconnected && (
        <p className="g2-note" role="status">
          {ts.disconnectedNotice}{" "}
          <a
            href={PLATFORM_PERMISSIONS_URL[disconnected]}
            target="_blank"
            rel="noopener noreferrer"
            className="g2-link"
          >
            {PLATFORM_PERMISSIONS_URL[disconnected].replace(/^https:\/\//, "")}
          </a>
        </p>
      )}
      {error && <p className="g2-fail tnum">{fmt(ts.disconnectFailed, { error })}</p>}
      {dialog}
    </section>
  );
}
