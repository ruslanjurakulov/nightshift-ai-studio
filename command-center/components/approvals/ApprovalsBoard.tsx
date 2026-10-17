"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { StatusPill, EmptyState } from "@/components/ui";
import { ErrorState } from "@/components/ReadError";
import { canDecide, canRequest, type ApprovalStatus } from "@/lib/approvals";
import type { Role } from "@/lib/auth/roles-shared";

/**
 * Two-person publish approvals for one channel.
 *
 * Every write goes straight to Supabase through the browser client; the RLS
 * policies in migration 0009 are the real guard:
 *   - an editor+ may open a request, only on their own behalf;
 *   - an admin+ who is NOT the requester may approve or reject.
 * The UI mirrors those rules so a viewer or the requester never sees a control
 * the database would reject — but the database decides.
 *
 * There is deliberately no per-channel "require two people" control here or
 * anywhere else in the product: the backend gate still honours the channel flag
 * if it is already set, but customers are not offered it (docs/security/LEDGER.md).
 */
type Approval = {
  id: string;
  channel_id: string;
  video_ref: string | null;
  requested_by: string | null;
  requested_at: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
};

type Member = { user_id: string | null; email: string };

const STATUS_TONE: Record<ApprovalStatus, "warn" | "ok" | "fail"> = {
  pending: "warn",
  approved: "ok",
  rejected: "fail",
};

function fmt(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function ApprovalsBoard({
  channelId,
  myRole,
  myEmail,
  myUserId,
}: {
  channelId: string;
  myRole: Role;
  myEmail: string;
  myUserId: string;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<Approval[] | null>(null);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [loadFailed, setLoadFailed] = useState(false);

  const [videoRef, setVideoRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canReq = canRequest(myRole);

  async function load() {
    const supabase = createClient();
    if (!supabase) return;
    const [{ data: approvals, error: approvalsErr }, { data: members }] = await Promise.all([
      supabase
        .from("publish_approvals")
        .select("id,channel_id,video_ref,requested_by,requested_at,status,decided_by,decided_at,note")
        .eq("channel_id", channelId)
        .order("requested_at", { ascending: false }),
      supabase.from("app_members").select("user_id,email"),
    ]);
    if (approvalsErr) {
      // An empty list would read as "no requests"; say we could not read them.
      setLoadFailed(true);
      setRows(null);
      return;
    }
    setLoadFailed(false);
    setRows((approvals as Approval[]) ?? []);
    // Seed with the current user so their email always resolves, then overlay
    // the roster.
    const map: Record<string, string> = myEmail ? { [myUserId]: myEmail } : {};
    for (const m of (members as Member[]) ?? []) {
      if (m.user_id) map[m.user_id] = m.email;
    }
    setPeople(map);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  /** A display name for a user id: "you", a known member's email, or a short id. */
  function who(id: string | null): string {
    if (!id) return t.approvals.someone;
    if (id === myUserId) return t.approvals.you;
    return people[id] ?? `${id.slice(0, 8)}…`;
  }

  async function request() {
    const supabase = createClient();
    if (!supabase || busy) return;
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.from("publish_approvals").insert({
      channel_id: channelId,
      video_ref: videoRef.trim() || null,
      requested_by: myUserId,
      status: "pending",
    });
    setBusy(false);
    if (e) {
      setError(t.approvals.saveFailed);
      return;
    }
    setVideoRef("");
    await load();
  }

  async function decide(row: Approval, status: "approved" | "rejected") {
    const supabase = createClient();
    if (!supabase || busy) return;
    setBusy(true);
    setError(null);
    const { error: e } = await supabase
      .from("publish_approvals")
      .update({ status, decided_by: myUserId, decided_at: new Date().toISOString() })
      .eq("id", row.id);
    setBusy(false);
    if (e) {
      setError(t.approvals.saveFailed);
      return;
    }
    await load();
  }

  const statusLabel: Record<ApprovalStatus, string> = {
    pending: t.approvals.pending,
    approved: t.approvals.approved,
    rejected: t.approvals.rejected,
  };

  return (
    <div className="rhythm">
      {/* Open a request (editor+) */}
      {canReq && (
        <section aria-labelledby="g3-ask-h" className="g3-section">
          <h2 id="g3-ask-h" className="t-panel">{t.approvals.requestTitle}</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[14rem] flex-1 flex-col gap-1.5">
              <span className="g3-sub">{t.approvals.videoRef}</span>
              <input
                type="text"
                value={videoRef}
                onChange={(e) => setVideoRef(e.target.value)}
                className="ns-field min-w-0"
              />
            </label>
            <button
              type="button"
              onClick={request}
              disabled={busy}
              className="btn-sky is-solid pill px-5 py-2.5 text-sm disabled:opacity-40"
            >
              {busy ? t.approvals.requesting : t.approvals.request}
            </button>
          </div>
        </section>
      )}

      {error && <p className="tnum text-sm text-[var(--color-fail)]">{error}</p>}

      {/* Requests: the desk */}
      <section aria-labelledby="g3-rows-h" className="g3-section ns-desk">
        <header className="g3-head">
          <h2 id="g3-rows-h" className="t-panel">{t.approvals.colRequested}</h2>
          <span className="g3-sub">{t.approvals.colStatus}</span>
        </header>
        {loadFailed ? (
          <ErrorState compact message={t.approvals.readFailed} onRetry={load} />
        ) : rows === null ? (
          <p className="g3-sub">…</p>
        ) : rows.length === 0 ? (
          <EmptyState>{t.approvals.empty}</EmptyState>
        ) : (
          <ul className="g3-asks">
            {rows.map((row, i) => {
              const isOwn = row.requested_by === myUserId;
              const mayDecide = row.status === "pending" && canDecide(myRole, row.requested_by, myUserId);
              return (
                <li key={row.id} className="g3-ask">
                  <span className="g3-edge-no" aria-hidden>{String(i + 1).padStart(2, "0")}</span>
                  <div className="g3-ask-main">
                    <div className="g3-ask-title">{row.video_ref || t.approvals.noVideoRef}</div>
                    <div className="tnum g3-sub">
                      {t.approvals.colRequested}: {who(row.requested_by)} · {fmt(row.requested_at)}
                    </div>
                    {row.status !== "pending" && (
                      <div className="tnum g3-sub">
                        {t.approvals.colDecided}: {who(row.decided_by)} · {fmt(row.decided_at)}
                      </div>
                    )}
                  </div>
                  <div className="g3-ask-state">
                    <StatusPill tone={STATUS_TONE[row.status]} label={statusLabel[row.status]} />
                  </div>
                  {mayDecide ? (
                    <div className="g3-ask-act">
                      <button
                        type="button"
                        onClick={() => decide(row, "approved")}
                        disabled={busy}
                        className="btn-sky pill px-4 py-2 text-sm disabled:opacity-40"
                      >
                        {t.approvals.approve}
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(row, "rejected")}
                        disabled={busy}
                        className="btn-sky is-quiet pill px-4 py-2 text-sm disabled:opacity-40"
                      >
                        {t.approvals.reject}
                      </button>
                    </div>
                  ) : row.status === "pending" && isOwn ? (
                    <span className="tnum g3-sub g3-ask-act">{t.approvals.cannotApproveOwn}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
