"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { StatusPill } from "@/components/ui";
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
 * Enforcing AAL2 at login (rejecting a password-only session) is a Supabase
 * project-level policy; this board delivers enrolment and management only.
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
};

export function SecurityBoard() {
  const { t } = useI18n();
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
    const all = listRes.data?.all ?? [];
    setFactors(
      all.map((f) => ({
        id: f.id,
        friendlyName: f.friendly_name ?? null,
        status: f.status === "verified" ? "verified" : "unverified",
      })),
    );
    setAal(normalizeAal(aalRes.data?.currentLevel));
  }

  useEffect(() => {
    load();
  }, []);

  async function startEnroll() {
    const supabase = createClient();
    if (!supabase || busy) return;
    setBusy(true);
    setError(null);
    const { data, error: e } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: friendlyName.trim() || undefined,
    });
    setBusy(false);
    if (e || !data) {
      setError(t.security.enrollFailed);
      return;
    }
    setEnrollment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    setCode("");
  }

  async function verify() {
    const supabase = createClient();
    if (!supabase || !enrollment || busy) return;
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const challenge = await supabase.auth.mfa.challenge({ factorId: enrollment.factorId });
    if (challenge.error || !challenge.data) {
      setBusy(false);
      setError(t.security.verifyFailed);
      return;
    }
    const { error: e } = await supabase.auth.mfa.verify({
      factorId: enrollment.factorId,
      challengeId: challenge.data.id,
      code: trimmed,
    });
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

  async function remove(factor: Factor) {
    const supabase = createClient();
    if (!supabase || removingId) return;
    if (!window.confirm(t.security.removeConfirm)) return;
    setRemovingId(factor.id);
    setError(null);
    const { error: e } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    setRemovingId(null);
    if (e) {
      setError(t.security.enrollFailed);
      return;
    }
    if (enrollment?.factorId === factor.id) setEnrollment(null);
    await load();
  }

  if (!configured) {
    return (
      <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{t.security.notConfigured}</div>
    );
  }

  const hasVerified = (factors ?? []).some((f) => f.status === "verified");
  const stepUp = needsStepUp(aal, hasVerified);

  return (
    <div className="rhythm">
      {/* Current assurance level */}
      <div className="panel flex flex-wrap items-center justify-between gap-2 p-4">
        <span className="text-[13px] text-[var(--color-muted)]">{t.security.currentLevel}</span>
        <StatusPill
          tone={aal === "aal2" ? "ok" : "idle"}
          label={aal === "aal2" ? t.security.aal2 : t.security.aal1}
        />
      </div>

      {stepUp && (
        <p className="mono text-[12px] text-[var(--color-muted)]">{t.security.stepUpNote}</p>
      )}

      {error && <p className="mono text-[12px] text-[var(--color-fail)]">{error}</p>}

      {/* Existing factors */}
      <div className="panel overflow-hidden p-0">
        <div className="border-b border-[var(--color-border)] px-4 py-2.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
          {t.security.factorsTitle}
        </div>
        {factors === null ? (
          <p className="p-4 text-[13px] text-[var(--color-muted)]">…</p>
        ) : factors.length === 0 ? (
          <p className="p-4 text-[13px] text-[var(--color-muted)]">{t.security.noFactors}</p>
        ) : (
          factors.map((f) => (
            <div
              key={f.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="truncate text-[14px] text-[var(--color-fg)]">
                  {f.friendlyName || t.security.factorsTitle}
                </div>
                <div className="mono text-[11px] text-[var(--color-muted)]">TOTP</div>
              </div>
              <div className="flex items-center gap-3">
                <StatusPill
                  tone={f.status === "verified" ? "ok" : "idle"}
                  label={f.status === "verified" ? t.security.statusVerified : t.security.statusUnverified}
                />
                <button
                  type="button"
                  onClick={() => remove(f)}
                  disabled={removingId === f.id}
                  className="btn-sky is-quiet pill px-3 py-1 text-[12px] disabled:opacity-40"
                >
                  {removingId === f.id ? t.security.removing : t.security.remove}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Enroll a new factor */}
      <div className="panel flex flex-col gap-3 p-4">
        <div>
          <h2 className="t-section">{t.security.enrollTitle}</h2>
        </div>

        {!enrollment ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
                {t.security.friendlyName}
              </span>
              <input
                type="text"
                value={friendlyName}
                onChange={(e) => setFriendlyName(e.target.value)}
                placeholder={t.security.friendlyNamePh}
                className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
              />
            </label>
            <button
              type="button"
              onClick={startEnroll}
              disabled={busy}
              className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
            >
              {t.security.startEnroll}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-[var(--color-muted)]">{t.security.scanHint}</p>
            <div className="flex flex-wrap items-start gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={enrollment.qrCode}
                alt=""
                width={176}
                height={176}
                className="size-44 rounded-lg border border-[var(--color-border)] bg-white p-2"
              />
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
                  {t.security.secretLabel}
                </span>
                <code className="mono break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[12px] text-[var(--color-fg)]">
                  {enrollment.secret}
                </code>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
                  {t.security.codeLabel}
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder={t.security.codePh}
                  className="mono w-40 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] tracking-[0.3em] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
                />
              </label>
              <button
                type="button"
                onClick={verify}
                disabled={busy || code.trim().length < 6}
                className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
              >
                {busy ? t.security.verifying : t.security.verify}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
