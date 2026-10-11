"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Clapperboard } from "lucide-react";
import { LibraryDialog } from "@/components/media/LibraryDialog";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { STILL_DEFAULT_S, cleanTitle, parseTitle, type EditorError } from "@/lib/editor";
import { listProjects, sendAsset, type ProjectChoice } from "./editorApi";

export type SendKind = "video" | "image" | "audio";

/** What can be sent: the library kinds the editor knows. */
export function isSendKind(kind: unknown): kind is SendKind {
  return kind === "video" || kind === "image" || kind === "audio";
}

/**
 * "Open in editor": one button (and its dialog) for a library file — a
 * generated video, picture or sound — wherever the file is shown (the library
 * viewer, a Studio result card). The dialog sends the file to a NEW project or
 * to one the organization already has, then opens it.
 *
 * Sending writes an editing document and nothing else: no export is started,
 * nothing is priced, nothing is published. Whose files and projects these are
 * is checked by the route and by the database (POST /api/editor/send), never
 * here — this component only offers what the member's own session can read.
 */
export function SendToEditor({
  orgId,
  assetId,
  kind,
  name,
  variant = "button",
  className,
  onOpenChange,
}: {
  orgId: string;
  assetId: string;
  kind: SendKind;
  /** The file's name, offered as the new project's name. */
  name?: string | null;
  /** "icon": a round icon button for a card's corner; "button": a labelled button. */
  variant?: "icon" | "button";
  className?: string;
  /** Told when the dialog opens or closes: a host that is itself an overlay stands its keyboard handling down meanwhile. */
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const ts = te.send;
  const [open, setOpenState] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };
  // The host must not be left thinking the dialog is open if this unmounts with it up.
  const told = useRef(onOpenChange);
  told.current = onOpenChange;
  useEffect(() => () => told.current?.(false), []);

  return (
    <>
      <button
        ref={opener}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={variant === "icon" ? ts.action : undefined}
        title={variant === "icon" ? ts.action : undefined}
        className={className ?? (variant === "icon" ? "tap-icon grid size-9 place-items-center rounded-[var(--ns-r-key)]" : "btn-quiet text-sm")}
        data-testid="open-in-editor"
      >
        <Clapperboard aria-hidden className="size-4" />
        {variant === "button" ? ts.action : null}
      </button>
      {open ? <SendDialog orgId={orgId} assetId={assetId} kind={kind} name={name ?? null} onClose={() => setOpen(false)} opener={opener} /> : null}
    </>
  );
}

function SendDialog({
  orgId,
  assetId,
  kind,
  name,
  onClose,
  opener,
}: {
  orgId: string;
  assetId: string;
  kind: SendKind;
  name: string | null;
  onClose: () => void;
  opener: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const ts = te.send;
  const path = useChannelPath();
  const router = useRouter();
  const ids = useId();
  const [projects, setProjects] = useState<ProjectChoice[] | null>(null);
  const [listError, setListError] = useState<EditorError | null>(null);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [picked, setPicked] = useState("");
  const [title, setTitle] = useState(() => cleanTitle(name ?? "").slice(0, 120) || te.defaultTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EditorError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setListError(null);
    setProjects(null);
    void listProjects(orgId).then((out) => {
      if (!live) return;
      if (out.ok) {
        setProjects(out.value);
        setPicked((p) => p || out.value[0]?.id || "");
      } else setListError(out.error);
    });
    return () => {
      live = false;
    };
  }, [orgId, attempt]);

  const none = projects !== null && projects.length === 0;
  const existing = mode === "existing" && !none;

  async function submit() {
    if (busy) return;
    setError(null);
    let target: { project: string } | { title: string };
    if (existing) {
      if (!picked) return;
      target = { project: picked };
    } else {
      const parsed = parseTitle(title);
      if (!parsed.ok) {
        setError("invalid_title");
        return;
      }
      target = { title: parsed.value };
    }
    setBusy(true);
    const out = await sendAsset(orgId, assetId, target);
    if (!out.ok) {
      setBusy(false);
      setError(out.error);
      return;
    }
    // Stay "busy" while the editor opens: a second press would add the file twice.
    router.push(path(`/editor/${out.value.id}`));
  }

  const note = kind === "image" ? fmt(ts.stillNote, { s: STILL_DEFAULT_S }) : kind === "audio" ? ts.soundNote : ts.videoNote;
  const field =
    "rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-base text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]";

  return (
    <LibraryDialog
      title={ts.title}
      description={ts.lead}
      onClose={onClose}
      opener={opener}
      initialFocus={first}
      closeLabel={ts.close}
      busy={busy}
      wide
      testId="open-in-editor-dialog"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn-quiet text-sm">
            {ts.cancel}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || (projects === null && !listError) || (existing && !picked)}
            className="btn-primary text-sm"
          >
            {busy ? ts.sending : ts.submit}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        {projects === null && !listError ? (
          <p className="m-0 text-sm text-[var(--color-muted)]" aria-live="polite">
            {ts.loadingProjects}
          </p>
        ) : null}
        {listError ? (
          <div className="flex flex-wrap items-center gap-3" role="alert">
            <p className="m-0 text-sm text-[var(--color-fail)]">{ts.projectsFailed}</p>
            <button type="button" className="btn-quiet text-xs" onClick={() => setAttempt((n) => n + 1)}>
              {ts.retry}
            </button>
          </div>
        ) : null}
        {none ? <p className="m-0 text-sm text-[var(--color-muted)]">{ts.noProjects}</p> : null}

        {projects && projects.length > 0 ? (
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="sr-only">{ts.title}</legend>
            {(["new", "existing"] as const).map((m) => (
              <label key={m} className="flex items-center gap-2 text-sm text-[var(--color-fg)]">
                <input
                  type="radio"
                  name={`${ids}-mode`}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  className="size-4 accent-[var(--color-primary)]"
                />
                {m === "new" ? ts.newOption : ts.existingOption}
              </label>
            ))}
          </fieldset>
        ) : null}

        {existing ? (
          <label htmlFor={`${ids}-project`} className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            {ts.pickProject}
            <select id={`${ids}-project`} value={picked} onChange={(e) => setPicked(e.target.value)} className={field}>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        ) : projects !== null || listError ? (
          <label htmlFor={`${ids}-title`} className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            {ts.projectName}
            <input
              ref={first}
              id={`${ids}-title`}
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              className={field}
            />
          </label>
        ) : null}

        {projects !== null || listError ? <p className="m-0 text-xs text-[var(--color-muted)]">{note}</p> : null}
        {error ? (
          <p role="alert" className="m-0 text-sm text-[var(--color-fail)]">
            {te.errors[error]}
          </p>
        ) : null}
      </div>
    </LibraryDialog>
  );
}
