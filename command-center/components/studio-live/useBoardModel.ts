"use client";

import { useEffect, useRef, useState } from "react";
import { reduceBoard, type BoardInput, type BoardModel } from "@/lib/studio/boardModel";

const frame = (cb: () => void): (() => void) => {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    const id = window.requestAnimationFrame(cb);
    return () => window.cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
};

/**
 * The board's model (lib/studio/boardModel.ts), from the last reading. The first one is drawn at once; after that, readings that land
 * within one frame are folded into one update (LIVE_CREATION_PLAN §3.10: a stream of small changes must not re-render the board per
 * change). `input` must be stable while its reading is: a new object is a new reading.
 *
 * `plan` names what is drawn (a conversation, or a film or run). Another plan starts a new model at once: what boardModel carries from
 * one reading to the next (a brief's character cards kept after Create) must never cross from one plan into another.
 */
export function useBoardModel(input: BoardInput | null, plan: string | null): BoardModel | null {
  const last = useRef<BoardModel | null>(null);
  const [model, setModel] = useState<BoardModel | null>(() => (input ? (last.current = reduceBoard(null, input)) : null));
  const pending = useRef<BoardInput | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const first = useRef(true);
  const planRef = useRef(plan);

  useEffect(() => {
    // The reading the initial state was made from: nothing to do.
    if (first.current) {
      first.current = false;
      if (last.current) return;
    }
    if (!input) {
      cancel.current?.();
      cancel.current = null;
      pending.current = null;
      last.current = null;
      setModel(null);
      return;
    }
    if (planRef.current !== plan) {
      planRef.current = plan;
      cancel.current?.();
      cancel.current = null;
      pending.current = null;
      last.current = null;
    }
    if (!last.current) {
      last.current = reduceBoard(null, input);
      setModel(last.current);
      return;
    }
    pending.current = input;
    if (cancel.current) return;
    cancel.current = frame(() => {
      cancel.current = null;
      const next = pending.current;
      pending.current = null;
      if (!next) return;
      last.current = reduceBoard(last.current, next);
      setModel(last.current);
    });
  }, [input, plan]);

  useEffect(() => () => cancel.current?.(), []);
  return model;
}
