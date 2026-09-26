"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { ALL_CHANNELS_SLUG, CHANNEL_COOKIE } from "@/lib/channels";
import { ORG_NAME_MAX, validateOrgName } from "@/lib/orgs";

/**
 * Create an organization; the caller becomes its owner.
 *
 * `first` is the sign-up case — the user belongs to no organization and this
 * form is the whole screen. `another` sits on the Organization page. Either
 * way the server calls create_organization() with the caller's own session and
 * remembers the new org, and the app reopens inside it.
 */
export function CreateOrganizationForm({ variant }: { variant: "first" | "another" }) {
  const router = useRouter();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = validateOrgName(name) !== null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const clean = validateOrgName(name);
    if (!clean) {
      setError(t.org.nameInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/org/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: clean }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error === "limit_reached" ? t.org.limitReached : t.org.createFailed);
        setBusy(false);
        return;
      }
      document.cookie = `${CHANNEL_COOKIE}=${ALL_CHANNELS_SLUG}; path=/; max-age=31536000; samesite=lax`;
      router.push(`/${ALL_CHANNELS_SLUG}/command-center`);
      router.refresh();
    } catch {
      setError(t.org.createFailed);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel flex flex-col gap-3 p-4">
      <div>
        <h2 className="t-section">{variant === "first" ? t.org.createTitle : t.org.createAnotherTitle}</h2>
        <p className="mt-1 text-[13px] text-[var(--color-muted)]">
          {variant === "first" ? t.org.createHint : t.org.createAnotherHint}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{t.org.nameLabel}</span>
          <input
            type="text"
            value={name}
            maxLength={ORG_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.org.namePh}
            className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !valid}
          className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
        >
          {busy ? t.org.creating : t.org.create}
        </button>
      </div>
      {error && <p className="mono text-[12px] text-[var(--color-fail)]">{error}</p>}
    </form>
  );
}
