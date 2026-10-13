"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { exportSignature, pollDelay } from "@/lib/editorExportStatus";
import { fetchProject, type ProjectSnapshot } from "./editorApi";

/** Failed checks in a row before the page says it cannot check (one blip is not news). */
const FAILING_AFTER = 2;

/**
 * Keeps an export's status fresh while one is on its way (`active`): one read
 * of the project (the same GET the editor always used) after each wait, the
 * wait growing from 4 s to 20 s while nothing changes and starting over when
 * something does. It stops by itself when `active` turns false (done or
 * failed), on unmount, and on a refusal that cannot get better (signed out,
 * project gone); it does not ask while the tab is hidden and asks at once when
 * the tab comes back. Read-only: no write, no render, nothing charged.
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
  const [checking, setChecking] = useState(false);
  const latest = useRef(onSnapshot);
  const alive = useRef(true);
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
      const out = await fetchProject(projectId);
      busy = false;
      if (stopped) return;
      if (out.ok) {
        setFailures(0);
        const sig = exportSignature(out.value.exports);
        step = sig === seen ? step + 1 : 0;
        seen = sig;
        latest.current(out.value);
      } else {
        setFailures((f) => f + 1);
        step += 1;
        // Signed out or project gone: asking again cannot help.
        if (out.error === "unauthorized" || out.error === "not_found") return;
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
    };
  }, [active, projectId]);

  /** One read now (the "Check now" / "Get the link" buttons), whether or not a poll is running. */
  const checkNow = useCallback(async () => {
    setChecking(true);
    const out = await fetchProject(projectId);
    if (!alive.current) return;
    setChecking(false);
    if (out.ok) {
      setFailures(0);
      latest.current(out.value);
    } else {
      setFailures((f) => f + 1);
    }
  }, [projectId]);

  return { failing: failures >= FAILING_AFTER, checking, checkNow };
}
