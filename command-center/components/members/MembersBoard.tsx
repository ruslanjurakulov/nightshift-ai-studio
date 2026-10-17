"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { Skeleton } from "@/components/feedback/Skeleton";
import { StateBlock } from "@/components/states/StateBlock";
import { ErrorState } from "@/components/ReadError";
import { ROLES, type Role } from "@/lib/auth/roles-shared";
import { fmt } from "@/lib/i18n";
import { memberBlock } from "@/lib/confirm-tier";
import { useConfirm } from "@/components/feedback/ConfirmDialog";

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
 *
 * Access changes ask first: removing a person or changing a role opens a sheet
 * that names them. Your own row and the last owner cannot be changed or removed
 * from here (memberBlock). That is a UI guard only: the database still lets a
 * crafted request do it until a migration adds the same rule to the policies.
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
  const [loadFailed, setLoadFailed] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  // One access change at a time, locked synchronously (state alone lags a render).
  const acting = useRef(false);
  const [actingId, setActingId] = useState<string | null>(null);

  const canManage = myRole === "owner" || myRole === "admin";
  const empty = members !== null && members.length === 0;

  async function load() {
    const supabase = createClient();
    if (!supabase) return;
    const { data, error: readErr } = await supabase
      .from("app_members")
      .select("id,user_id,email,role,created_at")
      .order("created_at", { ascending: true });
    // A failed read is not an empty roster (that would offer "claim ownership").
    setLoadFailed(Boolean(readErr));
    setMembers(readErr ? null : ((data as Member[]) ?? []));
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
    if (!supabase || !addr || busy || acting.current) return;
    acting.current = true;
    setBusy(true);
    setError(null);
    const write = async () => {
      const { error: e } = await supabase.from("app_members").insert({ email: addr, role, created_by: myUserId });
      return e ? t.members.saveFailed : true;
    };
    let ok: boolean;
    if (role === "admin" || role === "owner") {
      // Admin and owner reach keys, providers and the team: say who gets what before it happens.
      ok = await confirm({
        title: fmt(t.ownerSafety.memberAddTitle, { email: addr, role: roleLabel[role] }),
        message: fmt(t.ownerSafety.memberAddBody, { cap: t.members[`cap_${role}` as const] }),
        confirmLabel: t.ownerSafety.memberAddConfirm,
        tone: "primary",
        details: [
          { label: t.ownerSafety.dPerson, value: addr },
          { label: t.ownerSafety.dRole, value: roleLabel[role] },
        ],
        successMessage: fmt(t.ownerSafety.memberAdded, { email: addr, role: roleLabel[role] }),
        run: write,
      });
    } else {
      const res = await write();
      ok = res === true;
      if (!ok) setError(res as string);
    }
    acting.current = false;
    setBusy(false);
    if (!ok) return;
    setEmail("");
    await load();
  }

  async function changeRole(m: Member, next: Role) {
    if (acting.current || next === m.role) return;
    // The select cannot offer these rows, but a stale render or a crafted event must not slip through.
    if (memberBlock(m, members ?? [], { userId: myUserId, email: myEmail })) return;
    const supabase = createClient();
    if (!supabase) return;
    acting.current = true;
    setActingId(m.id);
    setError(null);
    const done = await confirm({
      title: fmt(t.ownerSafety.roleChangeTitle, { email: m.email }),
      message: fmt(t.ownerSafety.roleChangeBody, { cap: t.members[`cap_${next}` as const] }),
      confirmLabel: t.ownerSafety.roleChangeConfirm,
      tone: "primary",
      details: [
        { label: t.ownerSafety.dPerson, value: m.email },
        { label: t.ownerSafety.dRole, value: `${roleLabel[m.role]} → ${roleLabel[next]}` },
      ],
      successMessage: fmt(t.ownerSafety.roleChanged, { email: m.email, role: roleLabel[next] }),
      run: async () => {
        const { error: e } = await supabase.from("app_members").update({ role: next }).eq("id", m.id);
        return e ? t.members.saveFailed : true;
      },
    });
    acting.current = false;
    setActingId(null);
    if (!done) return;
    await load();
    router.refresh();
  }

  async function remove(m: Member) {
    if (acting.current) return;
    if (memberBlock(m, members ?? [], { userId: myUserId, email: myEmail })) return;
    const supabase = createClient();
    if (!supabase) return;
    acting.current = true;
    setActingId(m.id);
    setError(null);
    const done = await confirm({
      title: fmt(t.ownerSafety.memberRemoveTitle, { email: m.email }),
      message: t.ownerSafety.memberRemoveBody,
      confirmLabel: t.ownerSafety.memberRemoveConfirm,
      details: [
        { label: t.ownerSafety.dPerson, value: m.email },
        { label: t.ownerSafety.dRole, value: roleLabel[m.role] },
      ],
      successMessage: fmt(t.ownerSafety.memberRemoved, { email: m.email }),
      run: async () => {
        const { error: e } = await supabase.from("app_members").delete().eq("id", m.id);
        return e ? t.members.saveFailed : true;
      },
    });
    acting.current = false;
    setActingId(null);
    if (done) await load();
  }

  const roleLabel: Record<Role, string> = {
    owner: t.members.roleOwner,
    admin: t.members.roleAdmin,
    editor: t.members.roleEditor,
    viewer: t.members.roleViewer,
  };

  return (
    <div className="rhythm">
      {dialog}
      {/* The job on this page: claim the roster while it is empty, or add a person. One lit desk. */}
      {empty && (
        <section className="panel ns-desk" aria-labelledby="mb-claim">
          <div className="flex flex-col items-start gap-4">
            <div>
              <h2 id="mb-claim" className="g5-h">
                {t.members.claimTitle}
              </h2>
              <p className="g5-sub">{t.members.claimHint}</p>
            </div>
            <button type="button" onClick={claim} disabled={busy} className="btn-primary disabled:opacity-40">
              {busy ? t.members.adding : t.members.claim}
            </button>
          </div>
        </section>
      )}

      {canManage && !empty && (
        <section className="panel ns-desk" aria-labelledby="mb-add">
          <div className="flex flex-col gap-5">
            <h2 id="mb-add" className="g5-h">
              {t.members.addTitle}
            </h2>
            <div className="g5-form">
              <label className="g5-field" data-grow="2">
                <span className="g5-k">{t.members.addEmail}</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t.members.emailPh}
                  className="ns-field min-w-0"
                />
              </label>
              <label className="g5-field" data-fixed>
                <span className="g5-k">{t.members.addRole}</span>
                <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="ns-field">
                  {MANAGE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel[r]}
                    </option>
                  ))}
                  {myRole === "owner" && <option value="owner">{roleLabel.owner}</option>}
                </select>
              </label>
              <button type="button" onClick={add} disabled={busy || !email.trim()} className="btn-primary disabled:opacity-40">
                {busy ? t.members.adding : t.members.add}
              </button>
            </div>
            <p className="g5-note">{t.members.addNote}</p>
          </div>
        </section>
      )}

      {error && (
        <p role="alert" className="g5-note g5-fail-text">
          {error}
        </p>
      )}

      {/* The roster: one ruled row per person */}
      <section className="panel" aria-labelledby="mb-roster">
        <div className="g5-sechead">
          <h2 id="mb-roster" className="g5-h">
            {t.members.colEmail}
          </h2>
          <StatusLamp tone={canManage ? "ok" : "idle"} label={`${t.members.yourRole}: ${roleLabel[myRole]}`} />
        </div>
        {loadFailed ? (
          <ErrorState compact onRetry={load} />
        ) : members === null ? (
          <div role="status" className="g5-rows">
            <span className="sr-only">{t.ux.loading}</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="g5-row">
                <Skeleton className="h-5 w-1/2" />
              </div>
            ))}
          </div>
        ) : members.length === 0 ? (
          <StateBlock tone="idle" compact>
            {t.members.empty}
          </StateBlock>
        ) : (
          <ul className="g5-rows">
            {members.map((m) => {
              const isOwnerRow = m.role === "owner";
              const block = memberBlock(m, members, { userId: myUserId, email: myEmail });
              const canEditThis = canManage && (!isOwnerRow || myRole === "owner") && block === null;
              return (
                <li key={m.id} className="g5-row g5-person">
                  <div className="min-w-0">
                    <p className="g5-row-title">{m.email}</p>
                    <p className="g5-row-meta">
                      <StatusLamp tone={m.user_id ? "ok" : "idle"} label={m.user_id ? t.members.statusActive : t.members.statusInvited} />
                    </p>
                    {canManage && block && (
                      <p className="g5-note mt-1">{block === "last_owner" ? t.ownerSafety.blockLast : t.ownerSafety.blockSelf}</p>
                    )}
                  </div>
                  {canEditThis ? (
                    <select
                      value={m.role}
                      onChange={(e) => changeRole(m, e.target.value as Role)}
                      disabled={actingId !== null}
                      aria-label={`${t.members.colRole}: ${m.email}`}
                      className="ns-field g5-person-role"
                    >
                      {ROLES.filter((r) => r !== "owner" || myRole === "owner").map((r) => (
                        <option key={r} value={r}>
                          {roleLabel[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="g5-v g5-person-role">{roleLabel[m.role]}</span>
                  )}
                  {canEditThis ? (
                    <button
                      type="button"
                      onClick={() => remove(m)}
                      disabled={actingId !== null}
                      className="btn-quiet btn-danger-quiet disabled:opacity-55"
                    >
                      {t.members.remove}
                    </button>
                  ) : (
                    <span aria-hidden />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* What each role may do */}
      <section className="panel" aria-labelledby="mb-roles">
        <div className="g5-sechead">
          <h2 id="mb-roles" className="g5-h">
            {t.members.colRole}
          </h2>
        </div>
        <dl className="g5-legend">
          {ROLES.map((r) => (
            <div key={r}>
              <dt>{roleLabel[r]}</dt>
              <dd>{t.members[`cap_${r}` as const]}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
