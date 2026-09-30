"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { coerceInvites, type PendingInvite } from "@/lib/invites";

/**
 * Invitations waiting for this account's answer. Nothing is joined until the
 * person presses Accept: an invite used to bind itself on the next page load,
 * which let anyone put anyone into their organization (migration 0043).
 * Renders nothing when there are none, or before 0043 (no my_invites()).
 */
export function PendingInvites() {
  const { t } = useI18n();
  const router = useRouter();
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) return;
    const { data, error: e } = await supabase.rpc("my_invites");
    setInvites(e ? [] : coerceInvites(data));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function answer(invite: PendingInvite, accept: boolean) {
    const supabase = createClient();
    if (!supabase || busy) return;
    setBusy(invite.id);
    setError(null);
    const { error: e } = await supabase.rpc(accept ? "accept_org_invite" : "decline_org_invite", {
      p_invite: invite.id,
    });
    if (e) {
      setBusy(null);
      setError(t.invites.failed);
      return;
    }
    if (accept) {
      // Open the organization just joined; the server re-checks membership.
      await fetch("/api/org/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: invite.orgId }),
      }).catch(() => undefined);
      router.push("/");
      router.refresh();
      return;
    }
    setBusy(null);
    await load();
  }

  if (invites.length === 0) return null;

  return (
    <div className="panel flex flex-col gap-3 p-4">
      <h2 className="t-section">{t.invites.title}</h2>
      <p className="text-[12px] text-[var(--color-muted)]">{t.invites.hint}</p>
      <ul className="flex flex-col gap-2">
        {invites.map((inv) => (
          <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3">
            <span className="min-w-0 truncate text-[14px] text-[var(--color-fg)]">{inv.orgName}</span>
            <span className="flex gap-2">
              <button
                type="button"
                onClick={() => answer(inv, true)}
                disabled={busy !== null}
                className="btn-sky is-solid pill px-4 py-1.5 text-[13px] disabled:opacity-40"
              >
                {busy === inv.id ? t.invites.working : t.invites.accept}
              </button>
              <button
                type="button"
                onClick={() => answer(inv, false)}
                disabled={busy !== null}
                className="btn-sky is-quiet pill px-4 py-1.5 text-[13px] disabled:opacity-40"
              >
                {t.invites.decline}
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="mono text-[12px] text-[var(--color-fail)]">{error}</p>}
    </div>
  );
}
