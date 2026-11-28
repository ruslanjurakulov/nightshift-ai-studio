"use client";

import { useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/Sheet";

/**
 * The library's small dialogs (a folder's name, "delete this folder?", the
 * move picker): a bottom sheet on a phone, a centred card from `sm` up.
 *
 * The shell is the shared Sheet (components/ui, Radix Dialog): focus moves in (to
 * `initialFocus`, else the card), Tab stays inside, Escape and a press outside close
 * it, the page behind is inert and does not scroll, and focus goes back to the
 * control that opened it.
 */
export function LibraryDialog({
  title,
  description,
  onClose,
  opener,
  initialFocus,
  closeLabel,
  children,
  footer,
  wide = false,
  busy = false,
  testId,
  side = false,
}: {
  /**
   * A panel along the right edge from `lg` up (full height, the page still visible beside it) instead of a centred
   * card; a bottom sheet on a phone either way. For a dialog someone works in for a while ("Improve with AI").
   */
  side?: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  opener?: RefObject<HTMLElement | null>;
  initialFocus?: RefObject<HTMLElement | null>;
  closeLabel: string;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** While a request runs, Escape and the scrim do not close it (the answer has somewhere to land). */
  busy?: boolean;
  testId?: string;
}) {
  const card = useRef<HTMLDivElement>(null);
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent
        side="auto"
        data-dock={side ? "right" : undefined}
        data-testid={testId}
        data-placement={side ? "side" : "center"}
        closeLabel={null}
        style={{ "--ui-sheet-w": wide ? "520px" : "420px" } as CSSProperties}
        ref={card}
        // No description: say so to Radix (an explicit undefined), rather than describing the dialog by its own title again.
        {...(description ? {} : { "aria-describedby": undefined })}
        onOpenAutoFocus={(e) => {
          // As before: the field it asks for, else the card itself (not its close key, which Radix would pick).
          e.preventDefault();
          (initialFocus?.current ?? card.current)?.focus();
        }}
        onCloseAutoFocus={(e) => {
          if (opener?.current?.isConnected) {
            e.preventDefault();
            opener.current.focus();
          }
        }}
        // A running request keeps the sheet: the answer has somewhere to land.
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onInteractOutside={(e) => busy && e.preventDefault()}
      >
        <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-5">
          <div className="flex min-w-0 flex-col gap-1">
            <SheetTitle className="m-0 break-words text-base font-semibold leading-snug text-[var(--ds-text)]">{title}</SheetTitle>
            {description && <SheetDescription className="m-0 text-sm leading-relaxed text-[var(--ds-muted)]">{description}</SheetDescription>}
          </div>
          <SheetClose className="ui-close shrink-0" aria-label={closeLabel} disabled={busy}>
            <X className="size-4" aria-hidden />
          </SheetClose>
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">{children}</div>}
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">{footer}</div>
        )}
      </SheetContent>
    </Sheet>
  );
}
