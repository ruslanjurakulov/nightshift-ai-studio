"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PriceButton } from "@/components/ui/PriceButton";
import { useI18n } from "@/lib/i18n/context";
import { creditUnit } from "@/lib/credits";
import {
  FILTERS,
  INBOX_LIMITS,
  RETRYABLE,
  cardState,
  cleanReply,
  failureText,
  heldText,
  inboxErrorText,
  isActive,
  matchesFilter,
  newIdempotencyKey,
  type Filter,
  type InboxItem,
} from "@/lib/comment-inbox";

export interface InboxPrice {
  /** "priced" shows the price on the button; "included" is priced at 0; "unpriced" and "failed" switch drafting off. */
  state: "priced" | "included" | "unpriced" | "failed";
  credits: number | null;
}

type Answer = { ok: boolean; status: number; body: Record<string, unknown> };

async function call(url: string, method: string, body?: Record<string, unknown>): Promise<Answer> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body: json };
  } catch {
    return { ok: false, status: 0, body: { error: "network" } };
  }
}

/**
 * The comment inbox (migration 0081): the channel's comments, a drafted reply a
 * person can ask for (one priced press), edit, discard or approve.
 *
 * Every comment, author and reply is audience-controlled text: it is only ever
 * rendered as a text node (React escapes it; nothing here injects markup),
 * with `dir="auto"` and wrapping, never as a link or markup. Nothing here posts
 * anything: "Approve and post" files an approval of the exact text on screen
 * (POST /api/inbox/drafts/<id>/approve) and the worker posts it a moment later.
 * The buttons only reflect what the database allows; it refuses the rest.
 */
export function CommentInbox({
  items,
  channelNames,
  videoTitles,
  price,
  canAct,
}: {
  items: InboxItem[];
  channelNames: Record<string, string>;
  videoTitles: Record<string, string>;
  price: InboxPrice;
  /** May ask for, edit and approve replies (presentation only: the database decides). */
  canAct: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [filter, setFilter] = useState<Filter>("all");
  const active = isActive(items);

  // While the worker is drafting or posting, look again every few seconds.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    }, 5000);
    return () => clearInterval(id);
  }, [active, router]);

  const shown = items.filter((it) => matchesFilter(it, filter));
  const refresh = () => startTransition(() => router.refresh());

  return (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label={t.inbox.filtersLabel} className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className="studio-chip">
            {t.inbox.filters[f]}
          </button>
        ))}
      </div>
      {!canAct && <p className="text-[12px] text-[var(--color-muted)]">{t.inbox.readOnly}</p>}
      {price.state === "unpriced" && <p className="text-[12px] text-[var(--color-warn)]">{t.inbox.unpriced}</p>}
      {price.state === "failed" && <p className="text-[12px] text-[var(--color-warn)]">{t.inbox.readFailed}</p>}
      {shown.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-[var(--color-muted)]">
          {items.length === 0 ? t.inbox.empty : t.inbox.emptyFiltered}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {shown.map((item) => (
            <li key={item.comment.id}>
              <Card
                item={item}
                channelName={channelNames[item.comment.channelId] ?? item.comment.channelId}
                videoTitle={videoTitles[item.comment.videoId] ?? null}
                price={price}
                canAct={canAct}
                refresh={refresh}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Card({
  item,
  channelName,
  videoTitle,
  price,
  canAct,
  refresh,
}: {
  item: InboxItem;
  channelName: string;
  videoTitle: string | null;
  price: InboxPrice;
  canAct: boolean;
  refresh: () => void;
}) {
  const { t, fmt, locale } = useI18n();
  const uid = useId();
  const { comment, draft, intent, post } = item;
  const state = cardState(item);
  const [busy, setBusy] = useState<null | "ask" | "save" | "approve" | "discard" | "dismiss" | "retry">(null);
  const [message, setMessage] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);
  const [text, setText] = useState(draft?.body ?? "");
  const [confirming, setConfirming] = useState(false);
  const key = useRef<string | null>(null);

  // A new draft (or an edit made elsewhere) replaces what the box holds.
  const draftId = draft?.id ?? null;
  const draftBody = draft?.body ?? "";
  useEffect(() => {
    setText(draftBody);
    setConfirming(false);
  }, [draftId, draftBody]);

  const fail = (a: Answer) =>
    setMessage({ tone: "fail", text: a.status === 0 ? t.inbox.errors.network : inboxErrorText(a.body, t.inbox) });

  async function ask() {
    if (busy || price.state === "unpriced" || price.state === "failed") return;
    setBusy("ask");
    setMessage(null);
    // One key per intended press: a dropped connection retried sends the same key.
    key.current ??= newIdempotencyKey();
    const a = await call(`/api/inbox/comments/${comment.id}/draft`, "POST", {
      // "included" (priced at 0, or the operator's own organization) carries no figure: the
      // database holds nothing there, and a price set since then is refused (price_required).
      max_credits: price.state === "priced" ? price.credits : null,
      idempotency_key: key.current,
    });
    setBusy(null);
    if (a.status !== 0) key.current = null;
    if (!a.ok) return fail(a);
    refresh();
  }

  async function save() {
    if (busy || !draft) return;
    setBusy("save");
    setMessage(null);
    const a = await call(`/api/inbox/drafts/${draft.id}`, "PATCH", { body: cleanReply(text) });
    setBusy(null);
    if (!a.ok) return fail(a);
    setMessage({ tone: "ok", text: t.inbox.reply.saved });
    refresh();
  }

  async function approve() {
    if (busy || !draft) return;
    setBusy("approve");
    setMessage(null);
    // The exact text on screen is what is approved.
    const a = await call(`/api/inbox/drafts/${draft.id}/approve`, "POST", { body: cleanReply(text) });
    setBusy(null);
    setConfirming(false);
    if (!a.ok) return fail(a);
    refresh();
  }

  async function discard() {
    if (busy || !draft) return;
    setBusy("discard");
    setMessage(null);
    const a = await call(`/api/inbox/drafts/${draft.id}`, "DELETE");
    setBusy(null);
    if (!a.ok) return fail(a);
    refresh();
  }

  async function dismiss(dismissed: boolean) {
    if (busy) return;
    setBusy("dismiss");
    setMessage(null);
    const a = await call(`/api/inbox/comments/${comment.id}/dismiss`, "POST", { dismissed });
    setBusy(null);
    if (!a.ok) return fail(a);
    refresh();
  }

  async function retry() {
    if (busy || !post) return;
    setBusy("retry");
    setMessage(null);
    const a = await call(`/api/inbox/posts/${post.id}/retry`, "POST");
    setBusy(null);
    if (!a.ok) return fail(a);
    refresh();
  }

  const label = "text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]";
  const stateLabel: Record<typeof state, string> = {
    dismissed: t.inbox.states.dismissed,
    posted: t.inbox.states.posted,
    posting: t.inbox.states.posting,
    post_failed: t.inbox.states.postFailed,
    held: comment.category === null ? t.inbox.categories.unclassified : t.inbox.categories[comment.category],
    writing: t.inbox.states.writing,
    ready: t.inbox.states.ready,
    draft_failed: t.inbox.states.draftFailed,
    open: comment.category ? t.inbox.categories[comment.category] : t.inbox.categories.unclassified,
  };
  const clean = cleanReply(text);
  const canDraft = canAct && (price.state === "priced" || price.state === "included");
  const date = comment.publishedAt ? comment.publishedAt.slice(0, 10) : null;

  return (
    <article
      aria-labelledby={`${uid}-who`}
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`${uid}-who`} dir="auto" className="m-0 text-[13px] font-medium text-[var(--color-fg)] [overflow-wrap:anywhere]">
            {comment.author ?? t.inbox.unknownAuthor}
          </h3>
          <p className="m-0 text-[11px] text-[var(--color-muted)] [overflow-wrap:anywhere]">
            {channelName}
            {videoTitle ? ` · ${fmt(t.inbox.onVideo, { video: videoTitle })}` : ""}
            {date ? " · " : ""}
            {date && <time dateTime={comment.publishedAt ?? undefined}>{date}</time>}
          </p>
        </div>
        <span className={label} data-state={state}>
          {stateLabel[state]}
        </span>
      </header>

      <p dir="auto" className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-fg)] [overflow-wrap:anywhere]">
        {comment.body}
      </p>

      {state === "held" && item.held && <p className="mt-2 text-[12px] text-[var(--color-muted)]">{heldText(item.held, t.inbox)}</p>}

      {state === "writing" && (
        <p role="status" className="mt-3 text-[12px] text-[var(--color-muted)]">
          {t.inbox.draft.writing}
        </p>
      )}

      {state === "draft_failed" && <p className="mt-3 text-[12px] text-[var(--color-muted)]">{t.inbox.draft.failed}</p>}

      {state === "ready" && draft && (
        <div className="mt-3 flex flex-col gap-2">
          <label htmlFor={`${uid}-reply`} className={label}>
            {t.inbox.reply.label}
            {draft.edited ? ` · ${t.inbox.reply.edited}` : ""}
          </label>
          <textarea
            id={`${uid}-reply`}
            dir="auto"
            value={text}
            maxLength={INBOX_LIMITS.replyMax}
            rows={4}
            disabled={!canAct || busy !== null}
            onChange={(e) => {
              setText(e.target.value);
              setConfirming(false);
            }}
            className="studio-field w-full px-3 py-2.5 text-[16px] text-[var(--color-fg)] outline-none sm:text-[13px]"
          />
          <p className="m-0 text-[11px] text-[var(--color-muted)]">{fmt(t.inbox.reply.counter, { n: clean.length, max: INBOX_LIMITS.replyMax })}</p>
          {canAct &&
            (confirming ? (
              <div className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] p-2">
                <p className="m-0 text-[12px] text-[var(--color-fg)]">{fmt(t.inbox.reply.approveNote, { channel: channelName })}</p>
                <p dir="auto" data-testid="exact-text" className="m-0 whitespace-pre-wrap text-[13px] [overflow-wrap:anywhere]">
                  {clean}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={busy !== null || !clean} onClick={() => void approve()} className="btn-sky pill min-h-[40px] px-4 py-2 text-[13px]">
                    {busy === "approve" ? t.inbox.reply.approving : t.inbox.reply.approve}
                  </button>
                  <button type="button" disabled={busy !== null} onClick={() => setConfirming(false)} className="btn-sky ghost pill min-h-[40px] px-4 py-2 text-[13px]">
                    {t.inbox.reply.cancel}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy !== null || !clean} onClick={() => setConfirming(true)} className="btn-sky pill min-h-[40px] px-4 py-2 text-[13px]">
                  {t.inbox.reply.approve}
                </button>
                <button
                  type="button"
                  disabled={busy !== null || !clean || clean === draftBody}
                  onClick={() => void save()}
                  className="btn-sky ghost pill min-h-[40px] px-4 py-2 text-[13px]"
                >
                  {busy === "save" ? t.inbox.reply.saving : t.inbox.reply.save}
                </button>
                <button type="button" disabled={busy !== null} onClick={() => void discard()} className="btn-sky ghost pill min-h-[40px] px-4 py-2 text-[13px]">
                  {t.inbox.reply.discard}
                </button>
              </div>
            ))}
        </div>
      )}

      {(state === "posting" || state === "post_failed" || state === "posted") && intent && (
        <div className="mt-3 flex flex-col gap-1 border-t border-[var(--color-border)] pt-2">
          <span className={label}>{t.inbox.posted.text}</span>
          <p dir="auto" className="m-0 whitespace-pre-wrap text-[13px] [overflow-wrap:anywhere]">
            {intent.body}
          </p>
          {intent.approvedBy && <p className="m-0 text-[11px] text-[var(--color-muted)] [overflow-wrap:anywhere]">{fmt(t.inbox.posted.approvedBy, { who: intent.approvedBy })}</p>}
          <p role="status" className="m-0 text-[12px] text-[var(--color-muted)]">
            {state === "posted" ? t.inbox.posted.done : state === "posting" ? t.inbox.posted.waiting : `${t.inbox.posted.notPosted} ${failureText(post?.errorCode ?? null, t.inbox)}`}
          </p>
        </div>
      )}

      {message && (
        <p role="status" className={`mt-2 text-[12px] ${message.tone === "ok" ? "text-[var(--color-ok)]" : "text-[var(--color-fail)]"}`}>
          {message.text}
        </p>
      )}

      {canAct && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(state === "open" || state === "draft_failed") && canDraft &&
            (price.state === "priced" && price.credits !== null ? (
              <PriceButton
                size="md"
                label={state === "draft_failed" ? t.inbox.draft.askAgain : t.inbox.draft.ask}
                credits={price.credits}
                unit={creditUnit(price.credits, locale, t.shell.creditUnit)}
                locale={locale}
                disabled={busy !== null}
                onClick={() => void ask()}
              />
            ) : (
              <button type="button" disabled={busy !== null} onClick={() => void ask()} className="btn-sky pill min-h-[40px] px-4 py-2 text-[13px]">
                {busy === "ask" ? t.inbox.draft.asking : state === "draft_failed" ? t.inbox.draft.askAgain : t.inbox.draft.askIncluded}
              </button>
            ))}
          {state === "post_failed" && post?.errorCode && (RETRYABLE as readonly string[]).includes(post.errorCode) && (
            <button type="button" disabled={busy !== null} onClick={() => void retry()} className="btn-sky pill min-h-[40px] px-4 py-2 text-[13px]">
              {t.inbox.posted.retry}
            </button>
          )}
          {(state === "open" || state === "held" || state === "draft_failed" || state === "post_failed") && (
            <button type="button" disabled={busy !== null} onClick={() => void dismiss(true)} className="btn-sky ghost pill min-h-[40px] px-4 py-2 text-[13px]">
              {t.inbox.dismiss}
            </button>
          )}
          {state === "dismissed" && (
            <button type="button" disabled={busy !== null} onClick={() => void dismiss(false)} className="btn-sky ghost pill min-h-[40px] px-4 py-2 text-[13px]">
              {t.inbox.restore}
            </button>
          )}
        </div>
      )}
      {(state === "open" || state === "draft_failed") && canDraft && price.state === "priced" && (
        <p className="mt-2 text-[11px] text-[var(--color-muted)]">{t.inbox.draft.note}</p>
      )}
    </article>
  );
}
