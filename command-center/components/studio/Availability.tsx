"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { useShell } from "@/components/shell/ShellContext";
import { DESK_TOOLS, deskHref, type MediaDesk } from "@/lib/creative/desks";
import { closedTools, deskOpen, nothingOnSale } from "@/lib/tool-availability";
import "@/components/studio/availability.css";

/**
 * Said where the Studio's tools are offered when not one of them has a model on sale (lib/tool-availability.ts): plainly that
 * nothing is for sale here, and the one thing that does work today, the YouTube video desk. Never a dead end, never "coming soon".
 * Renders nothing while anything is on sale or while that is unknown.
 */
export function NothingOnSaleNote({ testId = "nothing-on-sale" }: { testId?: string }) {
  const { t } = useI18n();
  const path = useChannelPath();
  const { tools } = useShell();
  if (!nothingOnSale(tools)) return null;
  const a = t.availability;
  return (
    <section className="av-note" role="note" aria-label={a.noneTitle} data-testid={testId}>
      <p className="av-note-title">{a.noneTitle}</p>
      <p className="av-note-body">{a.noneBody}</p>
      <Link href={path(deskHref("youtube"))} className="btn-quiet inline-flex min-h-11 items-center gap-2 px-4 text-sm">
        {a.noneCta}
        <ArrowRight aria-hidden className="size-4" />
      </Link>
    </section>
  );
}

/**
 * Over a desk's composer: when none of its tools is on sale, the whole desk says so and points at the YouTube video; when some are
 * not, one line names them, so a tab that leads to "Nothing to pick yet" is known before it is pressed. Nothing while all are on sale
 * or availability is unknown.
 */
export function DeskAvailabilityNote({ desk }: { desk: MediaDesk }) {
  const { t, fmt } = useI18n();
  const path = useChannelPath();
  const { tools } = useShell();
  const closed = closedTools(tools, DESK_TOOLS[desk]);
  if (closed.length === 0) return null;
  const a = t.availability;
  const names = closed.map((c) => t.desk.tools[c]).join(", ");
  if (!deskOpen(tools, desk)) {
    return (
      <section className="av-note" role="note" aria-label={a.deskTitle} data-testid="desk-closed">
        <p className="av-note-title">{a.deskTitle}</p>
        <p className="av-note-body">{fmt(a.deskBody, { tools: names })}</p>
        <Link href={path(deskHref("youtube"))} className="btn-quiet inline-flex min-h-11 items-center gap-2 px-4 text-sm">
          {a.noneCta}
          <ArrowRight aria-hidden className="size-4" />
        </Link>
      </section>
    );
  }
  return (
    <p className="av-line" data-testid="desk-some-closed">
      {fmt(a.someClosed, { tools: names })}
    </p>
  );
}
