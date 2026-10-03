"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Clapperboard,
  Film,
  ImageIcon,
  Loader2,
  Mic,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { formatCredits, creditRunError, type CreditEstimate } from "@/lib/credits";
import { apiErrorMessage, asCreativeError, ASPECT_RATIOS, VIDEO_DURATIONS, type StudioModel } from "@/lib/creative/studio";
import { HOME_LANGUAGES, HOME_LENGTHS } from "@/lib/home";
import {
  GOAL_MAX,
  MAX_COUNT,
  MAX_STEPS,
  SHORT_S,
  STEP_KINDS,
  addStep,
  isRunKind,
  itemBody,
  newPlanId,
  planFromGoal,
  planItems,
  planTotal,
  priceKey,
  removeStep,
  stepBlocker,
  stepCost,
  stepRequest,
  textMax,
  updateStep,
  type Plan,
  type PlanStep,
  type PlannerChannel,
  type StepEnv,
  type StepKind,
  type StepPatch,
  type StepPrice,
  type StepRequest,
} from "@/lib/assistant/plan";

const KIND_ICON: Record<StepKind, LucideIcon> = {
  video: Film,
  thumbnail: ImageIcon,
  cover: ImageIcon,
  image: ImageIcon,
  clip: Clapperboard,
  voice: Mic,
};

const QUOTE_DELAY_MS = 350;
export const ASSISTANT_STORAGE_KEY = "nightshift.assistant.plan.v1";

type Phase = "plan" | "running" | "stopped" | "done";
type ItemStatus = "pending" | "creating" | "done" | "failed" | "unknown";
interface ItemState {
  status: ItemStatus;
  message?: string;
  /** Failed after credits were held (a run whose dispatch failed): never re-sent with the same key. */
  final?: boolean;
}
type Confirmed = Record<string, { unit: number; free: boolean }>;

interface Saved {
  orgId: string | null;
  plan: Plan;
  phase: Phase;
  items: Record<string, ItemState>;
  confirmed: Confirmed;
}

/** Per-viewer only: the confirmed plan survives a reload so its keys (and so the server's replay answers) stay the same. */
function readSaved(orgId: string | null): Saved | null {
  try {
    const raw = window.localStorage.getItem(ASSISTANT_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Saved;
    if (!v || !v.plan || !Array.isArray(v.plan.steps) || v.orgId !== orgId) return null;
    return v;
  } catch {
    return null;
  }
}

function writeSaved(v: Saved | null) {
  try {
    if (v) window.localStorage.setItem(ASSISTANT_STORAGE_KEY, JSON.stringify(v));
    else window.localStorage.removeItem(ASSISTANT_STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: the plan lives for this visit only.
  }
}

/**
 * One item's price, asked of the existing routes. Nothing is held: the
 * creative quote is the database's price (0036), the run estimate is what
 * Run now would reserve (/api/credits/estimate). A read that failed, or a
 * step with no honest price, is an error with the reason — never a number.
 */
async function fetchPrice(req: StepRequest, orgId: string | null, t: Dictionary): Promise<StepPrice> {
  try {
    if (req.type === "creative") {
      const res = await fetch("/api/creative/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org_id: orgId, capability: req.capability, model: req.model, params: req.params }),
      });
      const body = (await res.json().catch(() => ({}))) as { quote?: { credits?: unknown }; error?: unknown };
      const credits = body.quote?.credits;
      return res.ok && typeof credits === "number" && Number.isFinite(credits)
        ? { status: "ready", unit: credits, free: false }
        : { status: "error", message: apiErrorMessage(t, body.error) };
    }
    const qs = new URLSearchParams({ channel: req.channelId, duration: String(req.duration) });
    const res = await fetch(`/api/credits/estimate?${qs}`, { cache: "no-store" });
    if (!res.ok) return { status: "error", message: t.assistant.priceUnknown };
    const d = (await res.json().catch(() => ({}))) as {
      supported?: boolean;
      exempt?: boolean;
      estimate?: CreditEstimate | null;
    };
    if (!d.supported) return { status: "error", message: t.assistant.priceUnavailable };
    if (d.exempt) return { status: "ready", unit: 0, free: true };
    const credits = d.estimate?.credits;
    if (typeof credits !== "number" || !Number.isFinite(credits)) {
      const gap = d.estimate?.gap ? t.credits.gap[d.estimate.gap] : "";
      return { status: "error", message: gap ? `${t.credits.estimateUnavailable} ${gap}` : t.credits.estimateUnavailable };
    }
    return { status: "ready", unit: credits, free: false };
  } catch {
    return { status: "error", message: t.assistant.priceUnknown };
  }
}

type SendResult = { ok: true } | { ok: false; message: string; priceChanged: boolean; final: boolean; unknown: boolean };

/**
 * Start one item with the building block that already exists: a creative job
 * (the confirmed price as `max_credits`) or a channel Run now. The key is the
 * item's own, so a replay answers the first job (creative: 200 replay; run:
 * 409 `run_already_started`) and is counted as started, never started again.
 */
async function sendItem(req: StepRequest, body: Record<string, unknown>, free: boolean, t: Dictionary, locale: string): Promise<SendResult> {
  const url = req.type === "creative" ? "/api/creative/jobs" : "/api/agent/run";
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    // Unknown whether it reached the server. The same key makes a re-send
    // safe wherever the server checks it; a run with no hold (no charge) has
    // no such check, so it is reported as "may have started", not re-sent.
    return { ok: false, message: t.creative.errors.failed, priceChanged: false, final: false, unknown: req.type === "run" && free };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true };
  if (req.type === "run" && res.status === 409 && data.error === "run_already_started") return { ok: true };
  if (req.type === "creative") {
    const code = asCreativeError(data.error);
    return { ok: false, message: apiErrorMessage(t, code), priceChanged: code === "price_changed", final: false, unknown: false };
  }
  const priceChanged = data.error === "price_changed";
  const message = priceChanged ? t.creative.errors.price_changed : (creditRunError(data, t, locale) ?? t.agents.runFailed);
  const held = typeof data.credits_held === "number";
  return { ok: false, message, priceChanged, final: held, unknown: false };
}

export interface AssistantPlannerProps {
  orgId: string | null;
  models: StudioModel[];
  /** Verified channels (rule 7): the ones a video can be made for. */
  channels: PlannerChannel[];
  currentSlug: string | null;
  /** Owner/admin of the organization — what Run now requires. Presentation only; the route re-checks. */
  canRun: boolean;
  /** Run now is wired on this deployment. */
  runConfigured: boolean;
}

/**
 * "Assistant" (Yordamchi): one goal → a plan with one total price → one
 * confirm. Making and editing the plan only asks prices (nothing held).
 * Start creates each item in turn with the existing creative jobs and Run
 * now — the same holds, captures and credits-back — and stops at the first
 * refusal before spending more. Videos land at the approval gate; nothing
 * here publishes, re-renders or touches the gate.
 */
export function AssistantPlanner({ orgId, models, channels, currentSlug, canRun, runConfigured }: AssistantPlannerProps) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  const [goal, setGoal] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [phase, setPhase] = useState<Phase>("plan");
  const [items, setItems] = useState<Record<string, ItemState>>({});
  const [confirmed, setConfirmed] = useState<Confirmed>({});
  const [reloaded, setReloaded] = useState(false);
  const [prices, setPrices] = useState<Record<string, StepPrice>>({});
  const [requoteNonce, setRequoteNonce] = useState(0);
  const busy = useRef(false);
  const inflight = useRef(new Set<string>());
  const pricesRef = useRef(prices);
  pricesRef.current = prices;

  const env: StepEnv = useMemo(
    () => ({ orgId, models, channels, canRun, runConfigured }),
    [orgId, models, channels, canRun, runConfigured],
  );
  const ctx = useMemo(() => ({ locale, channels, currentSlug }), [locale, channels, currentSlug]);

  // A confirmed plan comes back after a reload, with its keys.
  useEffect(() => {
    const saved = readSaved(orgId);
    if (!saved || saved.phase === "plan") return;
    let wasRunning = false;
    const restored: Record<string, ItemState> = {};
    for (const it of planItems(saved.plan)) {
      const s = saved.items[it.key];
      if (s?.status === "creating") {
        wasRunning = true;
        const free = saved.confirmed[it.step.id]?.free ?? false;
        restored[it.key] = isRunKind(it.step.kind) && free ? { status: "unknown" } : { status: "pending" };
      } else if (s) restored[it.key] = s;
    }
    setPlan(saved.plan);
    setGoal(saved.plan.goal);
    setItems(restored);
    setConfirmed(saved.confirmed);
    setPhase(saved.phase === "running" ? "stopped" : saved.phase);
    setReloaded(wasRunning || saved.phase === "running");
  }, [orgId]);

  // ── prices (plan phase only) ─────────────────────────────────────────────
  const editing = phase === "plan";
  const requests = useMemo(() => {
    const m = new Map<string, StepRequest>();
    if (!plan || !editing) return m;
    for (const s of plan.steps) {
      const r = stepRequest(s, env);
      if (r) m.set(priceKey(r), r);
    }
    return m;
  }, [plan, env, editing]);
  const requestSig = [...requests.keys()].join("|");

  useEffect(() => {
    const todo = [...requests.keys()].filter((k) => !pricesRef.current[k] && !inflight.current.has(k));
    if (!todo.length) return;
    const timer = setTimeout(() => {
      for (const k of todo) {
        const req = requests.get(k);
        if (!req) continue;
        inflight.current.add(k);
        setPrices((p) => ({ ...p, [k]: { status: "quoting" } }));
        void fetchPrice(req, orgId, t).then((price) => {
          inflight.current.delete(k);
          setPrices((p) => ({ ...p, [k]: price }));
        });
      }
    }, QUOTE_DELAY_MS);
    return () => clearTimeout(timer);
    // `requests` is keyed by requestSig; t only words the errors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSig, requoteNonce, orgId]);

  const priceOf = (s: PlanStep): StepPrice | undefined => {
    if (!editing) {
      const c = confirmed[s.id];
      return c ? { status: "ready", unit: c.unit, free: c.free } : undefined;
    }
    const r = stepRequest(s, env);
    return r ? prices[priceKey(r)] : undefined;
  };

  const requote = (s: PlanStep) => {
    const r = stepRequest(s, env);
    if (!r) return;
    const k = priceKey(r);
    setPrices((p) => {
      const next = { ...p };
      delete next[k];
      return next;
    });
    setRequoteNonce((n) => n + 1);
  };

  // ── plan editing ─────────────────────────────────────────────────────────
  function makePlan() {
    if (!goal.trim()) return;
    setPlan(planFromGoal(goal, ctx, newPlanId()));
    setPhase("plan");
    setItems({});
    setConfirmed({});
    setReloaded(false);
  }

  const edit = (stepId: string, patch: StepPatch) => setPlan((p) => (p && editing ? updateStep(p, stepId, patch) : p));

  function reset() {
    writeSaved(null);
    setPlan(null);
    setPhase("plan");
    setItems({});
    setConfirmed({});
    setReloaded(false);
  }

  // ── confirm ──────────────────────────────────────────────────────────────
  const total = plan ? planTotal(plan.steps, env, priceOf) : ({ status: "empty" } as const);

  async function run(fromPlan: Plan, units: Confirmed, start: Record<string, ItemState>) {
    if (busy.current) return;
    busy.current = true;
    setReloaded(false);
    const cur: Record<string, ItemState> = { ...start };
    const commit = (ph: Phase) => {
      setItems({ ...cur });
      setPhase(ph);
      writeSaved({ orgId, plan: fromPlan, phase: ph, items: cur, confirmed: units });
    };
    commit("running");
    try {
      for (const it of planItems(fromPlan)) {
        const prev = cur[it.key];
        if (prev?.status === "done" || prev?.status === "unknown" || prev?.final) continue;
        const req = stepRequest(it.step, env);
        const unit = units[it.step.id];
        if (!req || !unit) {
          cur[it.key] = { status: "failed", message: t.assistant.priceUnknown };
          commit("stopped");
          return;
        }
        cur[it.key] = { status: "creating" };
        commit("running");
        const out = await sendItem(req, itemBody(req, it.key, unit.unit, unit.free, orgId), unit.free, t, locale);
        if (out.ok) {
          cur[it.key] = { status: "done" };
          continue;
        }
        cur[it.key] = out.unknown ? { status: "unknown" } : { status: "failed", message: out.message, final: out.final };
        if (out.priceChanged) {
          // Ask the new price; Continue then shows it and is the new confirm.
          const p = await fetchPrice(req, orgId, t);
          if (p.status === "ready") units[it.step.id] = { unit: p.unit, free: p.free };
          setConfirmed({ ...units });
        }
        // A refusal stops the rest before anything more is spent.
        commit("stopped");
        return;
      }
      commit("done");
    } finally {
      busy.current = false;
    }
  }

  function confirm() {
    if (!plan || phase !== "plan" || total.status !== "ready") return;
    const units: Confirmed = {};
    for (const s of plan.steps) {
      const p = priceOf(s);
      if (p?.status !== "ready") return;
      units[s.id] = { unit: p.unit, free: p.free };
    }
    setConfirmed(units);
    void run(plan, units, {});
  }

  function resume() {
    if (!plan || phase !== "stopped") return;
    const start: Record<string, ItemState> = {};
    for (const [k, v] of Object.entries(items)) start[k] = v.status === "failed" && !v.final ? { status: "pending" } : v;
    void run(plan, { ...confirmed }, start);
  }

  const allItems = plan ? planItems(plan) : [];
  const doneCount = allItems.filter((i) => items[i.key]?.status === "done").length;
  const remaining = allItems.reduce((sum, i) => {
    const s = items[i.key];
    if (s?.status === "done" || s?.status === "unknown" || s?.final) return sum;
    return sum + (confirmed[i.step.id]?.unit ?? 0);
  }, 0);
  const remainingRounded = Math.round(remaining * 100) / 100;
  const canContinue = allItems.some((i) => {
    const s = items[i.key];
    return !(s?.status === "done" || s?.status === "unknown" || s?.final);
  });
  const stoppedItem = allItems.find((i) => items[i.key]?.status === "failed");

  const blockedText =
    total.status === "blocked"
      ? fmt(t.assistant.blockedStep, {
          n: total.stepIndex + 1,
          reason: "blocker" in total.reason ? t.assistant.blockers[total.reason.blocker] : total.reason.message,
        })
      : null;

  const startLabel =
    total.status === "ready"
      ? total.free
        ? t.assistant.startFree
        : fmt(t.assistant.start, { n: formatCredits(total.total, locale) })
      : t.assistant.startPlain;

  const chip =
    "pill min-h-9 border border-[var(--color-border)] bg-transparent px-3 text-sm text-[var(--color-fg)] outline-none focus-visible:border-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] disabled:opacity-60";

  return (
    <section aria-labelledby="assistant-title" className="flex flex-col gap-3" data-testid="assistant">
      <div className="flex flex-col gap-0.5">
        <h2 id="assistant-title" className="t-panel flex items-center gap-2">
          <Sparkles aria-hidden className="size-4 text-[var(--color-primary)]" />
          {t.assistant.title}
        </h2>
        <p className="text-sm text-[var(--color-muted)]">{t.assistant.lead}</p>
      </div>

      <div className="flex flex-col gap-4 rounded-[20px] border border-[var(--color-border)] bg-[var(--color-panel)] p-3 sm:p-4">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (editing) makePlan();
          }}
        >
          <label htmlFor="assistant-goal" className="text-xs font-medium text-[var(--color-muted)]">
            {t.assistant.goalLabel}
          </label>
          <textarea
            id="assistant-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && editing) {
                e.preventDefault();
                makePlan();
              }
            }}
            disabled={!editing}
            rows={3}
            maxLength={GOAL_MAX}
            placeholder={t.assistant.placeholder}
            // 16px: iOS zooms the page into any smaller text field.
            className="w-full resize-none rounded-[14px] border border-[var(--color-border)] bg-transparent px-3 py-2 text-base leading-relaxed text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] disabled:opacity-70"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={!editing || !goal.trim()}
              className="pill inline-flex min-h-11 items-center gap-1.5 border border-[var(--color-border)] px-4 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] disabled:opacity-50"
            >
              <Sparkles aria-hidden className="size-4" />
              {plan ? t.assistant.replan : t.assistant.makePlan}
            </button>
            <span className="text-xs text-[var(--color-muted)]">{t.assistant.planFree}</span>
          </div>
        </form>

        {plan && (
          <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">{t.assistant.planTitle}</h3>
            {plan.guessed && <p className="text-xs text-[var(--color-warn)]">{t.assistant.guessed}</p>}
            {plan.steps.length === 0 && <p className="text-sm text-[var(--color-muted)]">{t.assistant.noSteps}</p>}

            <ol className="flex flex-col gap-2.5" aria-label={t.assistant.planTitle}>
              {plan.steps.map((s, i) => (
                <StepCard
                  key={s.id}
                  step={s}
                  index={i}
                  env={env}
                  editing={editing}
                  price={priceOf(s)}
                  items={allItems.filter((it) => it.step.id === s.id).map((it) => items[it.key])}
                  onEdit={(patch) => edit(s.id, patch)}
                  onRemove={() => setPlan((p) => (p && editing ? removeStep(p, s.id) : p))}
                  onRequote={() => requote(s)}
                  resultHref={isRunKind(s.kind) ? (s.channelSlug ? `/${encodeURIComponent(s.channelSlug)}/videos` : null) : path("/create")}
                  chip={chip}
                />
              ))}
            </ol>

            {editing && (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2">
                  <span className="sr-only">{t.assistant.addStep}</span>
                  <select
                    value=""
                    disabled={plan.steps.length >= MAX_STEPS}
                    onChange={(e) => {
                      const k = e.target.value as StepKind;
                      if ((STEP_KINDS as readonly string[]).includes(k)) setPlan((p) => (p ? addStep(p, k, ctx) : p));
                    }}
                    className={chip}
                  >
                    <option value="">{t.assistant.addStepPick}</option>
                    {STEP_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t.assistant.kinds[k]}
                      </option>
                    ))}
                  </select>
                </label>
                {plan.steps.length >= MAX_STEPS && (
                  <span className="text-xs text-[var(--color-muted)]">{fmt(t.assistant.maxSteps, { n: MAX_STEPS })}</span>
                )}
              </div>
            )}

            {/* ── the total and the one confirm ─────────────────────────── */}
            <div className="flex flex-col gap-2 rounded-[16px] bg-[var(--color-panel-2)] p-3">
              {editing ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-[var(--color-muted)]">{t.assistant.totalLabel}</span>
                    <span className="tnum text-[15px] font-semibold text-[var(--color-fg)]" data-testid="assistant-total" aria-live="polite">
                      {total.status === "ready"
                        ? total.free
                          ? t.assistant.noCharge
                          : fmt(t.assistant.totalCredits, { n: formatCredits(total.total, locale) })
                        : total.status === "pending"
                          ? t.assistant.totalPending
                          : "—"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={confirm}
                    disabled={total.status !== "ready"}
                    aria-describedby={blockedText ? "assistant-blocked" : "assistant-safety"}
                    className="cta-glass pill inline-flex min-h-11 w-full items-center justify-center gap-2 px-5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {startLabel}
                  </button>
                  {blockedText && (
                    <p id="assistant-blocked" role="status" className="text-xs text-[var(--color-warn)]">
                      {blockedText}
                    </p>
                  )}
                </>
              ) : (
                <div className="flex flex-col gap-2" aria-live="polite">
                  <p className="text-sm font-medium text-[var(--color-fg)]" data-testid="assistant-progress">
                    {fmt(t.assistant.progress, { done: doneCount, total: allItems.length })}
                  </p>
                  {phase === "running" && (
                    <p className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
                      <Loader2 aria-hidden className="size-3.5 animate-spin" />
                      {t.assistant.status.creating}
                    </p>
                  )}
                  {phase === "stopped" && (
                    <div role="alert" className="flex flex-col gap-1 text-xs">
                      {stoppedItem && items[stoppedItem.key]?.message && (
                        <p className="text-[var(--color-fail)]">{items[stoppedItem.key]?.message}</p>
                      )}
                      <p className="text-[var(--color-muted)]">{reloaded ? t.assistant.reloaded : t.assistant.stopped}</p>
                    </div>
                  )}
                  {phase === "done" && <p className="text-xs text-[var(--color-ok)]">{t.assistant.done}</p>}
                  <div className="flex flex-wrap gap-2">
                    {phase === "stopped" && canContinue && (
                      <button
                        type="button"
                        onClick={resume}
                        className="cta-glass pill inline-flex min-h-11 items-center justify-center gap-2 px-5 text-sm font-semibold"
                      >
                        {remainingRounded > 0 ? fmt(t.assistant.continue, { n: formatCredits(remainingRounded, locale) }) : t.assistant.continueFree}
                      </button>
                    )}
                    {phase !== "running" && (
                      <button
                        type="button"
                        onClick={reset}
                        className="pill inline-flex min-h-11 items-center gap-1.5 border border-[var(--color-border)] px-4 text-sm text-[var(--color-fg)] hover:border-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
                      >
                        {t.assistant.newPlan}
                      </button>
                    )}
                  </div>
                </div>
              )}
              <p id="assistant-safety" className="text-xs leading-relaxed text-[var(--color-muted)]">
                {t.assistant.safety}
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function StepCard({
  step,
  index,
  env,
  editing,
  price,
  items,
  onEdit,
  onRemove,
  onRequote,
  resultHref,
  chip,
}: {
  step: PlanStep;
  index: number;
  env: StepEnv;
  editing: boolean;
  price: StepPrice | undefined;
  items: (ItemState | undefined)[];
  onEdit: (patch: StepPatch) => void;
  onRemove: () => void;
  onRequote: () => void;
  resultHref: string | null;
  chip: string;
}) {
  const { t, locale } = useI18n();
  const Icon = KIND_ICON[step.kind];
  const run = isRunKind(step.kind);
  const kindLabel = run && step.durationS === SHORT_S ? t.assistant.kinds.short : t.assistant.kinds[step.kind];
  const titleId = `assistant-step-${step.id}`;
  const label = fmt(t.assistant.stepLabel, { n: index + 1 });
  const blocker = stepBlocker(step, env);
  const cost = stepCost(step, price);
  const done = items.filter((s) => s?.status === "done").length;
  const failed = items.find((s) => s?.status === "failed");
  const creating = items.some((s) => s?.status === "creating");
  const unknown = items.some((s) => s?.status === "unknown");
  const started = items.some((s) => s !== undefined);
  const textLabel = run
    ? step.count > 1
      ? t.assistant.themeLabel
      : t.assistant.topicLabel
    : step.kind === "voice"
      ? t.assistant.wordsLabel
      : t.assistant.describeLabel;
  const field = (name: string) => `assistant-${step.id}-${name}`;
  const small = "text-xs font-medium text-[var(--color-muted)]";

  return (
    <li
      aria-labelledby={titleId}
      data-step={step.id}
      className="flex flex-col gap-3 rounded-[16px] border border-[var(--color-border)] bg-[var(--color-bg)] p-3"
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-[var(--color-panel-2)] text-[var(--color-primary)]">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p id={titleId} className="text-sm font-medium leading-snug text-[var(--color-fg)]">
            <span className="sr-only">{label}: </span>
            {fmt(t.assistant.stepTitle, { count: step.count, kind: kindLabel })}
          </p>
          <p className="tnum text-xs text-[var(--color-muted)]" data-testid="step-price">
            {blocker ? (
              <span className="text-[var(--color-warn)]">{t.assistant.blockers[blocker]}</span>
            ) : !price || price.status === "quoting" ? (
              t.assistant.quoting
            ) : price.status === "error" ? (
              <span className="text-[var(--color-warn)]">{price.message}</span>
            ) : price.free ? (
              t.assistant.noCharge
            ) : (
              <>
                {fmt(t.assistant.stepCost, { n: formatCredits(cost, locale) })}
                {step.count > 1 && <> · {fmt(t.assistant.each, { n: formatCredits(price.unit, locale) })}</>}
              </>
            )}
          </p>
        </div>
        {editing && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`${t.assistant.remove} — ${label}`}
            className="grid size-9 shrink-0 place-items-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-fail)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
          >
            <Trash2 aria-hidden className="size-4" />
          </button>
        )}
      </div>

      {editing ? (
        <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className={small} id={field("count")}>
              {t.assistant.countLabel}
            </span>
            <div role="group" aria-labelledby={field("count")} className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onEdit({ count: step.count - 1 })}
                disabled={step.count <= 1}
                aria-label={`${t.assistant.fewer} — ${label}`}
                className={`${chip} grid w-9 place-items-center px-0`}
              >
                <Minus aria-hidden className="size-4" />
              </button>
              <span className="tnum min-w-[2ch] text-center text-sm font-semibold text-[var(--color-fg)]" aria-live="polite">
                {step.count}
              </span>
              <button
                type="button"
                onClick={() => onEdit({ count: step.count + 1 })}
                disabled={step.count >= MAX_COUNT}
                aria-label={`${t.assistant.more} — ${label}`}
                className={`${chip} grid w-9 place-items-center px-0`}
              >
                <Plus aria-hidden className="size-4" />
              </button>
            </div>
          </div>

          {run ? (
            <label className="flex flex-col gap-1">
              <span className={small}>{t.assistant.lengthLabel}</span>
              <select value={step.durationS} onChange={(e) => onEdit({ durationS: Number(e.target.value) })} className={chip}>
                {HOME_LENGTHS.map((l) => (
                  <option key={l.id} value={l.seconds}>
                    {t.home.lengths[l.id]}
                  </option>
                ))}
              </select>
            </label>
          ) : step.kind !== "voice" ? (
            <label className="flex flex-col gap-1">
              <span className={small}>{t.assistant.shapeLabel}</span>
              <select value={step.aspect} onChange={(e) => onEdit({ aspect: e.target.value as PlanStep["aspect"] })} className={chip}>
                {ASPECT_RATIOS.map((a) => (
                  <option key={a} value={a}>
                    {t.assistant.aspects[a]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {step.kind === "clip" && (
            <label className="flex flex-col gap-1">
              <span className={small}>{t.assistant.secondsLabel}</span>
              <select
                value={step.clipSeconds}
                onChange={(e) => onEdit({ clipSeconds: Number(e.target.value) as PlanStep["clipSeconds"] })}
                className={chip}
              >
                {VIDEO_DURATIONS.map((d) => (
                  <option key={d} value={d}>
                    {fmt(t.assistant.seconds, { n: d })}
                  </option>
                ))}
              </select>
            </label>
          )}

          {(run || step.kind === "voice") && (
            <label className="flex flex-col gap-1">
              <span className={small}>{t.assistant.languageLabel}</span>
              <select value={step.language} onChange={(e) => onEdit({ language: e.target.value as PlanStep["language"] })} className={chip}>
                {HOME_LANGUAGES.map((l) => (
                  <option key={l.id} value={l.value} lang={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {run && env.channels.length > 0 && (
            <label className="flex min-w-0 flex-col gap-1">
              <span className={small}>{t.assistant.channelLabel}</span>
              <select value={step.channelSlug ?? ""} onChange={(e) => onEdit({ channelSlug: e.target.value })} className={`${chip} w-full truncate`}>
                {env.channels.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1 min-[420px]:col-span-2">
            <span className={small}>{textLabel}</span>
            <textarea
              value={step.text}
              onChange={(e) => onEdit({ text: e.target.value })}
              rows={run ? 1 : 3}
              maxLength={textMax(step.kind)}
              className="w-full resize-y rounded-[12px] border border-[var(--color-border)] bg-transparent px-3 py-2 text-base leading-snug text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[14px]"
            />
            {run && (
              <span className="text-xs text-[var(--color-muted)]">
                {!step.text.trim() ? t.assistant.topicEmpty : step.count > 1 ? t.assistant.themeMany : null}
                {step.durationS === SHORT_S && <> {t.home.shortNote}</>}
              </span>
            )}
          </label>

          {price?.status === "error" && (
            <button
              type="button"
              onClick={onRequote}
              className="tap-link inline-flex items-center gap-1 justify-self-start text-xs text-[var(--color-primary)] hover:underline"
            >
              <RefreshCw aria-hidden className="size-3.5" />
              {t.assistant.requote}
            </button>
          )}
        </div>
      ) : (
        <p className="truncate text-xs text-[var(--color-muted)]" title={step.text}>
          {step.text || t.assistant.topicEmpty}
        </p>
      )}

      {run && <p className="text-xs text-[var(--color-muted)]">{t.assistant.approvalNote}</p>}

      {started && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="step-status">
          {failed ? (
            <span className="inline-flex items-center gap-1 text-[var(--color-fail)]">
              <AlertTriangle aria-hidden className="size-3.5" />
              {t.assistant.status.failed}
            </span>
          ) : creating ? (
            <span className="inline-flex items-center gap-1 text-[var(--color-muted)]">
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
              {t.assistant.status.creating}
            </span>
          ) : unknown ? (
            <span className="inline-flex items-center gap-1 text-[var(--color-warn)]">
              <AlertTriangle aria-hidden className="size-3.5" />
              {t.assistant.status.unknown}
            </span>
          ) : done === step.count ? (
            <span className="inline-flex items-center gap-1 text-[var(--color-ok)]">
              <Check aria-hidden className="size-3.5" />
              {t.assistant.status.done}
            </span>
          ) : (
            <span className="text-[var(--color-muted)]">{t.assistant.status.pending}</span>
          )}
          <span className="tnum text-[var(--color-muted)]">
            {done}/{step.count}
          </span>
          {done > 0 && resultHref && (
            <Link href={resultHref} className="tap-link inline-flex items-center gap-1 text-[var(--color-primary)] hover:underline">
              {run ? t.assistant.openVideos : t.assistant.openStudio}
              <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          )}
        </div>
      )}
    </li>
  );
}
