"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { StatusPill, EmptyState } from "@/components/ui";
import { canDecide, canRequest, canToggleRequirement, type ApprovalStatus } from "@/lib/approvals";
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
 * The per-channel "require two-person approval" flag lives in
 * `channels.agent_config.require_two_person_publish`; toggling it merges into
 * the existing config so no other setting is lost.
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
  initialRequire,
  myRole,
  myEmail,
  myUserId,
}: {
  channelId: string;
  initialRequire: boolean;
  myRole: Role;
  myEmail: string;
  myUserId: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [rows, setRows] = useState<Approval[] | null>(null);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [require2p, setRequire2p] = useState(initialRequire);
  const [videoRef, setVideoRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canReq = canRequest(myRole);
  const canToggle = canToggleRequirement(myRole);

  async function load() {
    const supabase = createClient();
    if (!supabase) return;
    const [{ data: approvals }, { data: members }] = await Promise.all([
      supabase
        .from("publish_approvals")
        .select("id,channel_id,video_ref,requested_by,requested_at,status,decided_by,decided_at,note")
        .eq("channel_id", channelId)
        .order("requested_at", { ascending: false }),
      supabase.from("app_members").select("user_id,email"),
    ]);
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

  async function toggleRequirement(next: boolean) {
    const supabase = createClient();
    if (!supabase || busy) return;
    setBusy(true);
    setError(null);
    // Merge into the live config so no other agent setting is clobbered.
    const { data: current } = await supabase
      .from("channels")
      .select("agent_config")
      .eq("channel_id", channelId)
      .maybeSingle();
    const merged = { ...(current?.agent_config ?? {}), require_two_person_publish: next };
    const { error: e } = await supabase
      .from("channels")
      .update({ agent_config: merged })
      .eq("channel_id", channelId);
    setBusy(false);
    if (e) {
      setError(t.approvals.saveFailed);
      return;
    }
    setRequire2p(next);
    router.refresh();
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
      {/* Per-channel requirement toggle */}
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <h2 className="t-section">{t.approvals.requireToggle}</h2>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">
            {require2p ? t.approvals.requireOn : t.approvals.requireOff}
          </p>
        </div>
        {canToggle ? (
          <button
            type="button"
            role="switch"
            aria-checked={require2p}
            disabled={busy}
            onClick={() => toggleRequirement(!require2p)}
            className={`pill inline-flex items-center gap-2 px-4 py-2 text-[13px] disabled:opacity-40 ${
              require2p ? "btn-sky is-solid" : "btn-sky is-quiet"
            }`}
          >
            <StatusPill tone={require2p ? "ok" : "idle"} label={require2p ? t.approvals.requireOn : t.approvals.requireOff} />
          </button>
        ) : (
          <StatusPill tone={require2p ? "ok" : "idle"} label={require2p ? t.approvals.requireOn : t.approvals.requireOff} />
        )}
      </div>

      {/* Open a request (editor+) */}
      {canReq && (
        <div className="panel flex flex-col gap-3 p-4">
          <h2 className="t-section">{t.approvals.requestTitle}</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
                {t.approvals.videoRef}
              </span>
              <input
                type="text"
                value={videoRef}
                onChange={(e) => setVideoRef(e.target.value)}
                className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
              />
            </label>
            <button
              type="button"
              onClick={request}
              disabled={busy}
              className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
            >
              {busy ? t.approvals.requesting : t.approvals.request}
            </button>
          </div>
        </div>
      )}

      {error && <p className="mono text-[12px] text-[var(--color-fail)]">{error}</p>}

      {/* Requests */}
      <div className="panel overflow-hidden p-0">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-[var(--color-border)] px-4 py-2.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
          <span>{t.approvals.colRequested}</span>
          <span>{t.approvals.colStatus}</span>
          <span />
        </div>
        {rows === null ? (
          <p className="p-4 text-[13px] text-[var(--color-muted)]">…</p>
        ) : rows.length === 0 ? (
          <EmptyState>{t.approvals.empty}</EmptyState>
        ) : (
          rows.map((row) => {
            const isOwn = row.requested_by === myUserId;
            const mayDecide = row.status === "pending" && canDecide(myRole, row.requested_by, myUserId);
            return (
              <div
                key={row.id}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="truncate text-[14px] text-[var(--color-fg)]">
                    {row.video_ref || t.approvals.noVideoRef}
                  </div>
                  <div className="mono text-[11px] text-[var(--color-muted)]">
                    {t.approvals.colRequested}: {who(row.requested_by)} · {fmt(row.requested_at)}
                  </div>
                  {row.status !== "pending" && (
                    <div className="mono text-[11px] text-[var(--color-muted)]">
                      {t.approvals.colDecided}: {who(row.decided_by)} · {fmt(row.decided_at)}
                    </div>
                  )}
                </div>
                <StatusPill tone={STATUS_TONE[row.status]} label={statusLabel[row.status]} />
                {mayDecide ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => decide(row, "approved")}
                      disabled={busy}
                      className="btn-sky is-solid pill px-3 py-1 text-[12px] disabled:opacity-40"
                    >
                      {t.approvals.approve}
                    </button>
                    <button
                      type="button"
                      onClick={() => decide(row, "rejected")}
                      disabled={busy}
                      className="btn-sky is-quiet pill px-3 py-1 text-[12px] disabled:opacity-40"
                    >
                      {t.approvals.reject}
                    </button>
                  </div>
                ) : row.status === "pending" && isOwn ? (
                  <span className="mono text-[11px] text-[var(--color-muted)]">{t.approvals.cannotApproveOwn}</span>
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
