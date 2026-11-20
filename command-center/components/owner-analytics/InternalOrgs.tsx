"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";

export interface InternalOrgView {
  orgId: string;
  name: string;
  source: "default" | "flag" | "roster";
  reason: string | null;
}

/**
 * The owner's list of internal and test workspaces. A flag changes only what the hub counts by default. Not rendered at all
 * in presentation mode: it names workspaces.
 */
export function InternalOrgs({ rows }: { rows: InternalOrgView[] }) {
  const { t } = useI18n();
  const d = t.ownerAnalytics;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [org, setOrg] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function send(body: { org: string; on: boolean; reason?: string }) {
    setError(null);
    try {
      const res = await fetch("/api/owner-analytics/internal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = ((await res.json().catch(() => ({}))) as { error?: string }).error;
        setError(e === "invalid_request" ? d.flagInvalid : e === "mfa_required" ? d.mfaNeeded : d.flagFailed);
        return;
      }
      setOrg("");
      setReason("");
      start(() => router.refresh());
    } catch {
      setError(d.flagFailed);
    }
  }

  const source = (s: InternalOrgView["source"]) =>
    s === "default" ? d.internalSourceDefault : s === "roster" ? d.internalSourceRoster : d.internalSourceFlag;

  return (
    <div className="oa-card" aria-busy={pending || undefined}>
      <div>
        <h2>{d.internalOrgs}</h2>
        <p className="oa-note">{d.internalOrgsNote}</p>
      </div>
      <div className="oa-table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">{d.workspaceId}</th>
              <th scope="col">{d.source}</th>
              <th scope="col">{d.reason}</th>
              <th scope="col">{d.tableActions}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.orgId}>
                <th scope="row">{r.name || r.orgId}</th>
                <td>{source(r.source)}</td>
                <td>{r.reason ?? ""}</td>
                <td>
                  {r.source === "flag" && (
                    <button type="button" className="oa-chip" disabled={pending} onClick={() => send({ org: r.orgId, on: false })}>
                      {d.unflag}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="oa-picker"
        onSubmit={(e) => {
          e.preventDefault();
          void send({ org, on: true, reason });
        }}
      >
        <label className="oa-slider">
          {d.workspaceId}
          <input value={org} onChange={(e) => setOrg(e.target.value)} required inputMode="text" autoComplete="off" spellCheck={false} />
        </label>
        <label className="oa-slider">
          {d.reason}
          <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={200} />
        </label>
        <button type="submit" className="oa-chip" disabled={pending}>
          {d.flag}
        </button>
      </form>
      {error && (
        <p className="oa-note" data-tone="warn" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
