"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { StatusPill } from "@/components/ui";
import { ROLES, type Role } from "@/lib/auth/roles-shared";

/**
 * Team & roles.
 *
 * All writes go straight to the `app_members` table through the browser client;
 * the RLS policies in migration 0007 enforce who may write (owner/admin only,
 * and only an owner may touch an owner). The UI mirrors those rules so a viewer
 * or editor never sees controls the database would reject.
 *
 * Bootstrap: while the table is empty every signed-in user is the effective
 * owner, so the first person here claims ownership and the roster begins.
 */
type Member = {
  id: string;
  user_id: string | null;
  email: string;
  role: Role;
  created_at: string;
};

const MANAGE_ROLES: Role[] = ["admin", "editor", "viewer"]; // owner is only granted by an owner

export function MembersBoard({
  myRole,
  myEmail,
  myUserId,
}: {
  myRole: Role;
  myEmail: string;
  myUserId: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = myRole === "owner" || myRole === "admin";
  const empty = members !== null && members.length === 0;

  async function load() {
    const supabase = createClient();
    if (!supabase) return;
    const { data } = await supabase
      .from("app_members")
      .select("id,user_id,email,role,created_at")
      .order("created_at", { ascending: true });
    setMembers((data as Member[]) ?? []);
  }

  useEffect(() => {
    load();
  }, []);

  async function claim() {
    const supabase = createClient();
    if (!supabase || busy) return;
    setBusy(true);
    setError(null);
    const { error: e } = await supabase
      .from("app_members")
      .insert({ email: myEmail, user_id: myUserId, role: "owner" });
    setBusy(false);
    if (e) {
      setError(t.members.saveFailed);
      return;
    }
    await load();
    router.refresh();
  }

  async function add() {
    const supabase = createClient();
    const addr = email.trim().toLowerCase();
    if (!supabase || !addr || busy) return;
    setBusy(true);
    setError(null);
    const { error: e } = await supabase
      .from("app_members")
      .insert({ email: addr, role, created_by: myUserId });
    setBusy(false);
    if (e) {
      setError(t.members.saveFailed);
      return;
    }
    setEmail("");
    await load();
  }

  async function changeRole(m: Member, next: Role) {
    const supabase = createClient();
    if (!supabase) return;
    setError(null);
    const { error: e } = await supabase.from("app_members").update({ role: next }).eq("id", m.id);
    if (e) {
      setError(t.members.saveFailed);
      return;
    }
    await load();
    router.refresh();
  }

  async function remove(m: Member) {
    const supabase = createClient();
    if (!supabase) return;
    setError(null);
    const { error: e } = await supabase.from("app_members").delete().eq("id", m.id);
    if (e) {
      setError(t.members.saveFailed);
      return;
    }
    await load();
  }

  const roleLabel: Record<Role, string> = {
    owner: t.members.roleOwner,
    admin: t.members.roleAdmin,
    editor: t.members.roleEditor,
    viewer: t.members.roleViewer,
  };

  return (
    <div className="rhythm">
      {/* Your role + capability legend */}
      <div className="panel flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] text-[var(--color-muted)]">{t.members.yourRole}</span>
          <StatusPill tone={canManage ? "ok" : "idle"} label={roleLabel[myRole]} />
        </div>
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {ROLES.map((r) => (
            <li key={r} className="text-[12px] leading-relaxed text-[var(--color-muted)]">
              <span className="font-semibold text-[var(--color-fg)]">{roleLabel[r]}</span> — {t.members[`cap_${r}` as const]}
            </li>
          ))}
        </ul>
      </div>

      {/* Bootstrap: claim ownership while the roster is empty */}
      {empty && (
        <div className="panel flex flex-col gap-3 p-4">
          <div>
            <h2 className="t-section">{t.members.claimTitle}</h2>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.members.claimHint}</p>
          </div>
          <button
            type="button"
            onClick={claim}
            disabled={busy}
            className="btn-sky is-solid pill self-start px-5 py-2 text-[13px] disabled:opacity-40"
          >
            {busy ? t.members.adding : t.members.claim}
          </button>
        </div>
      )}

      {/* Add member (owner/admin) */}
      {canManage && !empty && (
        <div className="panel flex flex-col gap-3 p-4">
          <h2 className="t-section">{t.members.addTitle}</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{t.members.addEmail}</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t.members.emailPh}
                className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{t.members.addRole}</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
              >
                {MANAGE_ROLES.map((r) => (
                  <option key={r} value={r}>{roleLabel[r]}</option>
                ))}
                {myRole === "owner" && <option value="owner">{roleLabel.owner}</option>}
              </select>
            </label>
            <button
              type="button"
              onClick={add}
              disabled={busy || !email.trim()}
              className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
            >
              {busy ? t.members.adding : t.members.add}
            </button>
          </div>
          <p className="text-[11px] text-[var(--color-muted)]">{t.members.addNote}</p>
        </div>
      )}

      {error && <p className="mono text-[12px] text-[var(--color-fail)]">{error}</p>}

      {/* Roster */}
      <div className="panel overflow-hidden p-0">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-[var(--color-border)] px-4 py-2.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
          <span>{t.members.colEmail}</span>
          <span>{t.members.colRole}</span>
          <span />
        </div>
        {members === null ? (
          <p className="p-4 text-[13px] text-[var(--color-muted)]">…</p>
        ) : members.length === 0 ? (
          <p className="p-4 text-[13px] text-[var(--color-muted)]">{t.members.empty}</p>
        ) : (
          members.map((m) => {
            const isOwnerRow = m.role === "owner";
            const canEditThis = canManage && (!isOwnerRow || myRole === "owner");
            return (
              <div
                key={m.id}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="truncate text-[14px] text-[var(--color-fg)]">{m.email}</div>
                  <div className="mono text-[11px] text-[var(--color-muted)]">
                    {m.user_id ? t.members.statusActive : t.members.statusInvited}
                  </div>
                </div>
                {canEditThis ? (
                  <select
                    value={m.role}
                    onChange={(e) => changeRole(m, e.target.value as Role)}
                    className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
                  >
                    {ROLES.filter((r) => r !== "owner" || myRole === "owner").map((r) => (
                      <option key={r} value={r}>{roleLabel[r]}</option>
                    ))}
                  </select>
                ) : (
                  <StatusPill tone={isOwnerRow ? "ok" : "idle"} label={roleLabel[m.role]} />
                )}
                {canEditThis ? (
                  <button
                    type="button"
                    onClick={() => remove(m)}
                    className="btn-sky is-quiet pill px-3 py-1 text-[12px]"
                  >
                    {t.members.remove}
                  </button>
                ) : (
                  <span />
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
