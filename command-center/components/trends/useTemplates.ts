"use client";

import { useCallback, useEffect, useState } from "react";
import type { Locale } from "@/lib/i18n/core";
import type { TemplateDto } from "@/lib/templates/trends";

/** loading → ok (possibly empty) | not_enabled (0181 not applied) | error. Never an empty list standing in for a failure. */
export type TemplatesState =
  | { phase: "loading" }
  | { phase: "ok"; templates: TemplateDto[] }
  | { phase: "not_enabled" }
  /** 401 from the sign-in gate: retrying cannot help, signing in again does. */
  | { phase: "signed_out" }
  | { phase: "error" };

/** Reads /api/templates in the viewer's language. A read only: nothing here prices or starts anything. */
export function useTemplates(locale: Locale, limit?: number): { state: TemplatesState; retry: () => void } {
  const [state, setState] = useState<TemplatesState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ phase: "loading" });
    const qs = new URLSearchParams({ locale });
    if (limit) qs.set("limit", String(limit));
    fetch(`/api/templates?${qs.toString()}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null);
        const obj = typeof body === "object" && body !== null ? (body as { templates?: unknown; error?: unknown }) : {};
        // By the body, not the status: a 503 is also "auth server down" or "not configured", which need another remedy.
        if (obj.error === "not_enabled") return setState({ phase: "not_enabled" });
        if (res.status === 401) return setState({ phase: "signed_out" });
        const list = obj.templates;
        if (!res.ok || !Array.isArray(list)) return setState({ phase: "error" });
        setState({ phase: "ok", templates: list as TemplateDto[] });
      })
      .catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setState({ phase: "error" });
      });
    return () => ctrl.abort();
  }, [locale, limit, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}

/** prefers-reduced-motion, live. Server render and first paint assume reduced (poster only) so nothing moves before we know. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** A pointer that can hover (desktop): previews play on hover. Otherwise (touch) a tap plays them. */
export function useCanHover(): boolean {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setHover(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return hover;
}
