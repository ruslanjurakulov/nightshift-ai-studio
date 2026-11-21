"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { runLink, type AiChatSlot, type AiChatSlots, type FitAdvice, type PricedScenario } from "@/lib/ai-chat/logic";

/**
 * Nightshift AI on Studio Create. It talks only to /api/ai-chat (the browser never reaches a vendor). It shows the backend's prices
 * exactly as the server sent them, and its one action is a LINK to the Run now form, prefilled — the person presses that form's own
 * priced button, so every hold, gate and price_changed check is the existing one (CLAUDE.md rule 3).
 */

type ModelRow = { id: "anthropic-claude-sonnet-5-5" | "openai-gpt-6-luna"; state: "available" | "not_on_sale" | "not_configured" };
type Payload = {
  scenarios?: PricedScenario[];
  advice?: Record<string, FitAdvice>;
  pricing?: "ok" | "failed" | "none";
  spendable?: number | "exempt" | "unknown" | null;
  missing?: AiChatSlot[];
  unsupportedPlatform?: boolean;
  factsState?: "data" | "none" | "unknown";
};
type Msg = { key: string; role: "user" | "assistant"; content: string; payload?: Payload | null };
type Quota = { used: number; limit: number; max_input_chars?: number };
type Session = { id: string; model: string; slots: AiChatSlots; step: string; messages: { id: number; role: "user" | "assistant"; content: string; payload: Payload | null }[] };
type Load =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "hidden" }
  | { state: "ready"; models: ModelRow[] | null; defaultModel: string; quota: Quota | null; session: Session | null };
type Problem = { text: string; retry: string | null } | null;

const MODEL_NAMES: Record<string, string> = { "anthropic-claude-sonnet-5-5": "Claude Sonnet 5.5", "openai-gpt-6-luna": "GPT-6 Luna" };

export function AiChatPanel({ channelId, channelSlug }: { channelId: string; channelSlug: string }) {
  const { t, fmt } = useI18n();
  const c = t.aiChat;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [model, setModel] = useState<string>("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [slots, setSlots] = useState<AiChatSlots>({});
  const [messages, setMessages] = useState<Msg[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [capped, setCapped] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const maxChars = quota?.max_input_chars ?? 2000;

  const read = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      const res = await fetch(`/api/ai-chat?channel=${encodeURIComponent(channelId)}`, { cache: "no-store" });
      if (res.status === 404) return setLoad({ state: "hidden" });
      if (!res.ok) return setLoad({ state: "failed" });
      const d = (await res.json()) as Extract<Load, { state: "ready" }>;
      setLoad({ ...d, state: "ready" });
      setQuota(d.quota);
      setCapped(!!d.quota && d.quota.used >= d.quota.limit);
      const firstReady = d.models?.find((m) => m.state === "available")?.id;
      if (d.session) {
        setSessionId(d.session.id);
        setModel(d.session.model);
        setSlots(d.session.slots ?? {});
        setMessages(d.session.messages.map((m) => ({ key: `m${m.id}`, role: m.role, content: m.content, payload: m.payload })));
      } else {
        const def = d.models?.find((m) => m.id === d.defaultModel && m.state === "available")?.id;
        setModel(def ?? firstReady ?? "");
      }
    } catch {
      setLoad({ state: "failed" });
    }
  }, [channelId]);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  const modelName = MODEL_NAMES[model] ?? model;

  const explain = (status: number, d: Record<string, unknown>): string => {
    const e = typeof d.error === "string" ? d.error : "";
    if (status === 401) return c.errors.session_ended;
    if (e === "chat_daily_cap") {
      return typeof d.used === "number" && typeof d.limit === "number"
        ? fmt(c.errors.chat_daily_cap, { used: d.used, limit: d.limit })
        : c.errors.chat_daily_cap_plain;
    }
    if (e === "message_too_long") return fmt(c.errors.message_too_long, { max: maxChars });
    if (e === "model_failed" && typeof d.reason === "string" && d.reason in c.errors.reasons) {
      return fmt(c.errors.reasons[d.reason as keyof typeof c.errors.reasons], { model: modelName });
    }
    if (e === "model_unavailable") return fmt(c.errors.model_unavailable, { model: modelName });
    if (e === "model_answer_invalid") return fmt(c.errors.model_answer_invalid, { model: modelName });
    if (e === "not_enabled") return c.errors.not_enabled;
    if (e === "adult_only_service") return c.errors.adult_only_service;
    return c.errors.unavailable;
  };

  const startSession = async (): Promise<string | null> => {
    const res = await fetch("/api/ai-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start", channel: channelId, model }),
    });
    const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      setProblem({ text: explain(res.status, d), retry: null });
      return null;
    }
    const s = d.session as { id: string };
    setSessionId(s.id);
    return s.id;
  };

  const send = async (raw: string) => {
    const words = raw.trim();
    if (!words || busy || capped || !model) return;
    setBusy(true);
    setProblem(null);
    try {
      const sid = sessionId ?? (await startSession());
      if (!sid) return;
      setMessages((m) => [...m, { key: `u${Date.now()}`, role: "user", content: words }]);
      setText("");
      const res = await fetch("/api/ai-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "turn", session: sid, text: words }),
      });
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (d.quota && typeof d.quota === "object") setQuota((q) => ({ ...(q ?? {}), ...(d.quota as Quota) }));
      if (!res.ok) {
        if (d.error === "chat_daily_cap") setCapped(true);
        // A refused or failed turn keeps the person's words: they can send them again as they are.
        setProblem({ text: explain(res.status, d), retry: d.error === "chat_daily_cap" || d.error === "message_too_long" ? null : words });
        if (d.error === "chat_daily_cap" || d.error === "message_too_long" || d.error === "model_unavailable") setText(words);
        return;
      }
      setSlots((d.slots as AiChatSlots) ?? {});
      setMessages((m) => [
        ...m,
        {
          key: `a${Date.now()}`,
          role: "assistant",
          content: String(d.reply ?? ""),
          payload: {
            scenarios: d.scenarios as PricedScenario[],
            advice: d.advice as Record<string, FitAdvice>,
            pricing: d.pricing as Payload["pricing"],
            spendable: d.spendable as Payload["spendable"],
            missing: d.missing as AiChatSlot[],
            unsupportedPlatform: d.unsupportedPlatform === true,
            factsState: d.factsState as Payload["factsState"],
          },
        },
      ]);
    } catch {
      setProblem({ text: c.errors.unavailable, retry: words });
    } finally {
      setBusy(false);
    }
  };

  const newChat = () => {
    setSessionId(null);
    setMessages([]);
    setSlots({});
    setProblem(null);
  };

  if (load.state === "hidden") return null;

  const lengthLabel = (s: number) => (s >= 60 ? fmt(c.minutes, { n: Math.round((s / 60) * 10) / 10 }) : fmt(c.seconds, { n: s }));

  return (
    <section className="studio-surface flex flex-col gap-3 p-4" aria-labelledby="ai-chat-title">
      <header className="flex flex-col gap-1">
        <h2 id="ai-chat-title" className="text-sm font-semibold text-[var(--color-fg)]">{c.title}</h2>
        <p className="text-xs text-[var(--color-muted)]">{c.subtitle}</p>
      </header>

      {load.state === "loading" && <p className="text-xs text-[var(--color-muted)]" role="status">{c.loading}</p>}
      {load.state === "failed" && (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <p className="text-sm">{c.errors.unavailable}</p>
          <button type="button" className="btn-quiet text-sm" onClick={() => void read()}>{c.retry}</button>
        </div>
      )}

      {load.state === "ready" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="studio-label" htmlFor="ai-chat-model">{c.model}</label>
            {load.models ? (
              <select
                id="ai-chat-model"
                className="studio-field min-h-11 px-2 text-sm"
                value={model}
                disabled={busy}
                onChange={(e) => {
                  setModel(e.target.value);
                  newChat();
                }}
              >
                {load.models.map((m) => (
                  <option key={m.id} value={m.id} disabled={m.state !== "available"}>
                    {MODEL_NAMES[m.id]} — {c.modelStates[m.state]}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-xs text-[var(--color-muted)]">{c.modelsUnknown}</span>
            )}
            <span className="text-xs text-[var(--color-muted)]">{c.geminiLocked}</span>
            {messages.length > 0 && (
              <button type="button" className="btn-quiet text-sm" onClick={newChat} disabled={busy}>{c.newChat}</button>
            )}
          </div>
          {messages.length > 0 && <p className="text-xs text-[var(--color-muted)]">{c.modelSwitchNote}</p>}
          {load.models && !load.models.some((m) => m.state === "available") && (
            <p className="text-sm" role="status">{c.noModel}</p>
          )}

          <SlotChips slots={slots} lengthLabel={lengthLabel} />

          <ol ref={listRef} className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto" aria-live="polite">
            {messages.length === 0 && <li className="text-xs text-[var(--color-muted)]">{c.empty}</li>}
            {messages.map((m) => (
              <li key={m.key} className={m.role === "user" ? "self-end max-w-[85%]" : "max-w-full"}>
                <p className="text-xs text-[var(--color-muted)]">{m.role === "user" ? c.you : c.ai}</p>
                <p className="studio-field whitespace-pre-wrap break-words p-3 text-sm">{m.content}</p>
                {m.role === "assistant" && m.payload && (
                  <AssistantExtras payload={m.payload} slots={slots} channelSlug={channelSlug} lengthLabel={lengthLabel} />
                )}
              </li>
            ))}
            {busy && <li className="text-xs text-[var(--color-muted)]" role="status">{c.sending}</li>}
          </ol>

          {problem && (
            <div className="flex flex-wrap items-center gap-2" role="alert">
              <p className="text-sm">{problem.text}</p>
              {problem.retry && (
                <button type="button" className="btn-quiet text-sm" onClick={() => void send(problem.retry!)} disabled={busy}>{c.retry}</button>
              )}
            </div>
          )}

          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <label className="sr-only" htmlFor="ai-chat-input">{c.placeholder}</label>
            <textarea
              id="ai-chat-input"
              className="studio-field min-h-[5.5rem] w-full p-3 text-base"
              value={text}
              maxLength={maxChars}
              placeholder={c.placeholder}
              disabled={busy || capped || !model}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(text);
                }
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" className="btn-primary text-sm disabled:opacity-40" disabled={busy || capped || !model || !text.trim()}>
                {busy ? c.sending : c.send}
              </button>
              <span className="text-xs text-[var(--color-muted)]">{fmt(c.chars, { n: text.length, max: maxChars })}</span>
              {quota && <span className="text-xs text-[var(--color-muted)]">{fmt(c.quota, { used: quota.used, limit: quota.limit })}</span>}
            </div>
          </form>
        </>
      )}
    </section>
  );
}

function SlotChips({ slots, lengthLabel }: { slots: AiChatSlots; lengthLabel: (s: number) => string }) {
  const { t } = useI18n();
  const c = t.aiChat;
  const shown: [string, string][] = [];
  if (slots.length_s) shown.push([c.slots.length_s, lengthLabel(slots.length_s)]);
  if (slots.style) shown.push([c.slots.style, slots.style]);
  if (slots.platform) shown.push([c.slots.platform, "YouTube"]);
  if (slots.language) shown.push([c.slots.language, slots.language]);
  if (slots.audience) shown.push([c.slots.audience, slots.audience]);
  if (!shown.length) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {shown.map(([k, v]) => (
        <li key={k} className="studio-chip text-xs"><span className="text-[var(--color-muted)]">{k}:</span> {v}</li>
      ))}
    </ul>
  );
}

function AssistantExtras({
  payload,
  slots,
  channelSlug,
  lengthLabel,
}: {
  payload: Payload;
  slots: AiChatSlots;
  channelSlug: string;
  lengthLabel: (s: number) => string;
}) {
  const { t, fmt } = useI18n();
  const c = t.aiChat;
  const missing = payload.missing ?? [];
  return (
    <div className="mt-2 flex flex-col gap-2">
      {payload.unsupportedPlatform && <p className="text-xs">{c.unsupportedPlatform}</p>}
      {missing.length > 0 && !payload.scenarios?.length && (
        <p className="text-xs text-[var(--color-muted)]">{fmt(c.stillNeeded, { list: missing.map((m) => c.slots[m]).join(", ") })}</p>
      )}
      {payload.factsState === "none" && !!payload.scenarios?.length && <p className="text-xs text-[var(--color-muted)]">{c.factsNone}</p>}
      {payload.factsState === "unknown" && !!payload.scenarios?.length && <p className="text-xs text-[var(--color-muted)]">{c.factsUnknown}</p>}
      {payload.spendable === "unknown" && !!payload.scenarios?.length && <p className="text-xs">{c.balanceUnknown}</p>}
      {(payload.scenarios ?? []).map((s, i) => {
        const advice = payload.advice?.[String(s.length_s)];
        const have = typeof payload.spendable === "number" ? payload.spendable : null;
        return (
          <article key={i} className="studio-field flex flex-col gap-2 p-3">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">{s.title}</h3>
            <p className="text-sm">{s.hook}</p>
            <div>
              <p className="studio-label">{c.beats}</p>
              <ol className="ml-4 list-decimal text-sm">
                {s.beats.map((b, j) => <li key={j}>{b}</li>)}
              </ol>
            </div>
            <ul className="flex flex-wrap gap-2 text-xs">
              <li className="studio-chip">{lengthLabel(s.length_s)}</li>
              {s.style && <li className="studio-chip">{s.style}</li>}
            </ul>
            <p className="text-sm font-semibold">
              {s.price.state === "priced" && fmt(c.price, { n: s.price.credits })}
              {s.price.state === "exempt" && c.priceExempt}
              {s.price.state === "unpriced" && c.priceUnpriced}
              {s.price.state === "failed" && c.priceFailed}
            </p>
            {s.price.state === "priced" && !s.price.fits && have !== null && (
              <div className="flex flex-col gap-2" role="note">
                <p className="text-sm">{fmt(c.insufficient, { len: lengthLabel(s.length_s), need: s.price.credits, have })}</p>
                {advice?.state === "shorter" ? (
                  <>
                    <p className="text-sm">{fmt(c.shorterFits, { len: lengthLabel(advice.length_s), credits: advice.credits })}</p>
                    <Link className="btn-quiet inline-flex min-h-11 items-center px-4 text-sm" href={runLink(channelSlug, { ...s, length_s: advice.length_s }, slots.language)}>
                      {fmt(c.useShorter, { len: lengthLabel(advice.length_s) })}
                    </Link>
                  </>
                ) : (
                  <p className="text-sm">{c.noneFits}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Link className="btn-quiet inline-flex min-h-11 items-center px-4 text-sm" href={`/${encodeURIComponent(channelSlug)}/credits#plans`}>{c.upgrade}</Link>
                  <Link className="btn-quiet inline-flex min-h-11 items-center px-4 text-sm" href={`/${encodeURIComponent(channelSlug)}/credits#topups`}>{c.topUp}</Link>
                </div>
              </div>
            )}
            {(s.price.state !== "priced" || s.price.fits || have === null) && (
              <div className="flex flex-col gap-1">
                <Link className="btn-primary inline-flex min-h-11 items-center justify-center px-4 text-sm" href={runLink(channelSlug, s, slots.language)}>
                  {c.use}
                </Link>
                <p className="text-xs text-[var(--color-muted)]">{c.useHint}</p>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
