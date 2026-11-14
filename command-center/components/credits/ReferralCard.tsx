"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy, Send, Share2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { copyText } from "@/lib/feedback";
import { coerceMyInvite, inviteUrl } from "@/lib/friend-invites";
import { hasReferrals, telegramShareUrl, type MyReferrals } from "@/lib/referrals";
import { REFERRAL_PATH } from "@/lib/public-paths";

/**
 * "Invite friends" on the Credits page (migration 0165): the person's link, Copy / Share / Telegram, the reward terms in one
 * line, and their own referrals as the database counts them — joined, qualified, pending, credits earned.
 *
 * Every number is the database's (claim_referral_rewards(), read server-side in the member's own session). A referral on hold
 * shows as "pending" with the date its hold ends, never as credits: it is not earned until the payment can no longer be
 * refunded. Nothing here grants, settles or spends: the only write is create_friend_invite(), which makes the link (0092).
 */
export function ReferralCard({ referrals, orgId }: { referrals: MyReferrals; orgId: string }) {
  const { t, locale } = useI18n();
  const c = t.referral;
  const [state, setState] = useState(referrals);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(false);
  const [origin, setOrigin] = useState("");
  const [canShare, setCanShare] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const field = useRef<HTMLTextAreaElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setState(referrals), [referrals]);
  useEffect(() => {
    setOrigin(window.location.origin);
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);
  useEffect(() => () => void (copyTimer.current && clearTimeout(copyTimer.current)), []);

  const url = state.link && origin ? inviteUrl(origin, state.link.token) : "";

  async function create() {
    const supabase = createClient();
    if (!supabase || busy) return;
    setBusy(true);
    setProblem(false);
    const { data, error } = await supabase.rpc("create_friend_invite", { p_org: orgId });
    setBusy(false);
    // create_friend_invite answers 0092's shape; only its link is taken. A new link has no referrals yet.
    const link = error ? null : (coerceMyInvite(data)?.link ?? null);
    if (!link) {
      setProblem(true);
      return;
    }
    setState((s) => ({ ...s, link }));
  }

  async function onCopy() {
    if (!url) return;
    let ok = await copyText(url, typeof navigator !== "undefined" ? navigator.clipboard : null);
    if (!ok && field.current) {
      // No async clipboard (plain http, an in-app browser): select the text and use the old command.
      try {
        field.current.focus();
        field.current.select();
        field.current.setSelectionRange(0, url.length);
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
    }
    setCopy(ok ? "copied" : "failed");
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopy("idle"), 2500);
  }

  async function onShare() {
    if (!url || !canShare) return;
    try {
      await navigator.share({ title: c.title, text: c.shareText, url });
    } catch {
      /* the person closed the share sheet: nothing to say */
    }
  }

  const termsLine = fmt(c.terms, {
    credits: formatCredits(state.credits, locale),
    min: formatCredits(state.minCredits, locale),
    hold: state.holdDays,
    cap: state.monthlyCap,
  });
  const qualified = state.held + state.paid;
  const next = state.nextReleaseOn;
  const waiting = state.held - state.due;

  return (
    <section id="invite" className="panel flex scroll-mt-7 flex-col gap-4 p-5 sm:p-6" aria-labelledby="invite-title" data-referral-card>
      <div className="flex flex-col gap-1">
        <h2 id="invite-title" className="t-section">
          {c.title}
        </h2>
        <p className="max-w-[64ch] text-sm leading-relaxed text-[var(--color-muted)]" data-referral-terms>
          {termsLine}{" "}
          <Link href={REFERRAL_PATH} className="tap-link text-[var(--color-primary)] underline underline-offset-2">
            {c.termsLink}
          </Link>
        </p>
      </div>

      {!state.link ? (
        <div className="flex flex-col items-start gap-2">
          <button type="button" onClick={create} disabled={busy || !state.enabled} className="btn-quiet min-h-11 px-5 text-sm disabled:opacity-40">
            {busy ? c.creating : c.create}
          </button>
          {!state.enabled && <p className="text-xs text-[var(--color-muted)]">{c.closedShort}</p>}
          {problem && (
            <p role="alert" className="text-xs" style={{ color: "var(--color-fail)" }}>
              {c.createFailed}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="invite-link" className="text-xs text-[var(--color-muted)]">
              {c.linkLabel}
            </label>
            {/* The whole link stays readable: it wraps over two or three lines on a phone, and the buttons sit under it. */}
            <textarea
              id="invite-link"
              ref={field}
              readOnly
              rows={2}
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="mono min-h-11 min-w-0 resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base leading-snug text-[var(--color-fg)] outline-none [overflow-wrap:anywhere] focus:border-[var(--color-primary)] sm:text-sm"
            />
            <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
              <button
                type="button"
                onClick={onCopy}
                disabled={!url}
                className="btn-quiet inline-flex min-h-12 items-center justify-center gap-2 px-4 text-sm disabled:opacity-40 sm:min-w-[7.5rem]"
              >
                {copy === "copied" ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
                {copy === "copied" ? c.copied : c.copy}
              </button>
              {canShare && (
                <button
                  type="button"
                  onClick={onShare}
                  disabled={!url}
                  className="btn-quiet inline-flex min-h-12 items-center justify-center gap-2 px-4 text-sm disabled:opacity-40"
                  data-referral-share
                >
                  <Share2 aria-hidden className="size-4" />
                  {c.share}
                </button>
              )}
              {url && (
                <a
                  href={telegramShareUrl(url, c.shareText)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-quiet inline-flex min-h-12 items-center justify-center gap-2 px-4 text-sm"
                  data-referral-telegram
                >
                  <Send aria-hidden className="size-4" />
                  {c.telegram}
                </a>
              )}
            </div>
            <p role="status" aria-live="polite" className="min-h-[1.1em] text-xs" style={{ color: copy === "failed" ? "var(--color-fail)" : "var(--color-ok)" }}>
              {copy === "copied" ? c.copied : copy === "failed" ? c.copyFailed : ""}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-xs text-[var(--color-muted)]">{c.statsLabel}</h3>
            <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-referral-stats>
              <Stat label={c.joined} hint={c.joinedHint} value={String(state.joined)} />
              <Stat label={c.qualified} hint={c.qualifiedHint} value={String(qualified)} />
              <Stat label={c.pending} hint={c.pendingHint} value={state.held > 0 ? String(state.held) : c.pendingNone} />
              <Stat label={c.earned} hint={state.org ? fmt(c.earnedHint, { workspace: state.org.name }) : ""} value={formatCredits(state.earned, locale)} />
            </dl>
            {!hasReferrals(state) ? (
              <p className="text-sm text-[var(--color-muted)]" data-referral-empty>
                {c.empty}
              </p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm text-[var(--color-fg)]" data-referral-notes>
                {waiting > 0 && next && <li>{fmt(c.heldUntil, { n: waiting, date: next })}</li>}
                {state.due > 0 && <li>{fmt(c.heldDue, { n: state.due })}</li>}
                {state.paidThisMonth > 0 && <li>{fmt(c.monthUsed, { n: state.paidThisMonth, cap: state.monthlyCap })}</li>}
                {state.clawed > 0 && <li>{fmt(c.clawed, { n: state.clawed, credits: formatCredits(state.clawedCredits, locale) })}</li>}
                {state.clawOwed > 0 && <li>{fmt(c.clawOwed, { credits: formatCredits(state.clawOwed, locale) })}</li>}
                {state.void > 0 && <li className="text-[var(--color-muted)]">{fmt(c.void, { n: state.void })}</li>}
              </ul>
            )}
            {state.milestoneCredits !== null && state.milestoneCredits > 0 && (
              <p className="text-xs text-[var(--color-muted)]">{fmt(c.milestone, { credits: formatCredits(state.milestoneCredits, locale) })}</p>
            )}
          </div>
          {!state.enabled && <p className="text-sm text-[var(--color-muted)]">{c.closed}</p>}
        </>
      )}

      <p className="max-w-[64ch] text-xs leading-relaxed text-[var(--color-muted)]">{c.notTracked}</p>
    </section>
  );
}

function Stat({ label, hint, value }: { label: string; hint: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-[var(--color-border)] p-3">
      <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
      <dd className="tnum text-lg text-[var(--color-fg)]">{value}</dd>
      {hint && <dd className="text-[0.7rem] leading-snug text-[var(--color-muted)]">{hint}</dd>}
    </div>
  );
}

/** While the Credits page settles and reads the person's referrals (the claim runs in the database). */
export function ReferralCardSkeleton() {
  const { t } = useI18n();
  return (
    <section id="invite" className="panel flex scroll-mt-7 flex-col gap-4 p-5 sm:p-6" aria-labelledby="invite-title" aria-busy="true" data-referral-loading>
      <h2 id="invite-title" className="t-section">
        {t.referral.title}
      </h2>
      <p role="status" className="text-sm text-[var(--color-muted)]">
        {t.referral.loading}
      </p>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[4.5rem] animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]" />
        ))}
      </div>
    </section>
  );
}
