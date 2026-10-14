"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { ChannelMark } from "@/components/channels/ChannelMark";
import { PlatformLogo } from "@/components/social/PlatformLogo";
import {
  PICK_FLAG,
  candidateAction,
  formatCount,
  type ConfirmResult,
  type PickView,
  type YoutubeCandidateView,
} from "@/lib/connect-picker";

/**
 * The screen after the platform's own sign-in: choose the account to add.
 *
 * It holds no token and no pending id: the server keeps the authorisation, and
 * a press sends only WHICH listed account is meant. The server checks that id
 * against the list it holds, so a channel that was not offered cannot be
 * chosen from here whatever the page says.
 *
 * `view` is null when nothing is waiting (expired, another account, a refresh
 * after finishing): the page then says so and points back, never a dead end.
 */
export function ConnectPicker({ view }: { view: PickView | null }) {
  const { t, locale } = useI18n();
  const tc = t.connectPicker;
  const tp = tc.pick;
  const router = useRouter();
  const path = useChannelPath();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ConfirmResult | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const addPath = path("/channels/new");

  if (!view) {
    return (
      <section className="ns-desk g2-desk g2-connect" aria-labelledby="connect-pick-title">
        <h2 id="connect-pick-title" className="g2-h2">
          {tp.expiredTitle}
        </h2>
        <p className="g2-note">{tp.expiredBody}</p>
        <Link href={addPath} className="btn-primary w-fit">
          {tp.startAgain}
        </Link>
      </section>
    );
  }

  async function confirm(key: string, body: Record<string, string>) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/connect/pending", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "confirm", ...body }),
      });
      const data = (await res.json().catch(() => ({}))) as { result?: ConfirmResult };
      const result = data.result;
      if (result === "connected") {
        router.push(
          body.platform === "youtube"
            ? `${path("/channels")}?yt=connected`
            : `${path("/channels")}?social=connected&platform=${encodeURIComponent(body.platform ?? "")}`,
        );
        return;
      }
      if (result === "created_not_connected") {
        // The channel exists, so a second press must not create another.
        setError(result);
        router.push(`${path("/channels")}?yt=failed`);
        return;
      }
      setError(result ?? "failed");
    } catch {
      setError("failed");
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setCancelling(true);
    try {
      await fetch("/api/connect/pending", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
    } catch {
      /* the record expires by itself */
    }
    router.push(addPath);
  }

  const errorLine = error ? <p className="g2-fail" role="alert">{tp.errors[error as keyof typeof tp.errors] ?? tp.errors.failed}</p> : null;
  const actions = (platform: "youtube" | "instagram" | "tiktok", again: string) => (
    <div className="g2-actions">
      <a href={`/api/oauth/${platform}/start?${PICK_FLAG}=1`} className="btn-quiet">
        {again}
      </a>
      <button type="button" onClick={cancel} disabled={cancelling || busy !== null} className="btn-quiet disabled:opacity-50">
        {cancelling ? tp.cancelling : tp.cancel}
      </button>
    </div>
  );

  if (view.platform === "youtube") {
    return (
      <section className="ns-desk g2-desk g2-connect" aria-labelledby="connect-pick-title">
        <header>
          <h2 id="connect-pick-title" className="g2-h2">
            {tp.youtubeTitle}
          </h2>
          <p className="g2-sub">{tp.youtubeLead}</p>
        </header>

        <ul className="g2-pick-list" aria-label={tp.listLabel}>
          {view.candidates.map((c) => (
            <CandidateRow
              key={c.id}
              c={c}
              locale={locale}
              busy={busy}
              disabled={busy !== null}
              onPick={() => confirm(c.id, { platform: "youtube", channel_id: c.id })}
              managePath={path("/channels")}
            />
          ))}
        </ul>

        <p className="g2-note">{tp.brandHint}</p>
        {errorLine}
        {actions("youtube", tp.anotherGoogle)}
      </section>
    );
  }

  const platform = view.platform;
  const platformName = platform === "instagram" ? tc.instagram : tc.tiktok;
  const a = view.account;
  return (
    <section className="ns-desk g2-desk g2-connect" aria-labelledby="connect-pick-title">
      <header>
        <h2 id="connect-pick-title" className="g2-h2">
          {fmt(tp.socialTitle, { platform: platformName })}
        </h2>
        <p className="g2-sub">{tp.socialLead}</p>
      </header>

      <div className="g2-pick-row">
        <ChannelMark name={a.name} thumbnail={a.avatarUrl} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <PlatformLogo platform={platform} size={16} />
            <span className="truncate text-[17px] font-semibold">{a.name}</span>
          </div>
          {a.username && <div className="tnum truncate text-[13px] text-[var(--color-muted)]">@{a.username}</div>}
        </div>
        <button
          type="button"
          className="btn-primary g2-pick-btn"
          disabled={busy !== null}
          onClick={() => confirm(a.externalId, { platform })}
        >
          {busy ? tp.connecting : a.connected ? tp.reconnect : tp.confirm}
        </button>
      </div>

      {a.connected && <p className="g2-note">{tp.socialAlready}</p>}
      <p className="g2-note">{fmt(tp.switchHint, { platform: platformName })}</p>
      {errorLine}
      {actions(platform, fmt(tp.anotherAccount, { platform: platformName }))}
    </section>
  );
}

function CandidateRow({
  c,
  locale,
  busy,
  disabled,
  onPick,
  managePath,
}: {
  c: YoutubeCandidateView;
  locale: string;
  busy: string | null;
  disabled: boolean;
  onPick: () => void;
  managePath: string;
}) {
  const { t } = useI18n();
  const tp = t.connectPicker.pick;
  const subs = formatCount(c.subscribers, locale);
  const vids = formatCount(c.videos, locale);
  const state = candidateAction(c);
  return (
    <li className="g2-pick-row" data-state={state}>
      <ChannelMark name={c.title} thumbnail={c.thumbnail} />
      <div className="min-w-0">
        <div className="truncate text-[17px] font-semibold">{c.title}</div>
        <div className="tnum truncate text-[13px] text-[var(--color-muted)]">
          {[c.handle, subs === null ? tp.subscribersHidden : fmt(tp.subscribers, { n: subs }), vids === null ? null : fmt(tp.videos, { n: vids })]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {c.linkedTo && <div className="g2-ok mt-1">{tp.alreadyConnected} · {fmt(tp.linkedAs, { name: c.linkedTo.name })}</div>}
      </div>
      {state === "connected" ? (
        <Link href={managePath} className="btn-quiet g2-pick-btn">
          {tp.openChannels}
        </Link>
      ) : (
        <button type="button" className="btn-primary g2-pick-btn" disabled={disabled} onClick={onPick}>
          {busy === c.id ? tp.connecting : tp.useChannel}
        </button>
      )}
    </li>
  );
}

