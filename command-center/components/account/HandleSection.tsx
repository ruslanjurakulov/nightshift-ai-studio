"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n/core";
import { formatDay } from "@/lib/date-format";
import { useToast } from "@/components/feedback/ToastProvider";
import { HandleInput } from "@/components/account/HandleInput";
import { useHandleCheck } from "@/components/account/useHandleCheck";
import {
  applyPendingHandle,
  handleAllowsSubmit,
  nextHandleChange,
  parseSetHandle,
  type HandleClient,
  type HandleRow,
} from "@/lib/handles";

/**
 * The @username: shown, and changed with the same live check as sign-up (here
 * through the signed-in function, limited per person). Once every 30 days; the
 * next allowed day is shown. A person with none gets a gentle "Pick your
 * @username" prompt — here only, never a modal. A name chosen at sign-up that
 * could not be applied then (it was taken meanwhile, or the confirmation was
 * opened elsewhere) is applied here once, or its loss is explained.
 */
export function HandleSection({ row, signupHandle }: { row: HandleRow | null; signupHandle: string | null }) {
  const { t, locale } = useI18n();
  const a = t.accountSecurity;
  const router = useRouter();
  const toast = useToast();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const askedRef = useRef(false);

  const ask = useCallback(async (handle: string): Promise<boolean | null> => {
    const supabase = createClient();
    if (!supabase) return null;
    try {
      const { data, error: e } = await supabase.rpc("handle_available", { p_handle: handle });
      return e || typeof data !== "boolean" ? null : data;
    } catch {
      return null;
    }
  }, []);
  const { status, handle } = useHandleCheck(input, ask, { current: row?.handle ?? null });

  const next = nextHandleChange(row);

  // A handle chosen at sign-up that has not landed yet: apply it once.
  useEffect(() => {
    if (row || !signupHandle || askedRef.current) return;
    askedRef.current = true;
    const supabase = createClient();
    if (!supabase) return;
    void applyPendingHandle(supabase as unknown as HandleClient).then((out) => {
      if (out === "applied") router.refresh();
      else if (out === "taken") setLost(true);
    });
  }, [row, signupHandle, router]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !handleAllowsSubmit(status)) return;
    const supabase = createClient();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    try {
      const { data, error: e2 } = await supabase.rpc("set_handle", { p_handle: handle });
      const out = e2 ? { code: "failed" as const } : parseSetHandle(data);
      if (out.code === "ok" || out.code === "same") {
        setInput("");
        setLost(false);
        toast.success(fmt(a.handleSaved, { handle: out.handle ?? handle }));
        router.refresh();
      } else if (out.code === "taken") {
        setError(fmt(t.signup.handleTaken, { handle }));
      } else if (out.code === "invalid") {
        setError(t.signup.handleHint);
      } else if (out.code === "cooldown") {
        const due = out.nextChangeAt ? new Date(out.nextChangeAt) : null;
        setError(due && Number.isFinite(due.getTime()) ? fmt(a.handleCooldown, { date: formatDay(due, locale, "UTC") }) : a.handleFailed);
        router.refresh();
      } else if (out.code === "rate_limited") {
        setError(a.handleRateLimited);
      } else {
        setError(a.handleFailed);
      }
    } catch {
      setError(a.handleFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="handle-section">
      <h3 className="g5-h">{row ? a.handleTitle : a.handlePickTitle}</h3>
      {row ? (
        <p className="g5-note">
          {a.handleYours} <strong className="g5-v">@{row.handle}</strong>
        </p>
      ) : (
        <p className="g5-note">{a.handlePickBody}</p>
      )}
      {lost && !row && (
        <p role="status" className="g5-note">
          {a.handleLostAtSignup}
        </p>
      )}
      {next ? (
        <p className="g5-note">{fmt(a.handleCooldown, { date: formatDay(next, locale, "UTC") })}</p>
      ) : (
        <form onSubmit={save} noValidate className="flex flex-col gap-3">
          <div className="max-w-[24rem]">
            <HandleInput
              variant="app"
              label={row ? a.handleChange : t.signup.handleLabel}
              value={input}
              onChange={(v) => {
                setInput(v);
                setError(null);
              }}
              status={status}
              handle={handle}
              strings={t.signup}
            />
          </div>
          {error && (
            <p role="alert" className="g5-note g5-fail-text">
              {error}
            </p>
          )}
          <div className="g5-actions">
            <button type="submit" className="btn-quiet px-5 text-sm" disabled={busy || !handleAllowsSubmit(status)}>
              {busy ? a.handleSaving : a.handleSave}
            </button>
          </div>
          {row && <p className="g5-note">{a.handleOnce}</p>}
        </form>
      )}
    </div>
  );
}
