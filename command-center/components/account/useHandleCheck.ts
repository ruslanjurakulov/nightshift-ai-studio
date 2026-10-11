"use client";

import { useEffect, useState } from "react";
import {
  checkHandleFormat,
  isReservedHandle,
  normalizeHandleInput,
  parseAvailability,
  type HandleStatus,
} from "@/lib/handles";

/** How long typing must pause before the name is asked about. */
export const HANDLE_DEBOUNCE_MS = 400;

/** One answer: true free, false held (or malformed, or reserved), null cannot say now. */
export type AvailabilityCheck = (handle: string) => Promise<boolean | null>;

/**
 * The live state of a username field.
 *
 * Nothing is asked until the shape is right (a wrong shape is stated as a rule,
 * not sent), a reserved word is "taken" without asking (the database says the
 * same), and a name is asked about once typing has paused for ~400 ms. Only the
 * newest question counts: an answer for a name that has since been edited away
 * is never shown. `current` is the person's own handle ("that is already yours").
 */
export function useHandleCheck(
  value: string,
  check: AvailabilityCheck,
  options: { current?: string | null; debounceMs?: number } = {},
): { status: HandleStatus; handle: string } {
  const handle = normalizeHandleInput(value);
  const debounceMs = options.debounceMs ?? HANDLE_DEBOUNCE_MS;
  const [answer, setAnswer] = useState<{ handle: string; result: "available" | "taken" | "unknown" } | null>(null);

  const problem = handle ? checkHandleFormat(handle) : null;
  const local: HandleStatus | null = !handle
    ? { kind: "idle" }
    : problem
      ? { kind: "rule", problem }
      : options.current && handle === options.current
        ? { kind: "same" }
        : isReservedHandle(handle)
          ? { kind: "taken" }
          : null;

  useEffect(() => {
    if (local) return;
    let live = true;
    const timer = setTimeout(async () => {
      let result: "available" | "taken" | "unknown";
      try {
        result = parseAvailability(await check(handle));
      } catch {
        result = "unknown";
      }
      if (live) setAnswer({ handle, result });
    }, debounceMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `check` is a stable function of the page; the name is what drives a new question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, local === null, debounceMs]);

  if (local) return { status: local, handle };
  if (answer && answer.handle === handle) return { status: { kind: answer.result }, handle };
  return { status: { kind: "checking" }, handle };
}
