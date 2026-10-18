"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { postOperator } from "@/lib/operator-post";
import { charCount } from "@/lib/owner-rpc";
import {
  LABELS,
  LANGS,
  LINK_CHOICES,
  TEXT_MAX,
  buildPreview,
  linkOk,
  newRequestId,
  senderRefusal,
  textProblem,
  textsProblem,
  looksUnsafe,
  type Lang,
  type Texts,
} from "@/lib/marketing-posts";
import { bannedHits, type BannedHit } from "@/lib/marketing-banned";
import { marketingFailureText, unitCount } from "@/lib/marketing-text";
import type { ConfirmOptions } from "@/components/feedback/ConfirmDialog";
import { TelegramPreview } from "@/components/marketing/TelegramPreview";

const ENDPOINT = "/api/marketing";
const OTHER = "__other";

type Confirm = (opts: ConfirmOptions) => Promise<boolean>;
type Dict = ReturnType<typeof useI18n>["t"]["marketing"];

/** What the page says once a draft was made (or found to exist): the post's id so the message can point at its card. */
type Done = { tone: "created" | "existing" | "existingDifferent"; id: string | null };

/**
 * The owner writes a post of his own ("custom", migration 0110): three texts, an optional link on our own site, a live Telegram
 * preview, and a warning for banned wording. Saving goes through the confirm sheet and /api/marketing (action create) ->
 * owner_marketing_create, as the signed-in user, and makes a DRAFT. Nothing here approves, sends or tests anything: the owner
 * approves on the card like every other post.
 *
 * Banned wording is shown, never enforced: the database cannot read docs/news/banned-claims.json, so this page checks the texts
 * against a copy of the list (lib/marketing-banned.ts) and the owner decides. The sheet repeats the hits.
 */
export function NewPostPanel({
  origin,
  confirm,
  refresh,
}: {
  origin: string | null;
  confirm: Confirm;
  refresh: () => void;
}) {
  const { t } = useI18n();
  const m = t.marketing;
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  // Where focus goes once the form is gone (its buttons are unmounted): back to "New post…" after Cancel, to the message after a save.
  const after = useRef<"button" | "done" | null>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const doneNote = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (open || after.current === null) return;
    (after.current === "done" ? doneNote.current : openButton.current)?.focus();
    after.current = null;
  }, [open]);

  return (
    <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-labelledby="mk-new-title" data-new-post="">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id="mk-new-title" className="t-section">
          {m.newPost.title}
        </h2>
        {!open && (
          <button
            ref={openButton}
            type="button"
            onClick={() => {
              setDone(null);
              setOpen(true);
            }}
            aria-label={m.newPost.aria}
            className="btn-quiet min-h-11 px-4 text-sm"
          >
            {m.newPost.button}
          </button>
        )}
      </div>
      {open ? (
        // A new form is a new screen: it makes its own request id once, and closing it throws that id away.
        <NewPostForm
          origin={origin}
          confirm={confirm}
          onClose={() => {
            after.current = "button";
            setOpen(false);
          }}
          onDone={(d) => {
            after.current = "done";
            setDone(d);
            setOpen(false);
            refresh();
          }}
        />
      ) : (
        <p className="text-xs leading-relaxed text-[var(--color-muted)]">{m.newPost.draftNote}</p>
      )}
      <div aria-live="polite" className="min-h-4">
        {done && (
          <p ref={doneNote} tabIndex={-1} className="break-words text-sm" style={{ color: done.tone === "created" ? "var(--color-ok)" : "var(--color-warn)" }} data-new-post-done={done.tone}>
            {done.tone === "created" ? m.newPost.created : done.tone === "existing" ? m.newPost.existing : m.newPost.existingDifferent}{" "}
            {done.id && (
              <a href={`#mk-post-${done.id}`} className="underline">
                {m.newPost.showDraft}
              </a>
            )}
          </p>
        )}
      </div>
    </section>
  );
}

/** The words about one hit: a rule's sentence, or the provider-name sentence. */
function hitSentence(m: Dict, hit: BannedHit): string {
  if (hit.id.startsWith("provider:")) return fmt(m.newPost.banned.provider, { name: hit.id.slice("provider:".length) });
  const rules = m.newPost.banned.rules as Record<string, string>;
  return Object.prototype.hasOwnProperty.call(rules, hit.id) ? rules[hit.id] : fmt(m.newPost.banned.unknownRule, { id: hit.id });
}

function hitFound(m: Dict, hit: BannedHit): string {
  return hit.found.map((f) => fmt(m.newPost.banned.found, { lang: LABELS[f.lang], text: f.text })).join(" · ");
}

function NewPostForm({
  origin,
  confirm,
  onClose,
  onDone,
}: {
  origin: string | null;
  confirm: Confirm;
  onClose: () => void;
  onDone: (d: Done) => void;
}) {
  const { t, locale } = useI18n();
  const m = t.marketing;
  // Made ONCE per screen and sent with every attempt: a double tap or a retry names the same post (the database keys on it).
  const [requestId] = useState(newRequestId);
  const [draft, setDraft] = useState<Texts>({ uz: "", ru: "", en: "" });
  const [choice, setChoice] = useState("");
  const [typed, setTyped] = useState("");
  const busy = useRef(false);
  const firstField = useRef<HTMLTextAreaElement>(null);
  const idBase = useId();
  // A phone keyboard opens on the first text, not on nothing.
  useEffect(() => {
    firstField.current?.focus();
  }, []);

  const texts: Texts = { uz: draft.uz.trim(), ru: draft.ru.trim(), en: draft.en.trim() };
  const link = choice === OTHER ? typed.trim() : choice;
  const linkBad = link !== "" && !linkOk(link);
  const sendLink = link === "" || linkBad ? null : link;
  const empty = LANGS.every((l) => texts[l] === "");

  const pv = buildPreview(texts, sendLink, origin, false);
  const problem = textsProblem(texts);
  // The sender would refuse text shaped like a key or an address, or a message over 4096 UTF-16 units (an emoji counts two).
  const refusal = problem === null && !linkBad ? senderRefusal(texts, sendLink, origin, false, true) : null;
  const hits = bannedHits(texts);
  const blocked = problem !== null || linkBad || refusal !== null;

  const problemText =
    problem === "empty"
      ? m.newPost.problem.empty
      : problem === "bad_chars"
        ? m.newPost.problem.badChars
        : problem === "lang_too_long"
          ? m.newPost.problem.langTooLong
          : refusal === "too_long"
            ? m.edit.tooLong
            : refusal === "unsafe_text"
              ? m.approve.blockedUnsafe
              : refusal
                ? fmt(m.approve.blockedOther, { code: refusal })
                : null;

  async function create() {
    if (busy.current || blocked) return;
    busy.current = true;
    // Set by the call inside the sheet (an assignment in a closure does not narrow a plain variable).
    const made: { done: Done | null } = { done: null };
    const ok = await confirm({
      title: m.newPost.confirmTitle,
      message: m.newPost.confirmBody,
      confirmLabel: m.newPost.confirmButton,
      tone: "primary",
      details: [
        { label: m.newPost.dKind, value: m.kind.custom },
        ...LANGS.map((lang: Lang) => ({ label: fmt(m.approve.dLang, { lang: LABELS[lang] }), value: texts[lang], multiline: true })),
        ...(sendLink ? [{ label: m.newPost.dLink, value: pv.linkUrl ?? sendLink }] : []),
        { label: m.newPost.dCount, value: fmt(pv.linkUncounted ? m.preview.totalAtLeast : m.preview.total, { n: pv.total, limit: pv.limit }) },
        {
          label: m.newPost.dBanned,
          value: hits.length === 0 ? m.newPost.dBannedNone : hits.map((h) => `${hitSentence(m, h)} ${hitFound(m, h)}`).join("\n"),
          multiline: true,
        },
      ],
      successMessage: m.newPost.created,
      run: async () => {
        const out = await postOperator(ENDPOINT, { action: "create", requestId, texts, link: sendLink });
        if (!out.ok) return marketingFailureText(t, out, true);
        const data = out.data as Record<string, unknown>;
        const id = typeof data.id === "string" ? data.id : null;
        made.done = { tone: data.created === false ? (data.same_texts === false ? "existingDifferent" : "existing") : "created", id };
        return true;
      },
    });
    busy.current = false;
    if (ok && made.done) onDone(made.done);
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <p className="text-xs leading-relaxed text-[var(--color-muted)]">{m.newPost.intro}</p>

      {LANGS.map((lang) => {
        const n = charCount(texts[lang]);
        const fieldId = `${idBase}-${lang}`;
        // Invalid for any reason that keeps Create off for this language (an empty one counts once the owner has typed elsewhere).
        const invalid = !empty && (textProblem(texts[lang]) !== null || looksUnsafe(texts[lang]));
        return (
          <div key={lang} className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            <label htmlFor={fieldId}>{fmt(m.newPost.langLabel, { lang: LABELS[lang] })}</label>
            <textarea
              id={fieldId}
              ref={lang === LANGS[0] ? firstField : undefined}
              rows={4}
              lang={lang}
              value={draft[lang]}
              onChange={(e) => setDraft({ ...draft, [lang]: e.target.value })}
              className="ns-field min-w-0"
              aria-invalid={invalid}
              aria-describedby={`${fieldId}-count`}
            />
            <span id={`${fieldId}-count`} className={`tnum ${n > TEXT_MAX ? "font-semibold text-[var(--color-fail)]" : ""}`}>
              {fmt(m.newPost.count, { chars: n, max: TEXT_MAX, units: unitCount(t, locale, texts[lang].length) })}
            </span>
          </div>
        );
      })}

      <div className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
        <label className="flex flex-col gap-1">
          {m.newPost.linkLabel}
          <select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="ns-field min-h-11 min-w-0"
          >
            <option value="">{m.newPost.linkNone}</option>
            {LINK_CHOICES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value={OTHER}>{m.newPost.linkOther}</option>
          </select>
        </label>
        {choice === OTHER && (
          <label className="flex flex-col gap-1">
            {m.newPost.linkOtherLabel}
            <input
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={typed}
              placeholder={m.newPost.linkOtherPh}
              onChange={(e) => setTyped(e.target.value)}
              className="ns-field min-h-11 min-w-0"
              aria-invalid={linkBad}
            />
          </label>
        )}
        <span>{m.newPost.linkHint}</span>
        {linkBad && (
          <span role="alert" className="font-medium text-[var(--color-fail)]">
            {m.newPost.linkBad}
          </span>
        )}
      </div>

      {!empty && <TelegramPreview texts={texts} link={sendLink} mediaPath={null} origin={origin} />}

      {!empty && (
        <section
          className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-border)] px-3 py-2 text-xs"
          aria-label={m.newPost.banned.title}
          data-banned={hits.length === 0 ? "none" : "hits"}
        >
          <h4 className="text-sm font-semibold text-[var(--color-fg)]">{m.newPost.banned.title}</h4>
          {hits.length === 0 ? (
            <p className="text-[var(--color-muted)]">{m.newPost.banned.none}</p>
          ) : (
            <>
              <p className="text-[var(--color-warn)]">{m.newPost.banned.lead}</p>
              <ul className="flex flex-col gap-1.5">
                {hits.map((h) => (
                  <li key={h.id} className="break-words text-[var(--color-fg)]" data-banned-id={h.id}>
                    <span className="font-semibold text-[var(--color-warn)]">{hitSentence(m, h)}</span>
                    <br />
                    <span className="text-[var(--color-muted)]">{hitFound(m, h)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {problemText && !empty && (
        <p role="alert" className="text-xs font-medium text-[var(--color-fail)]">
          {problemText}
        </p>
      )}
      <p className="text-xs text-[var(--color-muted)]">{m.newPost.draftNote}</p>

      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:flex">
        <button type="submit" disabled={blocked} className="btn-primary min-h-11 px-4 text-sm disabled:opacity-55">
          {m.newPost.create}
        </button>
        <button type="button" onClick={onClose} className="btn-quiet min-h-11 px-4 text-sm">
          {m.newPost.cancel}
        </button>
      </div>
    </form>
  );
}
