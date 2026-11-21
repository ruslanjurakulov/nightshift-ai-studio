"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { copyText } from "@/lib/feedback";
import { useToast } from "@/components/feedback/ToastProvider";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { Skeleton } from "@/components/feedback/Skeleton";
import { StateBlock } from "@/components/states/StateBlock";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
import { needsStepUp, normalizeAal, type AalLevel } from "@/lib/security/aal";

/**
 * Two-factor authentication (TOTP).
 *
 * A signed-in user enrols and manages a second factor entirely through the
 * browser Supabase client's `auth.mfa.*` API — there is no application table:
 * Supabase Auth stores the factors. Enrolment returns a QR code (an SVG data
 * URL) plus a manual-entry secret for the user's own authenticator app; the
 * user then confirms a 6-digit code (challenge → verify) and the factor becomes
 * verified. The secret shown here is the user's own factor seed, not an app
 * secret, so displaying it to them is expected.
 *
 * This board delivers enrolment and management. The code is asked at sign-in by
 * the application (/login/verify, the middleware and the operator guards,
 * docs/security/ADMIN_MFA.md); it is NOT a Supabase project policy, so removing
 * the last factor here really does turn the second step off for the account.
 *
 * Reading and removing are kept honest. A factor list that could not be read is
 * "could not read", never "no authenticators" (on a security screen an empty
 * list reads as "you are unprotected"). Removing a factor names it, and
 * removing the LAST verified one asks for a word to be typed, because it leaves
 * the password as the only protection. A started enrolment can be cancelled (the
 * unfinished factor is removed), and on the phone that holds the authenticator
 * the otpauth link opens it directly, since a QR code cannot be scanned from the
 * screen it is shown on.
 */
type Factor = {
  id: string;
  friendlyName: string | null;
  status: "verified" | "unverified";
};

type Enrollment = {
  factorId: string;
  qrCode: string;
  secret: string;
  /** otpauth://totp/… — opens an authenticator app installed on this device. */
  uri: string;
};

export function SecurityBoard() {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const busyLock = useRef(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [aal, setAal] = useState<AalLevel | null>(null);

  const [friendlyName, setFriendlyName] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");

  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const supabase = createClient();
    if (!supabase) {
      setConfigured(false);
      setFactors([]);
      return;
    }
    const [listRes, aalRes] = await Promise.all([
      supabase.auth.mfa.listFactors(),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    // A failed read is not an empty list: say so, and keep what we cannot know unknown.
    if (listRes.error || !listRes.data) {
      setLoadFailed(true);
      setFactors(null);
    } else {
      setLoadFailed(false);
      setFactors(
        listRes.data.all.map((f) => ({
          id: f.id,
          friendlyName: f.friendly_name ?? null,
          status: f.status === "verified" ? "verified" : "unverified",
        })),
      );
    }
    setAal(aalRes.error ? null : normalizeAal(aalRes.data?.currentLevel));
  }

  useEffect(() => {
    load();
  }, []);

  async function startEnroll() {
    const supabase = createClient();
    if (!supabase || busyLock.current) return;
    busyLock.current = true;
    setBusy(true);
    setError(null);
    const { data, error: e } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: friendlyName.trim() || undefined,
    });
    busyLock.current = false;
    setBusy(false);
    if (e || !data) {
      setError(t.security.enrollFailed);
      return;
    }
    setEnrollment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri });
    setCode("");
  }

  async function verify() {
    const supabase = createClient();
    if (!supabase || !enrollment || busyLock.current) return;
    const trimmed = code.trim();
    if (trimmed.length < 6) return;
    busyLock.current = true;
    setBusy(true);
    setError(null);
    const challenge = await supabase.auth.mfa.challenge({ factorId: enrollment.factorId });
    if (challenge.error || !challenge.data) {
      busyLock.current = false;
      setBusy(false);
      setError(t.security.verifyFailed);
      return;
    }
    const { error: e } = await supabase.auth.mfa.verify({
      factorId: enrollment.factorId,
      challengeId: challenge.data.id,
      code: trimmed,
    });
    busyLock.current = false;
    setBusy(false);
    if (e) {
      setError(t.security.verifyFailed);
      return;
    }
    setEnrollment(null);
    setFriendlyName("");
    setCode("");
    await load();
  }

  /** Drops a started enrolment: the unfinished factor is removed so it does not linger in the list. */
  async function cancelEnroll() {
    const supabase = createClient();
    if (!supabase || !enrollment || busyLock.current) return;
    busyLock.current = true;
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.auth.mfa.unenroll({ factorId: enrollment.factorId });
    busyLock.current = false;
    setBusy(false);
    setEnrollment(null);
    setCode("");
    if (e) setError(t.ownerSafety.cancelFailed);
    else toast.info(t.ownerSafety.enrollCancelled);
    await load();
  }

  async function remove(factor: Factor) {
    const supabase = createClient();
    if (!supabase || removingId) return;
    const verifiedCount = (factors ?? []).filter((f) => f.status === "verified").length;
    const last = factor.status === "verified" && verifiedCount <= 1;
    const name = factor.friendlyName || t.security.factorsTitle;
    setRemovingId(factor.id);
    setError(null);
    const done = await confirm({
      title: last ? t.ownerSafety.factorLastTitle : fmt(t.ownerSafety.factorRemoveTitle, { name }),
      message: last
        ? t.ownerSafety.factorLastBody
        : factor.status === "verified"
          ? t.security.removeConfirm
          : t.ownerSafety.factorUnverifiedBody,
      confirmLabel: t.security.remove,
      typeToConfirm: last ? t.ownerSafety.factorLastWord : undefined,
      successMessage: t.ownerSafety.factorRemoved,
      run: async () => {
        const { error: e } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
        return e ? t.ownerSafety.removeFailed : true;
      },
    });
    setRemovingId(null);
    if (!done) return;
    if (enrollment?.factorId === factor.id) setEnrollment(null);
    await load();
  }

  async function copySecret() {
    if (!enrollment) return;
    const ok = await copyText(enrollment.secret, typeof navigator !== "undefined" ? navigator.clipboard : null);
    if (ok) toast.success(t.ownerSafety.copiedSecret);
    else toast.error(t.ux.copyFailed);
  }

  if (!configured) {
    return (
      <section className="panel">
        <StateBlock tone="warn">{t.security.notConfigured}</StateBlock>
      </section>
    );
  }

  const hasVerified = (factors ?? []).some((f) => f.status === "verified");
  const stepUp = needsStepUp(aal, hasVerified);

  return (
    <div className="rhythm">
      {dialog}

      {/* Where the account stands now */}
      <section className="panel" aria-labelledby="sec-level">
        <div className="g5-sechead">
          <h2 id="sec-level" className="g5-h">
            {t.security.currentLevel}
          </h2>
          <StatusLamp
            tone={aal === "aal2" ? "ok" : "idle"}
            label={aal === null ? t.ownerSafety.levelUnknown : aal === "aal2" ? t.security.aal2 : t.security.aal1}
          />
        </div>
        {stepUp && <p className="g5-note">{t.security.stepUpNote}</p>}
      </section>

      {error && (
        <p role="alert" className="g5-note g5-fail-text">
          {error}
        </p>
      )}

      {/* The job: add an authenticator. One lit desk. */}
      <section className="panel ns-desk" aria-labelledby="sec-enroll">
        <div className="flex flex-col gap-5">
          <h2 id="sec-enroll" className="g5-h">
            {t.security.enrollTitle}
          </h2>

          {!enrollment ? (
            <form
              className="g5-form"
              onSubmit={(e) => {
                e.preventDefault();
                void startEnroll();
              }}
            >
              <label className="g5-field" data-grow="2">
                <span className="g5-k">{t.security.friendlyName}</span>
                <input
                  type="text"
                  value={friendlyName}
                  onChange={(e) => setFriendlyName(e.target.value)}
                  placeholder={t.security.friendlyNamePh}
                  enterKeyHint="go"
                  className="ns-field min-w-0"
                />
              </label>
              <button type="submit" disabled={busy} aria-busy={busy} className="btn-primary disabled:opacity-55">
                {t.security.startEnroll}
              </button>
            </form>
          ) : (
            <div className="flex flex-col gap-5">
              <p className="g5-sub" style={{ marginTop: 0 }}>
                {t.security.scanHint}
              </p>
              <div className="flex flex-wrap items-start gap-6">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={enrollment.qrCode} alt="" width={176} height={176} className="g5-qr" />
                <div className="flex min-w-0 flex-1 basis-60 flex-col gap-2">
                  <span className="g5-k">{t.security.secretLabel}</span>
                  <code className="mono g5-secret">{enrollment.secret}</code>
                  <div className="flex flex-wrap gap-2">
                    {/* The phone that shows the QR code cannot scan it: this opens the authenticator app on the same device. */}
                    <a href={enrollment.uri} className="btn-quiet">
                      {t.ownerSafety.openApp}
                    </a>
                    <button type="button" onClick={copySecret} className="btn-quiet">
                      {t.ownerSafety.copySecret}
                    </button>
                  </div>
                  <p className="g5-note">{t.ownerSafety.openAppHint}</p>
                </div>
              </div>
              <form
                className="g5-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void verify();
                }}
              >
                <label className="g5-field" data-fixed>
                  <span className="g5-k">{t.security.codeLabel}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    enterKeyHint="go"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder={t.security.codePh}
                    className="ns-field tnum"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy || code.trim().length < 6}
                  aria-busy={busy}
                  className="btn-primary disabled:opacity-55"
                >
                  {busy ? t.security.verifying : t.security.verify}
                </button>
                <button type="button" onClick={cancelEnroll} disabled={busy} className="btn-quiet disabled:opacity-55">
                  {t.ownerSafety.cancelEnroll}
                </button>
              </form>
            </div>
          )}
        </div>
      </section>

      {/* The authenticators already on the account */}
      <section className="panel" aria-labelledby="sec-factors">
        <div className="g5-sechead">
          <h2 id="sec-factors" className="g5-h">
            {t.security.factorsTitle}
          </h2>
        </div>
        {loadFailed ? (
          <div role="alert" className="g5-rows">
            <div className="g5-row" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <p className="g5-note g5-fail-text">{t.ownerSafety.readFailed}</p>
              <button type="button" onClick={() => void load()} className="btn-quiet">
                {t.ux.errorRetry}
              </button>
            </div>
          </div>
        ) : factors === null ? (
          <div role="status" className="g5-rows">
            <span className="sr-only">{t.ux.loading}</span>
            <div className="g5-row">
              <Skeleton className="h-5 w-1/3" />
            </div>
          </div>
        ) : factors.length === 0 ? (
          <StateBlock tone="idle" compact>
            {t.security.noFactors}
          </StateBlock>
        ) : (
          <ul className="g5-rows">
            {factors.map((f) => (
              <li key={f.id} className="g5-row" style={{ gridTemplateColumns: "minmax(0, 1fr) auto auto" }}>
                <div className="min-w-0">
                  <p className="g5-row-title">{f.friendlyName || t.security.factorsTitle}</p>
                  <p className="g5-row-meta">TOTP</p>
                </div>
                <StatusLamp
                  tone={f.status === "verified" ? "ok" : "idle"}
                  label={f.status === "verified" ? t.security.statusVerified : t.security.statusUnverified}
                />
                <button
                  type="button"
                  onClick={() => remove(f)}
                  disabled={removingId !== null}
                  className="btn-quiet btn-danger-quiet disabled:opacity-55"
                >
                  {removingId === f.id ? t.security.removing : t.security.remove}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
