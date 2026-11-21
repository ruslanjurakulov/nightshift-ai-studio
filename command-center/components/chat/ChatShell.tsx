"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, Copy, RefreshCw, SquarePen, ThumbsDown, ThumbsUp } from "lucide-react";
import { Wordmark } from "@/components/site/Wordmark";
import "./chat-shell.css";

/**
 * The shared Nightshift AI chat shell: the owner's console (/owner/ai) now, the customer's Nightshift AI next. It draws; it does
 * not fetch. The caller owns the route, the meter and the failures, and hands the shell the turns, whether an answer is on its
 * way, and a notice (an error with its remedy) to show under the thread. That keeps the paid call and its refusals in one place
 * per product while the two chats look and behave the same.
 *
 * Nothing is shown that does not work: no attach "+", no microphone. The history panel (ChatHistory.tsx) wraps the shell and hands
 * it the header's menu button as `lead`; without a history the header has none.
 * Thumbs up/down are kept in this tab only: nothing is stored server-side yet, and nothing here claims otherwise.
 */

export interface ChatLabels {
  title: string;
  newChat: string;
  /** Already filled in by the caller ("Salom, Aziz", or a plain hello when there is no name). */
  greeting: string;
  label: string;
  placeholder: string;
  send: string;
  sending: string;
  you: string;
  ai: string;
  copy: string;
  copied: string;
  copyFailed: string;
  regenerate: string;
  good: string;
  bad: string;
  keys: string;
  /** "{n} / {max}" */
  counter: string;
  disclaimer: string;
}

export interface ChatTurn {
  /** Stable per answer: a regenerated answer gets a new id, so its thumbs start clear. */
  id: number;
  q: string;
  a: string;
  /** Under the answer: a draft, an as-of line, a warning. The caller's own content. */
  extra?: ReactNode;
}

type Vote = "up" | "down";

/** Enter sends; Shift+Enter is a new line; a key that ends an IME composition (Uzbek/Russian layouts on some phones) never sends. */
export function sendsOnKey(e: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing;
}

const fillCounter = (s: string, n: number, max: number) => s.replace("{n}", String(n)).replace("{max}", String(max));
/** The box grows with the question up to about eight lines, then scrolls inside itself. */
const BOX_MAX_PX = 200;
// The server render has no layout to measure; the browser measures before paint so the box never flashes at the wrong height.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function IconButton({ label, onClick, pressed, disabled, children }: { label: string; onClick: () => void; pressed?: boolean; disabled?: boolean; children: ReactNode }) {
  // The name is the tooltip's own text (WCAG 2.5.3: what is seen is what a voice user says); the tip shows on hover AND on
  // keyboard focus, so it is never a mouse-only message.
  return (
    <button type="button" className="chat-act" aria-label={label} data-tip={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function ChatShell({
  labels: l,
  turns,
  pending,
  pendingQuestion,
  notice,
  maxLength,
  counterFrom,
  inputId,
  onSend,
  onRegenerate,
  onNewChat,
  lead,
}: {
  labels: ChatLabels;
  turns: ChatTurn[];
  /** An answer is on its way: the thinking dots, the aurora, the send button off. */
  pending: boolean;
  /** The question in flight or the one that failed, drawn as the user's bubble under the thread (null: none, or a regenerate). */
  pendingQuestion: string | null;
  notice?: ReactNode;
  maxLength: number;
  counterFrom: number;
  inputId: string;
  /** Resolves true when the question was answered: only then is the box emptied, so a failed send keeps what was typed. */
  onSend: (text: string) => Promise<boolean>;
  /** Asks the last question again through the same route (and meter) as a send. */
  onRegenerate: () => void;
  onNewChat: () => void;
  /** Drawn before the title: the history drawer's menu button on a phone. */
  lead?: ReactNode;
}) {
  const [question, setQuestion] = useState("");
  const [votes, setVotes] = useState<Record<number, Vote>>({});
  const [copied, setCopied] = useState<number | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (copied === null) return;
    const id = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  useIsoLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, BOX_MAX_PX)}px`;
  }, [question]);

  // The newest exchange (or the thinking dots, or the notice) is brought into view: with a floating composer the answer would
  // otherwise land below the fold.
  const hasNotice = Boolean(notice);
  useEffect(() => {
    if (turns.length === 0 && !pending && !hasNotice) return;
    tail.current?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [turns.length, pending, hasNotice]);

  async function submit() {
    if (pending || question.trim() === "") return;
    const ok = await onSend(question);
    if (ok) setQuestion("");
    box.current?.focus();
  }

  async function copy(id: number, text: string) {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch {
      setCopyFailed(true);
    }
  }

  // Pressing the same thumb again takes the vote back.
  const vote = (id: number, v: Vote) =>
    setVotes((prev) => {
      const next = { ...prev };
      if (next[id] === v) delete next[id];
      else next[id] = v;
      return next;
    });

  const empty = turns.length === 0 && !pending && !pendingQuestion && !notice;
  const canSend = !pending && question.trim() !== "";
  const near = question.length >= counterFrom;
  const lastId = turns.length > 0 ? turns[turns.length - 1].id : null;

  return (
    <div className="chat-shell" data-state={pending ? "thinking" : "idle"}>
      {/* The glow is two fixed layers that only cross-fade and drift (opacity and transform): the compositor does it, no repaint. */}
      <div className="chat-glow" aria-hidden>
        <span className="chat-glow-idle" />
        <span className="chat-glow-think" />
      </div>

      <header className="chat-head">
        {lead}
        <h1 className="chat-title">{l.title}</h1>
        <IconButton label={l.newChat} onClick={onNewChat} disabled={pending || empty}>
          <SquarePen aria-hidden size={18} />
        </IconButton>
      </header>

      <section className="chat-thread" aria-label={l.ai}>
        <div role="log" aria-live="polite" className="chat-log">
          {empty ? (
            <div className="chat-empty">
              <Wordmark mark className="chat-empty-mark" />
              <p className="chat-greeting">{l.greeting}</p>
            </div>
          ) : (
            turns.map((t) => (
              <article key={t.id} className="chat-turn">
                <div className="chat-msg chat-msg-you">
                  <p className="sr-only">{l.you}</p>
                  <p className="chat-bubble-you">{t.q}</p>
                </div>
                <div className="chat-msg chat-msg-ai">
                  <Wordmark mark className="chat-avatar" />
                  <div className="chat-ai-body">
                    <p className="sr-only">{l.ai}</p>
                    <p className="chat-answer">{t.a}</p>
                    {t.extra}
                    <div className="chat-acts">
                      <IconButton label={copied === t.id ? l.copied : l.copy} onClick={() => copy(t.id, t.a)}>
                        {copied === t.id ? <Check aria-hidden size={16} /> : <Copy aria-hidden size={16} />}
                      </IconButton>
                      {/* Only the last answer: asking an earlier question again would answer it out of its place. */}
                      {t.id === lastId && (
                        <IconButton label={l.regenerate} onClick={onRegenerate} disabled={pending}>
                          <RefreshCw aria-hidden size={16} />
                        </IconButton>
                      )}
                      <IconButton label={l.good} pressed={votes[t.id] === "up"} onClick={() => vote(t.id, "up")}>
                        <ThumbsUp aria-hidden size={16} />
                      </IconButton>
                      <IconButton label={l.bad} pressed={votes[t.id] === "down"} onClick={() => vote(t.id, "down")}>
                        <ThumbsDown aria-hidden size={16} />
                      </IconButton>
                    </div>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>

        {/* Outside the log: the question in flight and the thinking dots are not answers, and a busy live region would hold the
            status back anyway. */}
        {(pendingQuestion || pending) && (
          <div className="chat-turn" data-pending={pending || undefined}>
            {pendingQuestion && (
              <div className="chat-msg chat-msg-you">
                <p className="sr-only">{l.you}</p>
                <p className="chat-bubble-you">{pendingQuestion}</p>
              </div>
            )}
            {pending && (
              <div className="chat-msg chat-msg-ai">
                <Wordmark mark className="chat-avatar" />
                <div className="chat-typing" aria-hidden>
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
          </div>
        )}
        <p className="sr-only" role="status">
          {pending ? l.sending : ""}
        </p>
        {copyFailed && (
          <p className="chat-note" role="status">
            {l.copyFailed}
          </p>
        )}
        {notice}
        <div ref={tail} aria-hidden />
      </section>

      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {l.label}
        </label>
        <div className="chat-pill">
          <textarea
            id={inputId}
            ref={box}
            className="chat-input"
            rows={1}
            maxLength={maxLength}
            value={question}
            placeholder={l.placeholder}
            aria-describedby={`${inputId}-keys ${inputId}-count`}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (sendsOnKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <span id={`${inputId}-count`} className="chat-counter" data-full={question.length >= maxLength || undefined}>
            {near ? fillCounter(l.counter, question.length, maxLength) : ""}
          </span>
          <button type="submit" className="chat-send" aria-label={pending ? l.sending : l.send} disabled={!canSend}>
            <ArrowUp aria-hidden size={18} strokeWidth={2.5} />
          </button>
        </div>
        <p className="chat-disclaimer">
          {l.disclaimer}{" "}
          <span id={`${inputId}-keys`} className="chat-keys">
            {l.keys}
          </span>
        </p>
      </form>
    </div>
  );
}
