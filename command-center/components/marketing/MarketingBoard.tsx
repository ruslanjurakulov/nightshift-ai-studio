"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { ownerTime, relativeTime } from "@/lib/format";
import { postOperator } from "@/lib/operator-post";
import { REASON_MAX, REASON_MIN, charCount } from "@/lib/owner-rpc";
import {
  LANGS,
  LABELS,
  TEXT_MAX,
  buildPreview,
  lastSettled,
  sortPosts,
  type MarketingPost,
  type MarketingSettings,
  type PostStatus,
  type Texts,
} from "@/lib/marketing-posts";
import { marketingFailureText, refusalMeansStale, sendNote } from "@/lib/marketing-text";
import { useConfirm, type ConfirmOptions } from "@/components/feedback/ConfirmDialog";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { StateBlock } from "@/components/states/StateBlock";
import { TelegramPreview } from "@/components/marketing/TelegramPreview";

const ENDPOINT = "/api/marketing";
const TONE: Record<PostStatus, LampTone> = {
  draft: "info",
  approved: "warn",
  sending: "run",
  sent: "ok",
  failed: "fail",
  dead: "fail",
  rejected: "idle",
  expired: "idle",
};

type Confirm = (opts: ConfirmOptions) => Promise<boolean>;

/**
 * The owner's approval page for the brand channel's posts (NIGHTSHIFT_MARKETING_POSTS on; migration 0108).
 *
 * What it does and does not do:
 *  - It shows each post as the channel will show it, edits the three texts, approves, rejects, and stops or re-arms the
 *    poster. Every one of those goes through /api/marketing -> owner_marketing_* as the signed-in user.
 *  - Approving sends the hash of the post THIS page showed. If the post changed since, the database refuses
 *    (`content_changed`) and the page reloads: the owner can only approve what they saw.
 *  - Approving is only the owner's yes. The worker posts later, and only while the poster is on. There is no "send now" and no
 *    "test post" here (a test would be a public post); a post nobody can confirm reads "check the channel, do not resend".
 *  - Everything public or irreversible (approve, reject, stop, switch on) goes through the confirm sheet; the two that make
 *    something public ask for a word typed back.
 *  - An unknown stays unknown: no count of posts or week is ever drawn as 0 when the database did not say.
 */
export function MarketingBoard({
  settings,
  posts,
  truncated,
  channel,
  origin,
  nowMs,
}: {
  settings: MarketingSettings;
  posts: MarketingPost[];
  truncated: boolean;
  /** The channel handle from the server's own settings, or null when it is not known (never guessed). */
  channel: string | null;
  origin: string | null;
  nowMs: number;
}) {
  const { t, locale } = useI18n();
  const m = t.marketing;
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [pending, start] = useTransition();
  const refresh = () => start(() => router.refresh());
  const sorted = sortPosts(posts);
  const last = lastSettled(posts);
  const when = (iso: string | null) => ownerTime(iso, locale, nowMs);

  return (
    <div className="flex flex-col gap-4" aria-busy={pending}>
      {dialog}
      <PosterPanel settings={settings} channel={channel} confirm={confirm} refresh={refresh} />

      <section className="panel flex flex-col gap-2 p-4 sm:p-5" aria-labelledby="mk-last-title">
        <h2 id="mk-last-title" className="t-section">
          {m.lastSend.title}
        </h2>
        {last === null ? (
          <p className="text-sm text-[var(--color-muted)]">{m.lastSend.none}</p>
        ) : (
          <LastSend post={last} settings={settings} when={when} />
        )}
      </section>

      {pending && (
        <p role="status" className="text-xs text-[var(--color-muted)]">
          {m.refreshing}
        </p>
      )}

      {sorted.length === 0 ? (
        <StateBlock tone="idle" title={m.empty.title}>
          {m.empty.body}
        </StateBlock>
      ) : (
        <ul className="flex flex-col gap-4" aria-label={m.title}>
          {sorted.map((p) => (
            <li key={p.id}>
              <PostCard post={p} settings={settings} channel={channel} origin={origin} nowMs={nowMs} confirm={confirm} refresh={refresh} />
            </li>
          ))}
        </ul>
      )}
      {truncated && <p className="text-xs text-[var(--color-muted)]">{fmt(m.truncated, { n: posts.length })}</p>}
    </div>
  );
}

function LastSend({ post, settings, when }: { post: MarketingPost; settings: MarketingSettings; when: (iso: string | null) => string }) {
  const { t } = useI18n();
  const m = t.marketing;
  const at = when(post.sentAt ?? post.updatedAt);
  const headline = post.status === "sent" ? m.lastSend.sent : post.status === "failed" ? m.lastSend.failed : m.lastSend.dead;
  const note = sendNote(t, post, { sent: at, next: null }, settings.enabled, "");
  return (
    <div className="flex flex-col gap-1.5">
      <StatusLamp tone={TONE[post.status]} label={`${m.status[post.status]} · ${fmt(headline, { when: at })}`} />
      <p className="break-words text-xs text-[var(--color-muted)]">{fmt(m.lastSend.source, { source: post.sourceRef })}</p>
      {note?.lines.map((l) => (
        <p key={l} className={`break-words text-sm ${note.tone === "fail" ? "text-[var(--color-fail)]" : "text-[var(--color-fg)]"}`}>
          {l}
        </p>
      ))}
    </div>
  );
}

// ─── The poster: the database kill switch ──────────────────────────────────────────────────────────

function PosterPanel({
  settings,
  channel,
  confirm,
  refresh,
}: {
  settings: MarketingSettings;
  channel: string | null;
  confirm: Confirm;
  refresh: () => void;
}) {
  const { t } = useI18n();
  const m = t.marketing;
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const busy = useRef(false);
  const unknown = m.err.figureUnknown;
  const max = settings.maxPer7d === null ? unknown : String(settings.maxPer7d);
  const week =
    settings.used7d === null
      ? fmt(m.poster.thisWeekUsedUnknown, { max })
      : settings.maxPer7d === null
        ? fmt(m.poster.thisWeekMaxUnknown, { used: settings.used7d })
        : fmt(m.poster.thisWeek, { used: settings.used7d, max });

  async function stop() {
    if (busy.current) return;
    busy.current = true;
    setMsg(null);
    const ok = await confirm({
      title: m.poster.stopTitle,
      message: m.poster.stopBody,
      confirmLabel: m.poster.stopConfirm,
      tone: "danger",
      details: [{ label: m.poster.channel, value: channel ?? m.poster.channelUnknown }],
      successMessage: m.poster.stopDone,
      run: async () => {
        const out = await postOperator(ENDPOINT, { action: "kill", kill: true });
        return out.ok ? true : marketingFailureText(t, out, true);
      },
    });
    busy.current = false;
    refresh();
    if (ok) setMsg({ ok: true, text: m.poster.stopDone });
  }

  async function startPoster() {
    if (busy.current) return;
    const why = reason.trim();
    if (charCount(why) < REASON_MIN) {
      setMsg({ ok: false, text: m.poster.reasonShort });
      return;
    }
    busy.current = true;
    setMsg(null);
    const ok = await confirm({
      title: m.poster.startTitle,
      message: m.poster.startBody,
      confirmLabel: m.poster.startConfirm,
      tone: "danger",
      typeToConfirm: m.poster.startWord,
      details: [
        { label: m.poster.channel, value: channel ?? m.poster.channelUnknown },
        { label: m.poster.dReason, value: why, multiline: true },
      ],
      successMessage: m.poster.startDone,
      run: async () => {
        const out = await postOperator(ENDPOINT, { action: "kill", kill: false, reason: why });
        return out.ok ? true : marketingFailureText(t, out, true);
      },
    });
    busy.current = false;
    refresh();
    if (ok) {
      setReason("");
      setMsg({ ok: true, text: m.poster.startDone });
    }
  }

  return (
    <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-labelledby="mk-poster-title">
      <h2 id="mk-poster-title" className="t-section">
        {m.poster.title}
      </h2>
      <StatusLamp tone={settings.enabled ? "ok" : "idle"} label={settings.enabled ? m.poster.on : m.poster.off} />
      <dl className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2">
          <dt className="text-[var(--color-muted)]">{m.poster.channel}</dt>
          <dd className="min-w-0 break-words text-right font-semibold text-[var(--color-fg)]">{channel ?? m.poster.channelUnknown}</dd>
        </div>
        <div className="tnum px-3 py-2 font-semibold text-[var(--color-fg)]">{week}</div>
        <div className="tnum px-3 py-2 text-[var(--color-fg)]">
          {settings.approvedWaiting === null ? m.poster.waitingUnknown : fmt(m.poster.waiting, { n: settings.approvedWaiting })}
        </div>
      </dl>
      <p className="text-xs leading-relaxed text-[var(--color-muted)]">
        {settings.enabled ? fmt(m.poster.onNote, { max }) : m.poster.offNote}
      </p>
      <p className="text-xs leading-relaxed text-[var(--color-muted)]">{m.poster.serverNote}</p>

      {settings.enabled ? (
        <button type="button" onClick={() => void stop()} aria-label={m.poster.stopAria} className="btn-danger min-h-11 self-start px-4 text-sm">
          {m.poster.stop}
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            {m.poster.reasonLabel}
            <textarea
              rows={2}
              maxLength={REASON_MAX}
              value={reason}
              placeholder={m.poster.reasonPh}
              onChange={(e) => setReason(e.target.value)}
              className="ns-field min-w-0"
            />
            <span className="flex justify-between gap-3">
              <span>{m.poster.reasonHint}</span>
              <span className="tnum">{fmt(m.poster.reasonCount, { n: charCount(reason.trim()) })}</span>
            </span>
          </label>
          <button
            type="button"
            onClick={() => void startPoster()}
            aria-label={m.poster.startAria}
            disabled={charCount(reason.trim()) < REASON_MIN}
            className="btn-quiet min-h-11 self-start px-4 text-sm disabled:opacity-55"
          >
            {m.poster.start}
          </button>
        </div>
      )}
      <p className="min-h-4 text-xs" style={{ color: msg?.ok ? "var(--color-ok)" : "var(--color-fail)" }} aria-live="polite">
        {msg?.text}
      </p>
    </section>
  );
}

// ─── One post ──────────────────────────────────────────────────────────────────────────────────────

type Mode = "view" | "edit" | "reject";

function PostCard({
  post,
  settings,
  channel,
  origin,
  nowMs,
  confirm,
  refresh,
}: {
  post: MarketingPost;
  settings: MarketingSettings;
  channel: string | null;
  origin: string | null;
  nowMs: number;
  confirm: Confirm;
  refresh: () => void;
}) {
  const { t, locale } = useI18n();
  const m = t.marketing;
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<Texts>(post.texts);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const busy = useRef(false);
  const stale = useRef(false);
  const when = (iso: string | null) => ownerTime(iso, locale, nowMs);
  const open = post.status === "draft" || post.status === "approved";
  const note = sendNote(
    t,
    post,
    { sent: when(post.sentAt), next: post.nextAttemptAt ? when(post.nextAttemptAt) : null },
    settings.enabled,
    when(post.expiresAt),
  );

  /** Runs a call inside the confirm sheet; remembers a refusal that means the page is out of date. */
  const call = (body: Record<string, unknown>, onOk?: (data: Record<string, unknown>) => void) => async (): Promise<true | string> => {
    stale.current = false;
    const out = await postOperator(ENDPOINT, body);
    if (out.ok) {
      onOk?.(out.data as Record<string, unknown>);
      return true;
    }
    stale.current = refusalMeansStale(out.data?.error);
    return marketingFailureText(t, out, true);
  };

  async function approve() {
    if (busy.current) return;
    busy.current = true;
    setMsg(null);
    const pv = buildPreview(post.texts, post.link, origin, Boolean(post.mediaPath));
    const ok = await confirm({
      title: channel ? fmt(m.approve.title, { channel }) : m.approve.titleUnknown,
      message: m.approve.body,
      confirmLabel: m.approve.confirm,
      tone: "danger",
      typeToConfirm: m.approve.word,
      details: [
        { label: m.approve.dPublic, value: m.approve.dPublicValue },
        { label: m.approve.dChannel, value: channel ?? m.poster.channelUnknown },
        { label: m.approve.dKind, value: m.kind[post.kind] },
        ...LANGS.map((lang) => ({ label: fmt(m.approve.dLang, { lang: LABELS[lang] }), value: post.texts[lang], multiline: true })),
        ...(post.link ? [{ label: m.approve.dLink, value: pv.linkUrl ?? post.link }] : []),
        { label: m.approve.dCount, value: fmt(pv.linkUncounted ? m.preview.totalAtLeast : m.preview.total, { n: pv.total, limit: pv.limit }) },
      ],
      successMessage: m.approve.done,
      // The hash of the post THIS page showed: if the post is different now, the database refuses (content_changed).
      run: call({ action: "approve", id: post.id, contentHash: post.contentHash }),
    });
    busy.current = false;
    if (ok || stale.current) refresh();
    if (ok) setMsg({ ok: true, text: m.approve.done });
  }

  async function save() {
    if (busy.current) return;
    const trimmed: Texts = { uz: draft.uz.trim(), ru: draft.ru.trim(), en: draft.en.trim() };
    busy.current = true;
    setMsg(null);
    const send = call({ action: "edit", id: post.id, texts: trimmed }, (data) => {
      setMsg({ ok: true, text: data.unchanged === true ? m.edit.unchanged : m.edit.saved });
    });
    let ok: boolean;
    if (post.status === "approved") {
      // Saving voids the approval: say so before it happens.
      ok = await confirm({
        title: m.edit.confirmTitle,
        message: m.edit.confirmBody,
        confirmLabel: m.edit.confirmButton,
        tone: "primary",
        successMessage: m.edit.saved,
        run: send,
      });
    } else {
      const r = await send();
      ok = r === true;
      if (r !== true) setMsg({ ok: false, text: r });
    }
    busy.current = false;
    if (ok || stale.current) {
      setMode("view");
      refresh();
    }
  }

  async function reject() {
    if (busy.current) return;
    const why = reason.trim();
    if (charCount(why) < REASON_MIN) {
      setMsg({ ok: false, text: m.reject.reasonShort });
      return;
    }
    busy.current = true;
    setMsg(null);
    const ok = await confirm({
      title: m.reject.title,
      message: m.reject.body,
      confirmLabel: m.reject.confirm,
      tone: "danger",
      details: [
        { label: m.reject.dReason, value: why, multiline: true },
        ...LANGS.map((lang) => ({ label: LABELS[lang], value: post.texts[lang], multiline: true })),
      ],
      successMessage: m.reject.done,
      run: call({ action: "reject", id: post.id, reason: why }),
    });
    busy.current = false;
    if (ok || stale.current) {
      setReason("");
      setMode("view");
      refresh();
    }
  }

  const titleId = `mk-post-${post.id}`;
  const posterOff = !settings.enabled;
  const dirty = LANGS.some((l) => draft[l].trim() !== post.texts[l]);
  const draftPreview = buildPreview({ uz: draft.uz.trim(), ru: draft.ru.trim(), en: draft.en.trim() }, post.link, origin, Boolean(post.mediaPath));
  const editProblem = LANGS.some((l) => draft[l].trim() === "")
    ? m.edit.empty
    : LANGS.some((l) => charCount(draft[l].trim()) > TEXT_MAX)
      ? m.edit.langTooLong
      : draftPreview.over
        ? m.edit.tooLong
        : null;

  return (
    <article className="panel flex flex-col gap-3 p-4 sm:p-5" aria-labelledby={titleId} data-post-status={post.status}>
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 id={titleId} className="text-base font-semibold text-[var(--color-fg)]">
            {m.kind[post.kind]}
          </h3>
          <StatusLamp tone={TONE[post.status]} label={m.status[post.status]} live={post.status === "sending"} />
        </div>
        <p className="break-all text-xs text-[var(--color-muted)]">{fmt(m.post.source, { source: post.sourceRef })}</p>
        <p className="text-xs text-[var(--color-muted)]">
          {[
            fmt(m.post.created, { age: relativeTime(post.createdAt, locale, nowMs) }),
            post.editedAt ? fmt(m.post.editedAt, { when: when(post.editedAt) }) : "",
            post.factsAsOf ? fmt(m.post.factsAsOf, { when: when(post.factsAsOf) }) : "",
            post.status === "approved" && post.approvedAt ? fmt(m.post.approvedAt, { when: when(post.approvedAt) }) : "",
            post.status === "sent" && post.sentAt ? fmt(m.post.sentAt, { when: when(post.sentAt) }) : "",
            post.attempts !== null && post.maxAttempts !== null && post.attempts > 0 ? fmt(m.post.attempts, { n: post.attempts, max: post.maxAttempts }) : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {post.status === "rejected" && (
          <p className="break-words text-xs text-[var(--color-muted)]">
            {post.rejectReason
              ? fmt(m.post.rejected, { when: when(post.rejectedAt), reason: post.rejectReason })
              : fmt(m.post.rejectedNoReason, { when: when(post.rejectedAt) })}
          </p>
        )}
      </header>

      {note && (
        <div
          className="flex flex-col gap-1 rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm"
          style={{ color: note.tone === "fail" ? "var(--color-fail)" : "var(--color-fg)" }}
          role={note.tone === "fail" ? "alert" : undefined}
        >
          {note.lines.map((l) => (
            <p key={l} className="break-words">
              {l}
            </p>
          ))}
        </div>
      )}

      {mode === "edit" ? (
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!editProblem && dirty) void save();
          }}
        >
          <h4 className="text-sm font-semibold text-[var(--color-fg)]">{m.edit.title}</h4>
          {post.status === "approved" && <p className="text-xs text-[var(--color-warn)]">{m.edit.voidsApproval}</p>}
          {LANGS.map((lang) => (
            <label key={lang} className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
              {fmt(m.edit.langLabel, { lang: LABELS[lang] })}
              <textarea
                rows={4}
                lang={lang}
                value={draft[lang]}
                onChange={(e) => setDraft({ ...draft, [lang]: e.target.value })}
                className="ns-field min-w-0"
              />
              <span className="tnum">{fmt(m.edit.count, { n: draft[lang].trim().length })}</span>
            </label>
          ))}
          <TelegramPreview texts={{ uz: draft.uz.trim(), ru: draft.ru.trim(), en: draft.en.trim() }} link={post.link} mediaPath={post.mediaPath} origin={origin} />
          {editProblem && (
            <p role="alert" className="text-xs font-medium text-[var(--color-fail)]">
              {editProblem}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <button type="submit" disabled={Boolean(editProblem) || !dirty} className="btn-primary min-h-11 px-4 text-sm disabled:opacity-55">
              {m.edit.save}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(post.texts);
                setMode("view");
              }}
              className="btn-quiet min-h-11 px-4 text-sm"
            >
              {m.edit.cancel}
            </button>
          </div>
        </form>
      ) : (
        <TelegramPreview texts={post.texts} link={post.link} mediaPath={post.mediaPath} origin={origin} />
      )}

      {mode === "reject" && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-[var(--color-fg)]">{m.reject.panelTitle}</h4>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            {m.reject.reasonLabel}
            <textarea
              rows={2}
              maxLength={REASON_MAX}
              value={reason}
              placeholder={m.reject.reasonPh}
              onChange={(e) => setReason(e.target.value)}
              className="ns-field min-w-0"
            />
            <span className="flex justify-between gap-3">
              <span>{m.reject.reasonHint}</span>
              <span className="tnum">{fmt(m.poster.reasonCount, { n: charCount(reason.trim()) })}</span>
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <button
              type="button"
              onClick={() => void reject()}
              disabled={charCount(reason.trim()) < REASON_MIN}
              className="btn-danger min-h-11 px-4 text-sm disabled:opacity-55"
            >
              {m.reject.next}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("view");
                setReason("");
              }}
              className="btn-quiet min-h-11 px-4 text-sm"
            >
              {m.reject.cancel}
            </button>
          </div>
        </div>
      )}

      {open && mode === "view" && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-3 sm:flex sm:flex-wrap">
            {post.status === "draft" && (
              <button
                type="button"
                onClick={() => void approve()}
                disabled={posterOff}
                aria-label={fmt(m.approve.aria, { source: post.sourceRef })}
                className="btn-primary min-h-11 px-4 text-sm disabled:opacity-55"
              >
                {m.approve.button}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setDraft(post.texts);
                setMode("edit");
                setMsg(null);
              }}
              aria-label={fmt(m.edit.aria, { source: post.sourceRef })}
              className="btn-quiet min-h-11 px-4 text-sm"
            >
              {m.edit.button}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("reject");
                setMsg(null);
              }}
              aria-label={fmt(m.reject.aria, { source: post.sourceRef })}
              className="btn-quiet min-h-11 px-4 text-sm"
            >
              {m.reject.button}
            </button>
          </div>
          {post.status === "draft" && posterOff && <p className="text-xs text-[var(--color-warn)]">{m.approve.needPosterOn}</p>}
        </div>
      )}
      <p className="min-h-4 break-words text-xs" style={{ color: msg?.ok ? "var(--color-ok)" : "var(--color-fail)" }} aria-live="polite">
        {msg?.text}
      </p>
    </article>
  );
}
