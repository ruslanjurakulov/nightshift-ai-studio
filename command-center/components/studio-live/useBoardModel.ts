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

type State = { model: BoardModel | null; plan: string | null; input: BoardInput | null };

/**
 * The board's model (lib/studio/boardModel.ts), from the last reading. A plan's first reading is drawn in the same render that
 * brought it (nothing waits a frame to appear); after that, readings that land within one frame are folded into one update
 * (LIVE_CREATION_PLAN §3.10: a stream of small changes must not re-render the board per change). `input` must be stable while its
 * reading is: a new object is a new reading.
 *
 * `plan` names what is drawn (a conversation, or a film or run). Another plan starts a new model at once: what boardModel carries from
 * one reading to the next (a brief's character cards kept after Create) must never cross from one plan into another.
 */
export function useBoardModel(input: BoardInput | null, plan: string | null): BoardModel | null {
  const [state, setState] = useState<State>(() => ({ model: input ? reduceBoard(null, input) : null, plan, input }));
  let current = state;
  if (input && (state.model === null || state.plan !== plan)) {
    current = { model: reduceBoard(null, input), plan, input };
    setState(current);
  } else if (!input && state.model !== null) {
    current = { model: null, plan, input: null };
    setState(current);
  }

  const pending = useRef<BoardInput | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!input || input === state.input) return;
    pending.current = input;
    if (cancel.current) return;
    cancel.current = frame(() => {
      cancel.current = null;
      const next = pending.current;
      pending.current = null;
      if (!next) return;
      setState((s) => (s.model && s.plan === plan ? { model: reduceBoard(s.model, next), plan, input: next } : s));
    });
  }, [input, plan, state.input]);
  useEffect(
    () => () => {
      cancel.current?.();
      cancel.current = null;
    },
    [],
  );
  // Another plan, or none: a frame scheduled for the last one lands nowhere.
  useEffect(() => {
    pending.current = null;
  }, [plan]);
  return current.model;
}
