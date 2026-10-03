"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { copyText } from "@/lib/feedback";
import { coerceMyInvite, inviteBlock, inviteUrl, type MyInvite } from "@/lib/friend-invites";
import { Meter } from "@/components/ui/Meter";

/**
 * "Invite friends" on the Credits page (migration 0092): one link per person,
 * and the person is paid once when enough new, e-mail-confirmed friends have
 * joined through it.
 *
 * Everything shown is what the database says about the caller's own link:
 * counts only — never who joined. The link is made by create_friend_invite()
 * (refused while the operator's switch is off, so the button says why instead
 * of failing); a reward that is earned but waiting for room today is claimed
 * here, once, on load.
 */
export function InviteFriendsCard({ invite, orgId }: { invite: MyInvite; orgId: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [state, setState] = useState(invite);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<"create" | null>(null);
  const [origin, setOrigin] = useState("");
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const field = useRef<HTMLTextAreaElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const c = t.invite;

  useEffect(() => setState(invite), [invite]);
  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => () => void (copyTimer.current && clearTimeout(copyTimer.current)), []);

  // Earned but not yet paid (the day's cap was full, or the switch was off):
  // ask once on load; the database pays only if there is room now.
  const asked = useRef(false);
  useEffect(() => {
    if (!state.pending || asked.current) return;
    asked.current = true;
    const supabase = createClient();
    if (!supabase) return;
    void (async () => {
      const { data } = await supabase.rpc("claim_friend_invite_reward");
      const next = coerceMyInvite(data);
      if (next) {
        setState(next);
        if (next.paid) router.refresh();
      }
    })();
  }, [state.pending, router]);

  async function create() {
    const supabase = createClient();
    if (!supabase || busy) return;
    setBusy(true);
    setProblem(null);
    const { data, error } = await supabase.rpc("create_friend_invite", { p_org: orgId });
    setBusy(false);
    const next = error ? null : coerceMyInvite(data);
    if (!next) {
      setProblem("create");
      return;
    }
    setState(next);
  }

  const url = state.link ? inviteUrl(origin || "", state.link.token) : "";

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

  const credits = formatCredits(state.reward, locale);
  const block = inviteBlock(state);
  const progress = fmt(c.progress, { joined: state.joined, required: state.required });

  return (
    <section id="invite" className="panel flex scroll-mt-24 flex-col gap-4 p-5 sm:p-6" aria-labelledby="invite-title" data-invite-card>
      <div className="flex flex-col gap-1">
        <h2 id="invite-title" className="t-section">
          {c.title}
        </h2>
        <p className="max-w-[60ch] text-sm leading-relaxed text-[var(--color-muted)]">
          {fmt(c.offer, { required: state.required, credits })}
        </p>
      </div>

      {!state.link ? (
        <div className="flex flex-col items-start gap-2">
          <button type="button" onClick={create} disabled={busy || block !== null} className="btn-primary min-h-11 px-5 text-sm disabled:opacity-40">
            {busy ? c.creating : c.create}
          </button>
          {block === "off" && <p className="text-xs text-[var(--color-muted)]">{c.closed}</p>}
          {problem === "create" && (
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
            {/* The whole link stays readable: it wraps over two or three lines (a one-line field showed
                only the first ~20 characters on a phone), and Copy sits under it full width. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
              <textarea
                id="invite-link"
                ref={field}
                readOnly
                rows={3}
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="tnum min-h-11 min-w-0 flex-1 resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-snug text-[var(--color-fg)] outline-none [overflow-wrap:anywhere] focus:border-[var(--color-primary)]"
              />
              <button
                type="button"
                onClick={onCopy}
                disabled={!url}
                className="btn-primary inline-flex min-h-12 w-full shrink-0 items-center justify-center gap-2 px-4 text-sm disabled:opacity-40 sm:w-auto sm:min-w-[7.5rem]"
              >
                {copy === "copied" ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
                {copy === "copied" ? c.copied : c.copy}
              </button>
            </div>
            <p role="status" aria-live="polite" className="min-h-[1.1em] text-xs" style={{ color: copy === "failed" ? "var(--color-fail)" : "var(--color-ok)" }}>
              {copy === "copied" ? c.copied : copy === "failed" ? c.copyFailed : ""}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs text-[var(--color-muted)]">{c.progressLabel}</span>
            <Meter className="invite-meter" value={state.joined} held={0} max={state.required} segments={Math.min(state.required, 20)} size="lg" label={c.progressLabel} valueText={progress} />
            <p className="text-sm text-[var(--color-fg)]" data-invite-progress>
              {progress}
            </p>
          </div>

          {state.paid ? (
            <p className="text-sm" style={{ color: "var(--color-ok)" }} data-invite-earned>
              {fmt(c.earned, { credits: formatCredits(state.creditsPaid ?? state.reward, locale) })}{" "}
              <span className="text-[var(--color-muted)]">{c.earnedNote}</span>
            </p>
          ) : state.pending ? (
            <p className="text-sm text-[var(--color-muted)]" data-invite-pending>
              {fmt(c.pending, { credits })}
            </p>
          ) : !state.enabled ? (
            <p className="text-sm text-[var(--color-muted)]">{c.paused}</p>
          ) : null}
        </>
      )}

      <p className="max-w-[60ch] text-xs leading-relaxed text-[var(--color-muted)]">{c.rules}</p>
    </section>
  );
}
