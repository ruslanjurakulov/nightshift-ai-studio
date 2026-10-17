"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { AuthAlert, AuthField, AuthShell, AuthSubmit } from "@/components/auth/AuthShell";
import {
  completeTotpChallenge,
  listTotpFactors,
  type ChallengeFailure,
  type MfaClient,
  type MfaFactor,
} from "@/lib/security/challenge";

/**
 * The second step of sign-in (/login/verify): the 6-digit code from the
 * person's authenticator app. The server page has already decided that a code
 * is needed (a password-only session on an account with a verified factor);
 * this form only collects it and walks the session to aal2.
 *
 * States: loading the factor list, ready, checking, wrong code, expired
 * challenge, rate limited, factor gone, anything else (network), and no
 * factors at all. Every one has words, and "Sign out" is always on the page: a
 * person who cannot produce a code is never stuck on a screen with no exit.
 * `next` was validated on the server (lib/safe-redirect.ts) before it got here.
 */
export function MfaChallenge({ next }: { next: string }) {
  const router = useRouter();
  const { t } = usePublicI18n();
  const m = t.mfa;
  const [factors, setFactors] = useState<MfaFactor[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [factorId, setFactorId] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [failure, setFailure] = useState<ChallengeFailure | null>(null);

  async function load() {
    setLoadFailed(false);
    setFactors(null);
    const supabase = createClient() as unknown as MfaClient | null;
    const list = supabase ? await listTotpFactors(supabase) : null;
    if (!list || list.length === 0) {
      setLoadFailed(true);
      setFactors([]);
      return;
    }
    setFactors(list);
    setFactorId(list[0].id);
  }

  useEffect(() => {
    void load();
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !factorId) return;
    setFailure(null);
    const supabase = createClient() as unknown as MfaClient | null;
    if (!supabase) {
      setFailure("failed");
      return;
    }
    setBusy(true);
    const result = await completeTotpChallenge(supabase, factorId, code);
    setBusy(false);
    if (!result.ok) {
      setFailure(result.reason);
      if (result.reason === "wrong_code" || result.reason === "expired") setCode("");
      return;
    }
    router.push(next);
    router.refresh();
  }

  async function signOut() {
    if (leaving) return;
    setLeaving(true);
    try {
      await createClient()?.auth.signOut({ scope: "local" });
    } catch {
      /* the page below is /login either way; a still-valid cookie is the middleware's to refuse */
    }
    router.push("/login");
    router.refresh();
  }

  const messages: Record<ChallengeFailure, string> = {
    wrong_code: m.wrongCode,
    expired: m.expired,
    rate_limited: m.rateLimited,
    no_factor: m.noFactor,
    failed: m.failed,
  };

  return (
    <AuthShell title={m.title} subtitle={m.subtitle}>
      {factors === null && !loadFailed ? (
        <p role="status" className="st-small mt-8">
          {m.loading}
        </p>
      ) : loadFailed ? (
        <div className="mt-8 flex flex-col gap-3">
          <AuthAlert tone="warn">{m.unavailable}</AuthAlert>
          <button type="button" className="st-key" data-block="true" onClick={() => void load()}>
            {m.retry}
          </button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-8">
          <fieldset className="st-fieldset">
            {factors && factors.length > 1 && (
              <label className="st-field">
                <span>{m.factorLabel}</span>
                <select value={factorId} onChange={(e) => setFactorId(e.target.value)}>
                  {factors.map((f, i) => (
                    <option key={f.id} value={f.id}>
                      {f.friendlyName || `${m.factorFallback} ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <AuthField
              label={m.codeLabel}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={m.codePh}
              maxLength={12}
              autoFocus
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            {failure && <AuthAlert tone="fail">{messages[failure]}</AuthAlert>}
            <AuthSubmit busy={busy} disabled={code.trim() === ""}>
              {busy ? m.submitting : m.submit}
            </AuthSubmit>
          </fieldset>
        </form>
      )}

      <p className="st-small mt-8 border-t border-[var(--ns-rule)] pt-5">
        <button type="button" className="st-link text-[15px]" onClick={() => void signOut()} disabled={leaving}>
          {leaving ? m.signingOut : m.signOut}
        </button>
      </p>
    </AuthShell>
  );
}
