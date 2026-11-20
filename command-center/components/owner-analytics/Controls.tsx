"use client";

/**
 * The hub's controls: the period picker, the compare toggle, presentation mode and the export buttons. None of them spends,
 * publishes or writes anything but the export log (an export is recorded before its file is built, server-side).
 */

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download, Presentation, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { createClient } from "@/lib/supabase/client";
import { PRESETS, type Preset } from "@/lib/owner-analytics/period";
import { fill } from "@/lib/owner-analytics/format";

const PRESET_KEY: Record<Preset, "presetToday" | "preset7d" | "preset30d" | "presetMtd" | "presetQtd" | "presetYtd" | "presetCustom"> = {
  today: "presetToday",
  "7d": "preset7d",
  "30d": "preset30d",
  mtd: "presetMtd",
  qtd: "presetQtd",
  ytd: "presetYtd",
  custom: "presetCustom",
};

export function PeriodPicker({
  preset,
  startDay,
  endDay,
  compare,
  includeInternal,
  maxDay,
}: {
  preset: Preset;
  startDay: string;
  endDay: string;
  compare: boolean;
  includeInternal: boolean;
  /** Today in Tashkent: a custom range cannot end after it. */
  maxDay: string;
}) {
  const { t } = useI18n();
  const d = t.ownerAnalytics;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [custom, setCustom] = useState(preset === "custom");
  const [s, setS] = useState(startDay);
  const [e, setE] = useState(endDay);

  function go(next: Record<string, string | null>) {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    start(() => router.push(`${pathname}?${q.toString()}`, { scroll: false }));
  }

  return (
    <div className="oa-picker" role="group" aria-label={d.period} aria-busy={pending || undefined}>
      {PRESETS.filter((p) => p !== "custom").map((p) => (
        <button
          key={p}
          type="button"
          className="oa-chip"
          aria-pressed={preset === p && !custom}
          onClick={() => {
            setCustom(false);
            go({ period: p, start: null, end: null });
          }}
        >
          {d[PRESET_KEY[p]]}
        </button>
      ))}
      <button type="button" className="oa-chip" aria-pressed={custom} onClick={() => setCustom(true)}>
        {d.presetCustom}
      </button>
      {custom && (
        <form
          className="oa-picker"
          onSubmit={(ev) => {
            ev.preventDefault();
            go({ period: "custom", start: s, end: e });
          }}
        >
          <label className="oa-dim text-xs">
            {d.from}{" "}
            <input type="date" value={s} max={maxDay} onChange={(ev) => setS(ev.target.value)} required />
          </label>
          <label className="oa-dim text-xs">
            {d.to}{" "}
            <input type="date" value={e} max={maxDay} min={s} onChange={(ev) => setE(ev.target.value)} required />
          </label>
          <button type="submit" className="oa-chip">
            {d.apply}
          </button>
        </form>
      )}
      <button type="button" className="oa-chip" aria-pressed={compare} onClick={() => go({ compare: compare ? null : "1" })}>
        {d.compare}
      </button>
      <button type="button" className="oa-chip" aria-pressed={includeInternal} onClick={() => go({ internal: includeInternal ? null : "1" })}>
        {d.includeInternal}
      </button>
    </div>
  );
}

export function PresentToggle({ on }: { on: boolean }) {
  const { t } = useI18n();
  const d = t.ownerAnalytics;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  return (
    <span className="oa-picker">
    <button
      type="button"
      className="oa-chip"
      aria-pressed={on}
      aria-label={on ? d.presentToggleOff : d.presentToggleOn}
      disabled={pending}
      data-failed={failed || undefined}
      onClick={async () => {
        setFailed(false);
        try {
          const res = await fetch("/api/owner-analytics/present", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ on: !on }),
          });
          if (!res.ok) throw new Error(String(res.status));
          start(() => router.refresh());
        } catch {
          setFailed(true);
        }
      }}
    >
      <Presentation size={14} aria-hidden /> {d.present}
    </button>
      {failed && (
        <span className="oa-note" data-tone="warn" role="alert">
          {d.presentFailed}
        </span>
      )}
    </span>
  );
}

type Format = "csv" | "xlsx" | "pdf";
type ExportState = { kind: "idle" } | { kind: "busy" } | { kind: "reauth"; format: Format } | { kind: "failed" } | { kind: "tooLarge" } | { kind: "mfa" };

/**
 * CSV and XLSX for one table. The file is built on the server from the database, never from what the browser holds, and the
 * server refuses (401 reauth_required) unless the session signed in within the last few minutes; then the owner confirms their
 * password here and the export is tried once more.
 */
export function ExportButtons({
  what,
  query,
  reauthMinutes,
  title,
  formats = ["csv", "xlsx"],
}: {
  what: string;
  query: string;
  reauthMinutes: number;
  title: string;
  formats?: Array<"csv" | "xlsx" | "pdf">;
}) {
  const { t } = useI18n();
  const d = t.ownerAnalytics;
  const [state, setState] = useState<ExportState>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [reauthError, setReauthError] = useState<string | null>(null);
  const csvRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  // Closing the prompt puts focus back where the owner was, not on the page body.
  const close = () => {
    setState({ kind: "idle" });
    setPassword("");
    requestAnimationFrame(() => csvRef.current?.focus());
  };

  async function download(format: Format) {
    setState({ kind: "busy" });
    try {
      const res = await fetch("/api/owner-analytics/export", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ what, format, query }),
      });
      if (res.status === 401) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === "reauth_required") {
          setState({ kind: "reauth", format });
          return;
        }
        if (body.error === "mfa_required") {
          setState({ kind: "mfa" });
          return;
        }
      }
      if (res.status === 413) {
        setState({ kind: "tooLarge" });
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${what}.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setState({ kind: "idle" });
    } catch {
      setState({ kind: "failed" });
    }
  }

  async function reauth(format: Format) {
    setReauthError(null);
    const supabase = createClient();
    if (!supabase) return setReauthError(d.reauthFailed);
    const { data } = await supabase.auth.getUser();
    const email = data.user?.email;
    // An account that signs in with Google has no password to confirm: it signs in again instead.
    const hasPassword = data.user?.identities?.some((i) => i.provider === "email") ?? false;
    if (!email || !hasPassword) return setReauthError(d.reauthNoPassword);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setPassword("");
    if (error) return setReauthError(d.reauthFailed);
    await download(format);
  }

  return (
    <div className="oa-export">
      {formats.map((f, i) => (
        <button
          key={f}
          type="button"
          ref={i === 0 ? csvRef : undefined}
          onClick={() => download(f)}
          disabled={state.kind === "busy"}
          aria-label={fill(d.exportFor, { format: f === "csv" ? d.exportCsv : f === "xlsx" ? d.exportXlsx : d.exportPdf, title })}
        >
          <Download size={12} aria-hidden /> {f === "csv" ? d.exportCsv : f === "xlsx" ? d.exportXlsx : d.exportPdf}
        </button>
      ))}
      {state.kind === "mfa" && (
        <span className="oa-note" data-tone="warn" role="alert">
          {d.mfaNeeded}{" "}
          <Link href={`/login?next=${encodeURIComponent(pathname)}`}>{d.signInAgain}</Link>
        </span>
      )}
      {state.kind === "tooLarge" && (
        <span className="oa-note" data-tone="warn" role="alert">
          {d.pdfTooLarge}
        </span>
      )}
      {state.kind === "failed" && (
        <span className="oa-note" data-tone="warn" role="alert">
          {d.exportFailed}
        </span>
      )}
      {state.kind === "reauth" && (
        <div
          className="oa-reauth"
          role="dialog"
          aria-modal="false"
          aria-label={d.confirm}
          onKeyDown={(ev) => {
            if (ev.key === "Escape") close();
          }}
        >
          <p className="oa-note">{fill(d.exportReauth, { n: reauthMinutes })}</p>
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              void reauth(state.format);
            }}
          >
            <label className="oa-slider">
              {d.password}
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
                required
                autoFocus
              />
            </label>
            {reauthError && (
              <p className="oa-note" data-tone="warn" role="alert">
                {reauthError}
              </p>
            )}
            <div className="oa-export">
              <button type="submit">{d.confirm}</button>
              <button type="button" onClick={close}>
                <X size={12} aria-hidden /> {d.cancel}
              </button>
            </div>
          </form>
          <p className="oa-note">{d.exportAudited}</p>
        </div>
      )}
    </div>
  );
}

/** Read the page again, in place: the figures that failed are asked for once more, nothing else changes. */
export function RetryButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" className="oa-chip" disabled={pending} onClick={() => start(() => router.refresh())}>
      {label}
    </button>
  );
}
