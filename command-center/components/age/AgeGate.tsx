"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { Button } from "@/components/ds/Button";
import { coerceAgeState, type AgeState } from "@/lib/age";
import { useChannelPath } from "@/lib/channels-client";

const BOX = "flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4";

/**
 * Asked once, of an account with no 18+ record (0192): at /welcome and on the first visit to Create. The answer is the
 * person's own statement, written by the database for them only and never edited, so the screen says what each answer
 * means BEFORE it is given, and "under 18" (which ends creating on this account) asks once more before it is sent.
 * An unknown state draws nothing: the page never stops anyone on a failed read; the database still refuses.
 *
 * Focus is never dropped: the keys stay focusable while saving (the design system's Button uses aria-disabled), and the
 * result (a saved confirmation, or the notice) takes focus and is announced from a region that was already mounted.
 */
export function AgeGate({
  state,
  from,
  contactEmail = null,
  home = false,
  onDone,
}: {
  state: AgeState;
  from: "welcome" | "create";
  /** Where "contact support" goes (lib/legal LEGAL.contactEmail); null: the notice says to use the site's contact page. */
  contactEmail?: string | null;
  /** Offer a way back to Home from the notice (inside the app, where the channel path exists). */
  home?: boolean;
  onDone?: (s: AgeState) => void;
}) {
  const { t } = useI18n();
  const a = t.age;
  const router = useRouter();
  const titleId = useId();
  const [now, setNow] = useState<AgeState>(state);
  const [pressed, setPressed] = useState<"adult" | "minor" | null>(null);
  const [confirmingMinor, setConfirmingMinor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedRef = useRef<HTMLParagraphElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const underRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (saved) savedRef.current?.focus();
  }, [saved]);
  useEffect(() => {
    if (confirmingMinor) backRef.current?.focus();
  }, [confirmingMinor]);

  if (now === "minor") return <MinorNotice contactEmail={contactEmail} home={home} focusOnMount={pressed === "minor"} />;
  if (now !== "none" && !saved) return null;

  async function answer(adult: boolean) {
    if (pressed) return;
    setPressed(adult ? "adult" : "minor");
    setError(null);
    try {
      const res = await fetch("/api/account/age", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adult, from }),
      });
      const body = (await res.json().catch(() => ({}))) as { state?: unknown; error?: unknown };
      if (!res.ok) {
        setError(body.error === "age_unavailable" ? a.unavailable : a.failed);
        setPressed(null);
        return;
      }
      const next = coerceAgeState(body);
      if (next === "adult") setSaved(true);
      setNow(next);
      onDone?.(next);
      // The model list's "for adults only" locks are drawn on the server: read the page again.
      router.refresh();
    } catch {
      setError(a.failed);
      setPressed(null);
    }
  }

  return (
    <section aria-labelledby={titleId} className={BOX} data-testid="age-gate">
      <h2 id={titleId} className="m-0 text-base font-semibold text-[var(--color-fg)]">
        {a.title}
      </h2>
      {/* Mounted from the first frame, so the outcome is announced when it is written into it. */}
      <p ref={savedRef} tabIndex={-1} role="status" className="m-0 text-sm text-[var(--color-fg)] outline-none empty:hidden" data-testid="age-saved">
        {saved ? a.done : ""}
      </p>
      {!saved && (
        <>
          <p className="m-0 text-sm text-[var(--color-muted)]">{a.body}</p>
          <p className="m-0 text-sm text-[var(--color-muted)]">{a.consequence}</p>
          {confirmingMinor ? (
            <div className="flex flex-col gap-2" data-testid="age-under-confirm">
              <p className="m-0 text-sm font-medium text-[var(--color-fg)]">{a.underSure}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  ref={backRef}
                  variant="primary"
                  onClick={() => {
                    setConfirmingMinor(false);
                    requestAnimationFrame(() => underRef.current?.focus());
                  }}
                >
                  {a.goBack}
                </Button>
                <Button variant="secondary" loading={pressed === "minor"} busyLabel={a.saving} onClick={() => answer(false)}>
                  {a.underConfirm}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={pressed === "adult"} busyLabel={a.saving} onClick={() => answer(true)} data-testid="age-confirm">
                {a.confirm}
              </Button>
              <Button ref={underRef} variant="secondary" onClick={() => setConfirmingMinor(true)} data-testid="age-under">
                {a.under}
              </Button>
            </div>
          )}
          <p className="m-0 text-xs text-[var(--color-muted)]">{a.legal}</p>
        </>
      )}
      <p role="alert" className="m-0 text-sm text-[var(--color-warn)] empty:hidden">
        {error ?? ""}
      </p>
    </section>
  );
}

export function MinorNotice({
  contactEmail = null,
  home = false,
  focusOnMount = false,
}: {
  contactEmail?: string | null;
  home?: boolean;
  focusOnMount?: boolean;
}) {
  const { t } = useI18n();
  const path = useChannelPath();
  const id = useId();
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) head.current?.focus();
  }, [focusOnMount]);
  return (
    <section aria-labelledby={id} className={BOX} data-tone="minor" data-testid="age-minor">
      <h2 ref={head} id={id} tabIndex={-1} className="m-0 text-base font-semibold text-[var(--color-fg)] outline-none">
        {t.age.minorTitle}
      </h2>
      <p className="m-0 text-sm text-[var(--color-muted)]">{t.age.minorBody}</p>
      <p className="m-0 text-sm text-[var(--color-muted)]">
        {contactEmail ? (
          <a href={`mailto:${contactEmail}`} className="tap-link text-[var(--color-primary)] underline">
            {t.age.contact}
          </a>
        ) : (
          t.age.contactNoEmail
        )}
      </p>
      {home && (
        <Link href={path("/home")} className="tap-link self-start text-sm text-[var(--color-primary)]">
          {t.age.home}
        </Link>
      )}
    </section>
  );
}
