"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { validateOrgName, ORG_NAME_MAX, type OrgSummary } from "@/lib/orgs";
import { atLeast } from "@/lib/auth/roles-shared";

/**
 * The workspace's name, and the only thing on the Settings page that changes.
 *
 * A workspace has one person: whoever created it. There is no team, no
 * invitation and no roster to show, so this is just the name (the rename goes
 * straight to `organizations` under migration 0018's update policy, which is
 * what decides whether it sticks). The input is read-only for anyone the
 * database would refuse, so nobody is offered a button that cannot work.
 */
export function WorkspaceNameForm({ org }: { org: OrgSummary }) {
  const { t } = useI18n();
  const router = useRouter();
  const canRename = atLeast(org.role, "admin");
  const [name, setName] = useState(org.name);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rename() {
    const supabase = createClient();
    const clean = validateOrgName(name);
    if (!supabase || busy) return;
    if (!clean) {
      setError(t.org.nameInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.from("organizations").update({ name: clean }).eq("id", org.id);
    setBusy(false);
    if (e) {
      setError(t.org.saveFailed);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="panel flex flex-col gap-3 p-5 sm:p-6">
      <h2 className="t-section">{t.org.nameTitle}</h2>
      {canRename ? (
        <div className="flex flex-wrap items-end gap-3">
          <input
            type="text"
            value={name}
            maxLength={ORG_NAME_MAX}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
            aria-label={t.org.nameLabel}
            className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
          />
          <button
            type="button"
            onClick={rename}
            disabled={busy || name.trim() === org.name || validateOrgName(name) === null}
            className="btn-sky is-solid pill px-5 py-2 text-sm disabled:opacity-40"
          >
            {saved ? t.org.saved : t.org.rename}
          </button>
        </div>
      ) : (
        <p className="text-sm text-[var(--color-fg)]">{org.name}</p>
      )}
      {error && <p className="tnum text-xs text-[var(--color-fail)]">{error}</p>}
    </div>
  );
}
