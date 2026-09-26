"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { StatusPill } from "@/components/ui";
import { ROLES, type Role } from "@/lib/auth/roles-shared";
import {
  assignableRoles,
  canEditMember,
  canManageMembers,
  isPlausibleEmail,
  validateOrgName,
  wouldRemoveLastOwner,
  ORG_NAME_MAX,
  type OrgMember,
  type OrgSummary,
} from "@/lib/orgs";

/**
 * One organization's team — the org-level twin of MembersBoard.
 *
 * Reads and writes go straight to `org_members` / `organizations` through the
 * browser (anon) client; the policies in migration 0018 decide what sticks.
 * Invites go through invite_org_member(), which normalises the email and
 * re-roles an existing invite instead of failing on it. The UI mirrors the
 * database's rules (admin+ manages, only an owner touches an owner, the last
 * owner stays) so nobody is offered a control that would be refused.
 */
export function OrgMembersBoard({ org, myUserId }: { org: OrgSummary; myUserId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const myRole = org.role;
  const canManage = canManageMembers(myRole);

  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [name, setName] = useState(org.name);
  const [nameSaved, setNameSaved] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) return;
    const { data } = await supabase
      .from("org_members")
      .select("id,org_id,user_id,email,role,created_at")
      .eq("org_id", org.id)
      .order("created_at", { ascending: true });
    setMembers((data as OrgMember[]) ?? []);
  }, [org.id]);

  useEffect(() => {
    load();
  }, [load]);

  const roleLabel: Record<Role, string> = {
    owner: t.members.roleOwner,
    admin: t.members.roleAdmin,
    editor: t.members.roleEditor,
    viewer: t.members.roleViewer,
  };

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
      setError(t.members.saveFailed);
      return;
    }
    setNameSaved(true);
    router.refresh();
  }

  async function invite() {
    const supabase = createClient();
    const addr = email.trim().toLowerCase();
    if (!supabase || busy) return;
    if (!isPlausibleEmail(addr)) {
      setError(t.org.emailInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.rpc("invite_org_member", {
      p_org: org.id,
      p_email: addr,
      p_role: role,
    });
    setBusy(false);
    if (e) {
      setError(t.members.saveFailed);
      return;
    }
    setEmail("");
    await load();
  }

  async function changeRole(m: OrgMember, next: Role) {
    const supabase = createClient();
    if (!supabase || !members) return;
    if (wouldRemoveLastOwner(members, m.id, next)) {
      setError(t.org.lastOwner);
      return;
    }
    setError(null);
    const { error: e } = await supabase.from("org_members").update({ role: next }).eq("id", m.id);
    if (e) {
      setError(t.members.saveFailed);
      return;
    }
    await load();
    if (m.user_id === myUserId) router.refresh();
  }

  async function remove(m: OrgMember) {
    const supabase = createClient();
    if (!supabase || !members) return;
    if (wouldRemoveLastOwner(members, m.id, null)) {
      setError(t.org.lastOwner);
      return;
    }
    setError(null);
    const { error: e } = await supabase.from("org_members").delete().eq("id", m.id);
    if (e) {
      setError(t.members.saveFailed);
      return;
    }
    await load();
    if (m.user_id === myUserId) router.refresh();
  }

  const inputClass =
    "min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]";

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

      {/* Name */}
      <div className="panel flex flex-col gap-3 p-4">
        <h2 className="t-section">{t.org.nameTitle}</h2>
        {canManage ? (
          <div className="flex flex-wrap items-end gap-3">
            <input
              type="text"
              value={name}
              maxLength={ORG_NAME_MAX}
              onChange={(e) => {
                setName(e.target.value);
                setNameSaved(false);
              }}
              aria-label={t.org.nameLabel}
              className={`flex-1 ${inputClass}`}
            />
            <button
              type="button"
              onClick={rename}
              disabled={busy || name.trim() === org.name || validateOrgName(name) === null}
              className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
            >
              {nameSaved ? t.org.saved : t.org.rename}
            </button>
          </div>
        ) : (
          <p className="text-[14px] text-[var(--color-fg)]">{org.name}</p>
        )}
        <p className="mono text-[11px] text-[var(--color-muted)]">
          {org.slug}
          {org.is_default ? ` · ${t.org.defaultBadge}` : ""}
        </p>
      </div>

      {/* Invite (owner/admin) */}
      {canManage && (
        <div className="panel flex flex-col gap-3 p-4">
          <h2 className="t-section">{t.org.inviteTitle}</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{t.members.addEmail}</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t.members.emailPh}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{t.members.addRole}</span>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={inputClass}>
                {assignableRoles(myRole).map((r) => (
                  <option key={r} value={r}>{roleLabel[r]}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={invite}
              disabled={busy || !email.trim()}
              className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
            >
              {busy ? t.members.adding : t.members.add}
            </button>
          </div>
          <p className="text-[11px] text-[var(--color-muted)]">{t.org.inviteNote}</p>
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
            const editable = canEditMember(myRole, m.role);
            return (
              <div
                key={m.id}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="truncate text-[14px] text-[var(--color-fg)]">{m.email || m.user_id}</div>
                  <div className="mono text-[11px] text-[var(--color-muted)]">
                    {m.user_id ? t.members.statusActive : t.members.statusInvited}
                  </div>
                </div>
                {editable ? (
                  <select
                    value={m.role}
                    onChange={(e) => changeRole(m, e.target.value as Role)}
                    className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
                  >
                    {assignableRoles(myRole).map((r) => (
                      <option key={r} value={r}>{roleLabel[r]}</option>
                    ))}
                  </select>
                ) : (
                  <StatusPill tone={m.role === "owner" ? "ok" : "idle"} label={roleLabel[m.role]} />
                )}
                {editable ? (
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
