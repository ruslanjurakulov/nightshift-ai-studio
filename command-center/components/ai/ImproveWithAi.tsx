"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { LibraryDialog } from "@/components/media/LibraryDialog";
import { SendDialog } from "@/components/editor/SendToEditor";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { improveAvailable, improveHref, improveTools, isStudioTool, type ImproveKind, type ImproveTool } from "@/lib/creative/improve";

/**
 * "Improve with AI" on a file: one button and the dialog it opens, wherever
 * the file is shown — a library tile, the library viewer, an editor clip or
 * overlay picture.
 *
 * The dialog lists the AI tools that fit the file's type. Each one is a plain
 * link into the EXISTING Studio tool with this file already chosen; the price
 * is the Studio's own quote and nothing starts until the person presses its
 * priced Generate. A tool no model is sold for here is shown as "not
 * available on this deployment yet" and cannot be followed. Nothing in this
 * component prices, holds, starts or spends anything.
 *
 * Captions are made in the editor: from the editor (`onCaptions`) the entry
 * jumps to the Captions panel; from the library (`orgId`) it opens the usual
 * "Open in editor" dialog and the editor then opens on that panel.
 */
export function ImproveWithAi({
  assetId,
  kind,
  name,
  available,
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
  const path = useChannelPath();
  const tx = t.improveAi;
  const [open, setOpenState] = useState(false);
  const [sending, setSendingState] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLElement>(null);
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
  if (tools.length === 0) return null;

  // Captions need somewhere to be made: the editor (here) or a way into it (from the library).
  const captionsWay: "here" | "send" | null = onCaptions ? "here" : orgId && kind === "video" ? "send" : null;
  const rows = tools.filter((tool) => tool !== "captions" || captionsWay !== null);
  const firstOpenIndex = rows.findIndex((tool) => improveAvailable(tool, available));

  return (
    <>
      <button
        ref={opener}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
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
        <LibraryDialog
          title={tx.title}
          description={fmt(tx.lead, { name: label })}
          onClose={() => setOpen(false)}
          opener={opener}
          initialFocus={first}
          closeLabel={tx.close}
          wide
          testId="improve-with-ai-dialog"
        >
          <ul className="m-0 flex list-none flex-col gap-2 p-0 pb-3">
            {rows.map((tool, i) => (
              <li key={tool}>
                <ToolRow
                  tool={tool}
                  available={improveAvailable(tool, available)}
                  href={isStudioTool(tool) ? improveHref(tool, assetId, project) : null}
                  captionsWay={tool === "captions" ? captionsWay : null}
                  focusRef={i === firstOpenIndex ? first : undefined}
                  onCaptions={() => {
                    if (captionsWay === "here") {
                      setOpen(false);
                      onCaptions?.();
                    } else {
                      setOpenState(false);
                      setSending(true);
                    }
                  }}
                  channelPath={path}
                />
              </li>
            ))}
          </ul>
        </LibraryDialog>
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

const row =
  "flex min-h-11 w-full items-center justify-between gap-3 rounded-[var(--ns-r-key)] border border-[var(--color-border)] px-3 py-2.5 text-left";

function ToolRow({
  tool,
  available,
  href,
  captionsWay,
  focusRef,
  onCaptions,
  channelPath,
}: {
  tool: ImproveTool;
  available: boolean;
  href: string | null;
  captionsWay: "here" | "send" | null;
  focusRef?: React.RefObject<HTMLElement | null>;
  onCaptions: () => void;
  channelPath: (p: string) => string;
}) {
  const { t } = useI18n();
  const tx = t.improveAi;
  const copy = tx.tools[tool];
  const body = (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm font-semibold text-[var(--color-fg)]">{copy.label}</span>
      <span className="text-xs text-[var(--color-muted)]">{copy.hint}</span>
      {available && tool === "captions" && captionsWay === "send" ? (
        <span className="text-xs text-[var(--color-muted)]">{tx.inEditor}</span>
      ) : null}
      {!available ? <span className="text-xs text-[var(--color-warn)]">{tx.unavailable}</span> : null}
    </span>
  );

  if (!available || (isStudioTool(tool) && !href)) {
    return (
      <div className={`${row} opacity-70`} aria-disabled="true" data-tool={tool} data-state="unavailable">
        {body}
      </div>
    );
  }
  if (tool === "captions") {
    return (
      <button
        type="button"
        ref={focusRef as React.RefObject<HTMLButtonElement> | undefined}
        onClick={onCaptions}
        className={`${row} hover:border-[var(--color-primary)]`}
        data-tool={tool}
        data-state="ready"
      >
        {body}
        <ArrowRight aria-hidden className="size-4 shrink-0 text-[var(--color-muted)]" />
      </button>
    );
  }
  return (
    <Link
      href={channelPath(href as string)}
      ref={focusRef as React.RefObject<HTMLAnchorElement> | undefined}
      className={`${row} hover:border-[var(--color-primary)]`}
      data-tool={tool}
      data-state="ready"
    >
      {body}
      <ArrowRight aria-hidden className="size-4 shrink-0 text-[var(--color-muted)]" />
    </Link>
  );
}
