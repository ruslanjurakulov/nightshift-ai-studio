"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { StatusPill } from "@/components/ui";
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
    <section className="panel flex flex-col gap-3 p-4" aria-labelledby="social-accounts-title">
      <header>
        <h2 id="social-accounts-title" className="text-sm font-semibold">
          {ts.title}
        </h2>
        <p className="mt-1 text-[12px] text-[var(--color-muted)]">{ts.subtitle}</p>
      </header>

      {result && (
        <p
          className="text-[13px]"
          style={{ color: result.word === "connected" ? "var(--color-primary)" : "var(--color-warn, #e2a03f)" }}
          role="status"
        >
          {fmt(ts.results[result.word], { platform: name(result.platform) })}
        </p>
      )}

      {!hasOrg ? (
        <p className="text-[12px] text-[var(--color-muted)]">{ts.noOrg}</p>
      ) : !available ? (
        <p className="text-[12px] text-[var(--color-muted)]">{ts.notMigrated}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {SOCIAL_PLATFORMS.map((platform) => {
            const rows = accounts.filter((a) => a.platform === platform);
            const actions = socialPanelActions({ role, configured: configured[platform], available });
            return (
              <div
                key={platform}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3"
              >
                <div className="flex items-center gap-2">
                  <PlatformLogo platform={platform} size={18} />
                  <span className="text-[13px] font-semibold">{name(platform)}</span>
                </div>

                {rows.length === 0 ? (
                  <p className="mt-2 text-[12px] text-[var(--color-muted)]">{ts.none}</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-2">
                    {rows.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          {a.avatar_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={a.avatar_url}
                              alt=""
                              width={28}
                              height={28}
                              referrerPolicy="no-referrer"
                              className="h-7 w-7 shrink-0 rounded-full border border-[var(--color-border)] object-cover"
                            />
                          ) : (
                            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-[var(--color-border)]">
                              <PlatformLogo platform={platform} size={14} />
                            </span>
                          )}
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-[13px]">{accountLabel(a)}</span>
                              {a.status === "connected" && (
                                <CheckCircle2
                                  size={14}
                                  aria-label={ts.connected}
                                  style={{ color: "var(--color-ok)" }}
                                />
                              )}
                            </div>
                            <div className="mono text-[10px] text-[var(--color-muted)]">
                              {a.username && a.display_name ? `@${a.username} · ` : ""}
                              {a.connected_at ? fmt(ts.since, { when: relativeTime(a.connected_at) }) : ""}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusPill
                            tone={a.status === "connected" ? "ok" : a.status === "expired" ? "warn" : "fail"}
                            label={a.status === "connected" ? ts.connected : a.status === "expired" ? ts.expired : ts.error}
                          />
                          {actions.disconnect && (
                            <button
                              type="button"
                              onClick={() => disconnect(a)}
                              disabled={busy !== null || pending}
                              className="btn-sky ghost pill px-3 py-1 text-[11px] disabled:opacity-50"
                            >
                              {busy === a.id ? ts.disconnecting : ts.disconnect}
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {actions.connect ? (
                    <a href={`/api/oauth/${platform}/start`} className="btn-sky pill px-4 py-1.5 text-[12px]">
                      {rows.length ? ts.connectAnother : fmt(ts.connect, { platform: name(platform) })}
                    </a>
                  ) : !configured[platform] ? (
                    <span className="text-[11px] text-[var(--color-muted)]" title={fmt(ts.notConfiguredHint, { platform: name(platform) })}>
                      {fmt(ts.notAvailableYet, { platform: name(platform) })}
                    </span>
                  ) : (
                    <span className="text-[11px] text-[var(--color-muted)]">{ts.viewerHint}</span>
                  )}
                </div>
                {platform === "tiktok" && (
                  <p className="mt-2 text-[10px] text-[var(--color-muted)]">{ts.tiktokPrivateNote}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {available && <p className="text-[11px] text-[var(--color-muted)]">{ts.vaultNote}</p>}
      {disconnected && (
        <p className="text-[11px] text-[var(--color-fg)]" role="status">
          {ts.disconnectedNotice}{" "}
          <a
            href={PLATFORM_PERMISSIONS_URL[disconnected]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-primary)] underline"
          >
            {PLATFORM_PERMISSIONS_URL[disconnected].replace(/^https:\/\//, "")}
          </a>
        </p>
      )}
      {error && <p className="mono text-[11px] text-[var(--color-fail)]">{fmt(ts.disconnectFailed, { error })}</p>}
      {dialog}
    </section>
  );
}
