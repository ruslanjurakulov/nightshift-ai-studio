"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { exportSignature, pollDelay } from "@/lib/editorExportStatus";
import { fetchProject, type ProjectSnapshot } from "./editorApi";

/** Failed checks in a row before the page says it cannot check (one blip is not news). */
const FAILING_AFTER = 2;

/** A refusal that asking again cannot fix. */
export type PollHalt = "unauthorized" | "not_found";

/**
 * Keeps an export's status fresh while one is on its way (`active`): one read
 * of the project (the same GET the editor always used) after each wait, the
 * wait growing from 4 s to 20 s while nothing changes and starting over when
 * something does. It stops by itself when `active` turns false (done or
 * failed) and on unmount. A refusal that cannot get better (signed out,
 * project gone) stops it too and is reported at once as `halt`, so the page
 * can say so instead of sitting on "rendering". It does not ask while the tab
 * is hidden and asks at once when the tab comes back. Answers are applied in
 * the order they were ASKED: a slow older answer never overwrites a newer one.
 * Read-only: no write, no render, nothing charged.
 */
export function useExportPoll({
  projectId,
  active,
  onSnapshot,
}: {
  projectId: string;
  active: boolean;
  onSnapshot: (s: ProjectSnapshot) => void;
}) {
  const [failures, setFailures] = useState(0);
  const [halt, setHalt] = useState<PollHalt | null>(null);
  const [checking, setChecking] = useState(false);
  const latest = useRef(onSnapshot);
  const alive = useRef(true);
  /** Counts every read asked, by the poll or by checkNow; only the newest answer is applied. */
  const asked = useRef(0);
  /** Check-now reads still waiting for an answer (the button reads "Checking…" while any is). */
  const pending = useRef(0);
  useEffect(() => {
    latest.current = onSnapshot;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let busy = false;
    let step = 0;
    let seen = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      timer = setTimeout(() => void tick(), pollDelay(step));
    };
    const tick = async () => {
      if (stopped || busy) return;
      if (typeof document !== "undefined" && document.hidden) {
        schedule();
        return;
      }
      busy = true;
      const mine = ++asked.current;
      const out = await fetchProject(projectId);
      busy = false;
      if (stopped) return;
      if (mine !== asked.current) {
        // A newer read (Check now) was asked meanwhile and has the say.
        schedule();
        return;
      }
      if (out.ok) {
        setFailures(0);
        setHalt(null);
        const sig = exportSignature(out.value.exports);
        step = sig === seen ? step + 1 : 0;
        seen = sig;
        latest.current(out.value);
      } else {
        // Signed out or project gone: asking again cannot help. Say so now, not after two more misses.
        if (out.error === "unauthorized" || out.error === "not_found") {
          setHalt(out.error);
          return;
        }
        setFailures((f) => f + 1);
        step += 1;
      }
      schedule();
    };
    const onVisible = () => {
      if (document.hidden || stopped || busy) return;
      clearTimeout(timer);
      step = 0;
      void tick();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      setFailures(0);
      setHalt(null);
    };
  }, [active, projectId]);

  /** One read now (the "Check now" / "Get the link" buttons), whether or not a poll is running. */
  const checkNow = useCallback(async () => {
    pending.current += 1;
    setChecking(true);
    const mine = ++asked.current;
    const out = await fetchProject(projectId);
    pending.current -= 1;
    if (!alive.current) return;
    setChecking(pending.current > 0);
    if (mine !== asked.current) return; // a newer read answered (or will answer) instead
    if (out.ok) {
      setFailures(0);
      setHalt(null);
      latest.current(out.value);
    } else if (out.error === "unauthorized" || out.error === "not_found") {
      setHalt(out.error);
    } else {
      setFailures((f) => f + 1);
    }
  }, [projectId]);

  return { failing: failures >= FAILING_AFTER || halt !== null, halt, checking, checkNow };
}
