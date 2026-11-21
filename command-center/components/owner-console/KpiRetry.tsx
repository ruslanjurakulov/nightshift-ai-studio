"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

/**
 * "Try again" for a live figure that failed to load. A refresh re-runs the page's server reads; the chat below is client state and
 * survives it (router.refresh keeps client components mounted), so asking for the figures again never wipes the conversation.
 */
export function KpiRetry({ label, busy }: { label: string; busy: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" className="btn-quiet ai-kpi-retry" disabled={pending} onClick={() => start(() => router.refresh())}>
      <RefreshCw aria-hidden size={14} className={pending ? "ai-spin" : undefined} />
      {pending ? busy : label}
    </button>
  );
}
