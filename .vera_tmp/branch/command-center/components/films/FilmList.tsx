"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { LocalTime } from "@/components/ui/LocalTime";
import { STUDIO_PROJECTS } from "@/lib/navigation";
import { filmStudioStrings, type FilmStudioDictionary } from "@/lib/i18n/film-studio";
import { lengthText as lengthFor } from "@/components/films/lengthText";
import {
  CREATE_LIMITS,
  FILM_ASPECTS,
  FILM_LANGUAGES,
  TARGET_SECONDS,
  clock,
  filmsApi,
  newIdempotencyKey,
  type FilmAspect,
  type FilmError,
  type FilmLanguage,
  type FilmListItem,
  type SourceKind,
} from "@/lib/films";
import { FilmErrorNotice } from "@/components/films/FilmErrorNotice";

// Browser UI preference only: no project IDs, records or draft content.
const PROJECTS_VIEW_KEY = "ns.studio.projects.view.v1";
type ProjectsView = "open" | "archived";
function rememberedProjectsView(): ProjectsView {
  try { return window.localStorage.getItem(PROJECTS_VIEW_KEY) === "archived" ? "archived" : "open"; }
  catch { return "open"; }
}
function rememberProjectsView(view: ProjectsView) {
  try { window.localStorage.setItem(PROJECTS_VIEW_KEY, view); }
  catch { /* A blocked browser preference never blocks the list. */ }
}

export type FilmListInitial = { state: "ok"; films: FilmListItem[] } | { state: "not_available" } | { state: "failed" };

/** The lamp of a project's status: violet only while the machine works, amber never (no person's mark on a list row). */
function lampOf(status: FilmListItem["status"]): string | undefined {
  if (status === "planning" || status === "queued" || status === "running" || status === "draining" || status === "assembling") return "work";
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  if (status === "paused") return "warn";
  return undefined;
}

/**
 * Studio → Projects, the list (docs/FILM_STUDIO.md): the open workspace's projects, the archived ones a tap away, and "New project",
 * which creates a draft and nothing else. Everything is read and written through /api/films as the member; nothing here prices or
 * spends. Every state is drawn: loading, empty, failed with retry, not set up, read-only.
 */
export function FilmList({
  initial,
  canEdit,
  channel,
  studioName,
}: {
  initial: FilmListInitial;
  canEdit: boolean;
  channel: { id: string; name: string } | null;
  studioName: string;
}) {
  const { locale } = useI18n();
  const t = filmStudioStrings(locale);
  const path = useChannelPath();
  const [view, setView] = useState<ProjectsView>("open");
  const [state, setState] = useState<FilmListInitial | { state: "loading" } | { state: "error"; error: FilmError }>(initial);
  const [composing, setComposing] = useState(false);
  const newKey = useRef<HTMLButtonElement>(null);

  const listRequest = useRef(0);
  const load = useCallback(async (which: ProjectsView) => {
    const request = ++listRequest.current;
    setState({ state: "loading" });
    const r = await filmsApi().list(which === "archived");
    if (request !== listRequest.current) return;
    if (r.ok) setState({ state: "ok", films: r.data });
    else if (r.error === "not_available") setState({ state: "not_available" });
    else setState({ state: "error", error: r.error });
  }, []);

  useEffect(() => {
    if (initial.state === "not_available") return;
    const remembered = rememberedProjectsView();
    if (remembered === "archived") {
      setView(remembered);
      void load(remembered);
    }
  }, [initial.state, load]);

  const pick = (which: ProjectsView) => {
    if (which === view) return;
    setView(which);
    rememberProjectsView(which);
    void load(which);
  };

  if (state.state === "not_available") {
    return (
      <div className="fs-root">
        <FilmNote tone="warn" text={t.notAvailable} />
      </div>
    );
  }

  const openDrafts = state.state === "ok" && view === "open" ? state.films.filter((f) => f.status === "draft" || f.status === "planned").length : null;

  return (
    <div className="fs-root fs-list">
      <div className="fs-list-head">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="fs-h2">{fmt(t.list.heading, { studio: studioName })}</h2>
          {openDrafts !== null && <p className="fs-small">{fmt(t.list.countOpen, { n: openDrafts, max: CREATE_LIMITS.max_open_drafts })}</p>}
        </div>
        <div className="fs-row">
          <div className="fs-seg" role="group" aria-label={t.list.viewLabel}>
            <button type="button" aria-pressed={view === "open"} onClick={() => pick("open")}>
              {t.list.viewOpen}
            </button>
            <button type="button" aria-pressed={view === "archived"} onClick={() => pick("archived")}>
              {t.list.viewArchived}
            </button>
          </div>
          {canEdit && !composing && (
            <button ref={newKey} type="button" className="btn-primary min-h-11 px-4 text-sm" onClick={() => setComposing(true)} data-testid="fs-new">
              <Plus aria-hidden className="size-4" />
              {t.list.newProject}
            </button>
          )}
        </div>
      </div>

      {!canEdit && <FilmNote tone="human" text={t.list.readOnly} />}

      {composing && canEdit && (
        <NewProject
          t={t}
          channel={channel}
          onCancel={() => {
            setComposing(false);
            requestAnimationFrame(() => newKey.current?.focus());
          }}
          onCreated={() => setComposing(false)}
          hrefFor={(id) => path(`${STUDIO_PROJECTS}/${id}`)}
        />
      )}

      {state.state === "loading" ? (
        <ul className="fs-grid" aria-busy="true" aria-label={t.loading}>
          {[0, 1, 2].map((i) => (
            <li key={i} className="fs-skel" aria-hidden="true" />
          ))}
        </ul>
      ) : state.state === "failed" || state.state === "error" ? (
        <FilmErrorNotice t={t} error={state.state === "error" ? state.error : "failed"} fallback={t.list.loadFailed} onRetry={() => void load(view)} />
      ) : state.films.length === 0 ? (
        <div className="fs-empty" data-testid="fs-empty">
          <p className="m-0 text-base">{view === "archived" ? t.list.emptyArchived : t.list.empty}</p>
          {view === "open" && canEdit && !composing && (
            <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={() => setComposing(true)}>
              <Plus aria-hidden className="size-4" />
              {t.list.newProject}
            </button>
          )}
        </div>
      ) : (
        <ul className="fs-grid" data-testid="fs-list">
          {state.films.map((f) => (
            <li key={f.id}>
              <Link href={path(`${STUDIO_PROJECTS}/${f.id}`)} className="fs-card" aria-label={fmt(t.list.open, { title: f.title })}>
                <div className="fs-film" aria-hidden="true">
                  <div className="fs-img fs-holo" />
                </div>
                <div className="fs-card-body">
                  <span className="fs-card-title">{f.title}</span>
                  <span className="fs-status" style={{ padding: 0 }}>
                    <span className="fs-lamp" data-s={lampOf(f.status)} />
                    <span>{t.status[f.status]}</span>
                  </span>
                  <span className="fs-meta">
                    <span>{fmt(t.list.target, { length: clock(f.targetSeconds) })}</span>
                    <span>{f.aspect}</span>
                    <span>{t.languages[f.language]}</span>
                  </span>
                  <span className="fs-meta">
                    <span>
                      {t.list.changed} <LocalTime iso={f.updatedAt} locale={locale} />
                    </span>
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilmNote({ tone, text }: { tone: "warn" | "human" | "fail"; text: string }) {
  return (
    <div className="fs-notice" data-tone={tone} role={tone === "fail" ? "alert" : undefined}>
      <span className="fs-lamp" data-s={tone === "fail" ? "failed" : tone} aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

const charCount = (s: string) => [...s].length;

/**
 * The new-project composer. One idempotency key per request: kept across a retry of the same press (so a double press or a retry
 * after a lost answer makes one draft), and dropped as soon as anything in the form changes (so a changed request is never refused
 * as a conflict of the old one).
 */
function NewProject({
  t,
  channel,
  onCancel,
  onCreated,
  hrefFor,
}: {
  t: FilmStudioDictionary;
  channel: { id: string; name: string } | null;
  onCancel: () => void;
  onCreated: () => void;
  hrefFor: (id: string) => string;
}) {
  const { locale } = useI18n();
  const router = useRouter();
  const id = useId();
  const [kind, setKind] = useState<SourceKind>("topic");
  const [source, setSource] = useState("");
  const [title, setTitle] = useState("");
  const [seconds, setSeconds] = useState<number>(300);
  const [language, setLanguage] = useState<FilmLanguage>((FILM_LANGUAGES as readonly string[]).includes(locale) ? (locale as FilmLanguage) : "en");
  const [aspect, setAspect] = useState<FilmAspect>("16:9");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ error: FilmError; detail?: string } | null>(null);
  const [tried, setTried] = useState(false);
  const idem = useRef<string | null>(null);
  const first = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, []);

  const changed = <T,>(set: (v: T) => void) => (v: T) => {
    idem.current = null;
    set(v);
  };

  const max = kind === "script" ? CREATE_LIMITS.max_script_chars : CREATE_LIMITS.max_topic_chars;
  const sourceLen = charCount(source);
  const titleLen = charCount(title);
  const sourceBad = sourceLen > max || source.trim().length === 0;
  const titleBad = titleLen > CREATE_LIMITS.max_title_chars || title.trim().length === 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (busy || sourceBad || titleBad) return;
    setBusy(true);
    setFailure(null);
    idem.current ??= newIdempotencyKey();
    const r = await filmsApi().create({
      source_kind: kind,
      source_text: source,
      title: title.trim(),
      language,
      aspect,
      target_seconds: seconds,
      channel_id: channel?.id ?? null,
      idem: idem.current,
    });
    if (r.ok) {
      idem.current = null;
      onCreated();
      router.push(hrefFor(r.data.film.id));
      return;
    }
    setBusy(false);
    setFailure({ error: r.error, detail: r.detail });
  };

  return (
    <form className="fs-composer fs-glass" onSubmit={submit} aria-labelledby={`${id}-h`} noValidate data-testid="fs-composer">
      <div className="flex flex-col gap-1">
        <h3 id={`${id}-h`} className="fs-h2">
          {t.create.heading}
        </h3>
        <p className="fs-small">{t.create.lead}</p>
      </div>

      <div className="fs-field">
        <fieldset>
          <legend>{t.create.sourceLabel}</legend>
          <div className="fs-seg" style={{ marginTop: 6 }}>
            {(["topic", "script"] as const).map((k) => (
              <label key={k}>
                <input type="radio" name={`${id}-kind`} value={k} checked={kind === k} onChange={() => changed(setKind)(k)} />
                {k === "topic" ? t.create.fromTopic : t.create.fromScript}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="fs-field" data-bad={tried && sourceBad ? "true" : undefined}>
        <label htmlFor={`${id}-src`}>{kind === "topic" ? t.create.topicLabel : t.create.scriptLabel}</label>
        <textarea
          ref={first}
          id={`${id}-src`}
          className="ns-field"
          rows={kind === "script" ? 8 : 3}
          value={source}
          placeholder={kind === "topic" ? t.create.topicPlaceholder : t.create.scriptPlaceholder}
          onChange={(e) => changed(setSource)(e.target.value)}
          aria-invalid={tried && sourceBad ? true : undefined}
          aria-describedby={`${id}-src-n`}
        />
        <p id={`${id}-src-n`} className={sourceLen > max ? "fs-bad" : "fs-small"}>
          {tried && source.trim().length === 0 ? t.create.required : sourceLen > max ? fmt(t.create.tooLong, { n: sourceLen - max }) : fmt(t.create.left, { n: max - sourceLen })}
        </p>
      </div>

      <div className="fs-fields">
        <div className="fs-field" data-bad={tried && titleBad ? "true" : undefined}>
          <label htmlFor={`${id}-title`}>{t.create.titleLabel}</label>
          <input
            id={`${id}-title`}
            className="ns-field"
            value={title}
            placeholder={t.create.titlePlaceholder}
            onChange={(e) => changed(setTitle)(e.target.value)}
            aria-invalid={tried && titleBad ? true : undefined}
            aria-describedby={`${id}-title-n`}
          />
          <p id={`${id}-title-n`} className={titleLen > CREATE_LIMITS.max_title_chars ? "fs-bad" : "fs-small"}>
            {tried && title.trim().length === 0
              ? t.create.required
              : titleLen > CREATE_LIMITS.max_title_chars
                ? fmt(t.create.tooLong, { n: titleLen - CREATE_LIMITS.max_title_chars })
                : fmt(t.create.left, { n: CREATE_LIMITS.max_title_chars - titleLen })}
          </p>
        </div>
        <div className="fs-field">
          <label htmlFor={`${id}-len`}>{t.create.lengthLabel}</label>
          <select id={`${id}-len`} className="ns-field" value={seconds} onChange={(e) => changed(setSeconds)(Number(e.target.value))}>
            {TARGET_SECONDS.map((s) => (
              <option key={s} value={s}>
                {lengthFor(t, s)}
              </option>
            ))}
          </select>
        </div>
        <div className="fs-field">
          <label htmlFor={`${id}-lang`}>{t.create.languageLabel}</label>
          <select id={`${id}-lang`} className="ns-field" value={language} onChange={(e) => changed(setLanguage)(e.target.value as FilmLanguage)} aria-describedby={`${id}-lang-h`}>
            {FILM_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {t.languages[l]}
              </option>
            ))}
          </select>
          <p id={`${id}-lang-h`} className="fs-small">
            {t.create.languageHint}
          </p>
        </div>
        <div className="fs-field">
          <label htmlFor={`${id}-aspect`}>{t.create.formatLabel}</label>
          <select id={`${id}-aspect`} className="ns-field" value={aspect} onChange={(e) => changed(setAspect)(e.target.value as FilmAspect)}>
            {FILM_ASPECTS.map((a) => (
              <option key={a} value={a}>
                {t.create.aspects[a]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="fs-small">{channel ? fmt(t.create.channelNote, { channel: channel.name }) : t.create.noChannelNote}</p>

      {failure && <FilmErrorNotice t={t} error={failure.error} detail={failure.detail} />}

      <div className="fs-row">
        <button type="submit" className="btn-primary min-h-11 px-4 text-sm" disabled={busy} aria-disabled={busy || undefined} data-testid="fs-create">
          {busy ? t.create.submitting : t.create.submit}
        </button>
        <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={onCancel} disabled={busy}>
          {t.create.cancel}
        </button>
        <span className="fs-small">{t.create.spendsNothing}</span>
      </div>
    </form>
  );
}
