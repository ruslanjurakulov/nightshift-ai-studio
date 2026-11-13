"use client";

import Link from "next/link";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, ArrowUp, Sparkles } from "lucide-react";
import { LibraryDialog } from "@/components/media/LibraryDialog";
import { SendDialog } from "@/components/editor/SendToEditor";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { isUuid } from "@/lib/creative/operations";
import type { StudioModel } from "@/lib/creative/studio";
import {
  AUTO_MODEL,
  improveAvailable,
  improveHref,
  improveModels,
  improvePromptMax,
  improveTools,
  improveWords,
  isStudioTool,
  type ImproveKind,
  type ImproveTool,
} from "@/lib/creative/improve";

/**
 * "Improve with AI" on a file: one button and the panel it opens, wherever the file is shown — a library tile, the
 * library viewer, an editor clip or overlay picture. A bottom sheet on a phone, a side panel on a wide screen.
 *
 * The panel asks three things, and only fills in a link with them:
 *  - which tool: the AI tools that fit the file's type; a tool no model is offered for here is listed as "not
 *    available on this deployment yet" and cannot be picked (never hidden, as if it did not exist);
 *  - which model: the Studio's own list for that tool (the operator's previews included where the Studio shows
 *    them), with "Auto" where the Studio offers it;
 *  - what should change: a box like the Studio composer's (Enter goes, Shift+Enter is a new line), required where the
 *    tool is asked by words, optional where words help, and off where the tool takes none.
 *
 * "See the price" (or Enter) only OPENS the existing Studio tool with the file, tool, model and words filled in. The
 * price is the Studio's own quote and nothing starts until the person presses its priced Generate: nothing in this
 * component prices, holds, starts or spends anything (CLAUDE.md #3). It sends nothing while the panel is open: the
 * send key is a Link with prefetch off, because its href carries the typed words (`prompt=`) and changes on every
 * keystroke — a production prefetch would render the Studio route's layout (session and organization reads) for each
 * one and write the half-typed words into the access log. The one request is the navigation itself, on a press.
 *
 * Captions are made in the editor: from the editor (`onCaptions`) the entry jumps to the Captions panel; from the
 * library (`orgId`) it opens the usual "Open in editor" dialog and the editor then opens on that panel.
 */
export function ImproveWithAi({
  assetId,
  kind,
  name,
  available,
  models = null,
  orgId,
  project,
  onCaptions,
  variant = "button",
  className,
  onOpenChange,
}: {
  assetId: string;
  kind: ImproveKind;
  name?: string | null;
  /** The capabilities sold here (lib/server/ai-tools); null = not known, the tools are still offered. */
  available: readonly string[] | null;
  /** The Studio's models for these tools (lib/server/ai-tools loadImproveModels); null = not known: the Studio picks. */
  models?: readonly StudioModel[] | null;
  /** The file's organization: lets the library offer Captions through "Open in editor". */
  orgId?: string;
  /** An editor project the person is working in: carried to the Studio so the result can be added back. */
  project?: string | null;
  /** In the editor: Captions jump to the Captions panel of this project. */
  onCaptions?: () => void;
  /** "icon": a round icon button for a tile's corner; "button": a labelled button. */
  variant?: "icon" | "button";
  className?: string;
  /** Told when a dialog opens or closes: a host that is itself an overlay stands its keyboard handling down meanwhile. */
  onOpenChange?: (open: boolean) => void;
}) {
  const { t, fmt } = useI18n();
  const tx = t.improveAi;
  const [open, setOpenState] = useState(false);
  const [sending, setSendingState] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const label = name?.trim() || tx.unnamed;

  const tell = (o: boolean, s: boolean) => onOpenChange?.(o || s);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    tell(v, sending);
  };
  const setSending = (v: boolean) => {
    setSendingState(v);
    tell(open, v);
  };

  const tools = improveTools(kind);
  // A file id that is not an id has nothing the Studio could open: no button rather than a dead end.
  if (tools.length === 0 || !isUuid(assetId)) return null;

  // Captions need somewhere to be made: the editor (here) or a way into it (from the library).
  const captionsWay: "here" | "send" | null = onCaptions ? "here" : orgId && kind === "video" ? "send" : null;

  return (
    <>
      <button
        ref={opener}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={variant === "icon" ? fmt(tx.actionFor, { name: label }) : undefined}
        title={variant === "icon" ? tx.action : undefined}
        className={
          className ??
          (variant === "icon"
            ? "tap-icon press grid size-9 place-items-center rounded-[var(--ns-r-key)] max-sm:size-11 pointer-coarse:size-11"
            : "btn-quiet text-sm")
        }
        data-testid="improve-with-ai"
        data-kind={kind}
      >
        <Sparkles aria-hidden className="size-4" />
        {variant === "button" ? tx.action : null}
      </button>
      {open ? (
        <ImprovePanel
          assetId={assetId}
          kind={kind}
          label={label}
          available={available}
          models={models}
          project={project}
          captionsWay={captionsWay}
          opener={opener}
          onClose={() => setOpen(false)}
          onCaptions={() => {
            if (captionsWay === "here") {
              setOpen(false);
              onCaptions?.();
            } else {
              setOpenState(false);
              setSending(true);
            }
          }}
        />
      ) : null}
      {sending && orgId && kind === "video" ? (
        <SendDialog
          orgId={orgId}
          assetId={assetId}
          kind="video"
          name={name ?? null}
          focus="captions"
          onClose={() => setSending(false)}
          opener={opener}
        />
      ) : null}
    </>
  );
}

const rowBase =
  "flex min-h-11 w-full items-start gap-3 rounded-[var(--ns-r-key)] border px-3 py-2.5 text-left transition-colors";

function ImprovePanel({
  assetId,
  kind,
  label,
  available,
  models,
  project,
  captionsWay,
  opener,
  onClose,
  onCaptions,
}: {
  assetId: string;
  kind: ImproveKind;
  label: string;
  available: readonly string[] | null;
  models: readonly StudioModel[] | null;
  project?: string | null;
  captionsWay: "here" | "send" | null;
  opener: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onCaptions: () => void;
}) {
  const { t, fmt } = useI18n();
  const path = useChannelPath();
  const tx = t.improveAi;
  const tp = tx.panel;
  const ids = useId();
  const firstFocus = useRef<HTMLInputElement>(null);
  const sendRef = useRef<HTMLAnchorElement>(null);

  const rows = improveTools(kind).filter((tool) => tool !== "captions" || captionsWay !== null);
  /** Whether a tool can be opened here: sold, and (when the list is known) with at least one model to run it. */
  const isOpen = (tool: ImproveTool) => {
    if (!improveAvailable(tool, available)) return false;
    const list = improveModels(models, tool);
    return list === null || !isStudioTool(tool) || list.models.length > 0;
  };
  const [tool, setTool] = useState<ImproveTool>(() => rows.find(isOpen) ?? rows[0]!);
  const [modelPick, setModelPick] = useState("");
  const [prompt, setPrompt] = useState("");

  const toolOpen = isOpen(tool);
  const list = improveModels(models, tool);
  const choices = list ? [...(list.auto ? [AUTO_MODEL] : []), ...list.models.map((m) => m.id)] : [];
  // The Studio starts on its first model (GeneratePanel's effectiveModel): so does this, until another is picked.
  const model = list && toolOpen ? (choices.includes(modelPick) ? modelPick : (list.models[0]?.id ?? "")) : "";
  const words = improveWords(tool);
  const missingWords = words === "required" && prompt.trim() === "";
  const href = toolOpen && isStudioTool(tool) ? improveHref(tool, assetId, project, { model: model || null, prompt }) : null;
  const canSend = href !== null && !missingWords;
  const toolLabel = tx.tools[tool].label;

  function onWordsKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter opens the Studio, like the composer's send; Shift+Enter is a new line, and an IME's Enter only picks a word.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (e.repeat || !canSend) return;
    // The same link the key is: a client move in the app, a full load out of the editor (lib/editor-nav, useFullLoadLinks).
    sendRef.current?.click();
  }

  const modelName = (m: StudioModel) => (m.preview ? fmt(tp.preview, { name: m.displayName }) : m.beta ? fmt(tp.beta, { name: m.displayName }) : m.displayName);

  return (
    <LibraryDialog
      title={tx.title}
      description={fmt(tp.lead, { name: label })}
      onClose={onClose}
      opener={opener}
      initialFocus={toolOpen ? firstFocus : undefined}
      closeLabel={tx.close}
      wide
      side
      testId="improve-with-ai-dialog"
    >
      <div className="flex flex-col gap-5 pb-4">
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="t-label mb-2 p-0">{tp.toolLegend}</legend>
          {rows.map((r) => {
            const ok = isOpen(r);
            const on = r === tool;
            const copy = tx.tools[r];
            return (
              <label
                key={r}
                className={`${rowBase} ${
                  ok ? "cursor-pointer hover:border-[var(--color-primary)]" : "cursor-not-allowed opacity-70"
                } ${on ? "border-[var(--color-primary)] bg-[var(--ns-act-soft)]" : "border-[var(--color-border)]"}`}
                data-tool={r}
                data-state={ok ? "ready" : "unavailable"}
              >
                <input
                  ref={on ? firstFocus : undefined}
                  type="radio"
                  name={`${ids}-tool`}
                  value={r}
                  checked={on}
                  disabled={!ok}
                  // `disabled` already stops a pointer; the guard keeps a synthetic or assistive click from picking it.
                  onChange={() => ok && setTool(r)}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary)]"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-[var(--color-fg)]">{copy.label}</span>
                  <span className="text-xs text-[var(--color-muted)]">{copy.hint}</span>
                  {ok && r === "captions" && captionsWay === "send" ? <span className="text-xs text-[var(--color-muted)]">{tx.inEditor}</span> : null}
                  {!ok ? <span className="text-xs text-[var(--color-warn)]">{tx.unavailable}</span> : null}
                </span>
              </label>
            );
          })}
        </fieldset>

        {tool === "captions" ? (
          <button
            type="button"
            onClick={onCaptions}
            disabled={!toolOpen}
            className="btn-primary min-h-11 w-full justify-center text-sm disabled:opacity-40"
            data-testid="improve-captions"
          >
            {tp.captions}
            <ArrowRight aria-hidden className="size-4" />
          </button>
        ) : (
          <>
            <div className="flex flex-col gap-1.5" data-testid="improve-model">
              {list && toolOpen ? (
                <label htmlFor={`${ids}-model`} className="t-label">
                  {tp.modelLabel}
                </label>
              ) : (
                <span className="t-label">{tp.modelLabel}</span>
              )}
              {!toolOpen ? (
                <p className="m-0 text-sm text-[var(--color-muted)]" data-state="none">
                  {tp.modelNone}
                </p>
              ) : list === null ? (
                <p className="m-0 text-sm text-[var(--color-muted)]" data-state="studio">
                  {tp.modelStudio}
                </p>
              ) : (
                <select
                  id={`${ids}-model`}
                  value={model}
                  onChange={(e) => setModelPick(e.target.value)}
                  className="min-h-11 w-full rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] px-3 text-sm text-[var(--color-fg)]"
                >
                  {list.auto && <option value={AUTO_MODEL}>{tp.auto}</option>}
                  {list.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {modelName(m)}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${ids}-words`} className="t-label">
                {tp.wordsLabel}
              </label>
              {/* studio-field draws the box's focus ring and keeps the text area from drawing a second one inside it. */}
              <div className={`studio-field flex flex-col gap-2 p-2.5 ${words === "none" || !toolOpen ? "opacity-70" : ""}`}>
                <textarea
                  id={`${ids}-words`}
                  value={words === "none" ? "" : prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={onWordsKey}
                  rows={3}
                  maxLength={isStudioTool(tool) ? improvePromptMax(tool) : undefined}
                  disabled={words === "none" || !toolOpen}
                  required={words === "required"}
                  aria-required={words === "required"}
                  aria-invalid={missingWords && prompt !== "" ? true : undefined}
                  placeholder={words === "required" ? tp.wordsRequired : words === "optional" ? tp.wordsOptional : tp.wordsNone}
                  aria-describedby={`${ids}-hint ${ids}-rule`}
                  className="min-h-[4.5rem] w-full resize-y border-0 bg-transparent p-1 text-[15px] leading-relaxed text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)] disabled:cursor-not-allowed"
                  data-testid="improve-words"
                />
                <div className="flex items-center justify-between gap-3">
                  <span id={`${ids}-hint`} className="text-xs text-[var(--color-muted)] max-sm:sr-only">
                    {tp.enterHint}
                  </span>
                  {canSend ? (
                    <Link
                      ref={sendRef}
                      href={path(href as string)}
                      prefetch={false}
                      aria-label={fmt(tp.sendFor, { tool: toolLabel })}
                      className="btn-primary ml-auto min-h-11 shrink-0 gap-2 text-sm"
                      data-testid="improve-send"
                    >
                      {tp.send}
                      <ArrowUp aria-hidden className="size-4" />
                    </Link>
                  ) : (
                    <button
                      type="button"
                      disabled
                      aria-label={fmt(tp.sendFor, { tool: toolLabel })}
                      className="btn-primary ml-auto min-h-11 shrink-0 gap-2 text-sm disabled:opacity-40"
                      data-testid="improve-send"
                    >
                      {tp.send}
                      <ArrowUp aria-hidden className="size-4" />
                    </button>
                  )}
                </div>
              </div>
              <p id={`${ids}-rule`} className="m-0 min-h-[1.25em] text-xs text-[var(--color-muted)]" data-testid="improve-rule">
                {words === "none" ? tp.wordsNoneHint : missingWords ? tp.wordsRequiredHint : ""}
              </p>
            </div>
          </>
        )}

        <p className="m-0 text-xs leading-relaxed text-[var(--color-muted)]">{tp.note}</p>
      </div>
    </LibraryDialog>
  );
}
