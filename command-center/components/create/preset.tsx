"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * A starting point handed to the create form from outside it (Home's goal
 * cards): a topic and a length. It only fills the form — the price and the
 * two-press confirm are CreateStudio's, unchanged.
 *
 * Home server-renders CreateStudio and passes it down as an element, so the
 * cards cannot call into it directly; both sit under this provider instead.
 * `nonce` changes on every pick, so choosing the same card twice still refills
 * the form after the person has edited it.
 */
export interface CreatePreset {
  brief: string;
  /** Seconds as the form's length control holds them ("600"). */
  duration: string;
}

interface Ctx {
  preset: (CreatePreset & { nonce: number }) | null;
  apply: (p: CreatePreset) => void;
}

const PresetContext = createContext<Ctx | null>(null);

export function CreatePresetProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Ctx["preset"]>(null);
  const apply = useCallback((p: CreatePreset) => setCurrent((c) => ({ ...p, nonce: (c?.nonce ?? 0) + 1 })), []);
  const value = useMemo(() => ({ preset: current, apply }), [current, apply]);
  return <PresetContext.Provider value={value}>{children}</PresetContext.Provider>;
}

/** Null outside a provider (the Create page): the form then simply has no cards feeding it. */
export function useCreatePreset(): Ctx | null {
  return useContext(PresetContext);
}
