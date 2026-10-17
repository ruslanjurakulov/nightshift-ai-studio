"use client";

import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronDown, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useOverlay } from "@/components/a11y/useOverlay";
import { ALL_CHANNELS_SLUG, selectionSlug, type ChannelSelection } from "@/lib/channels";
import { channelSwitchHref, rememberChannel, switchOrganization } from "@/lib/context-switch";
import type { OrgSummary } from "@/lib/orgs";
import type { ChannelRow } from "@/lib/types";

/**
 * The owner's phone header has ONE workspace control, not two truncated pills ("Nig…", "Chr…").
 * The button reads the organization small above the channel, each as wide as the row allows; a tap opens a
 * sheet with the full names of every organization and channel to switch to. From `sm` the header shows
 * the desktop pair (OrgSwitcher, ChannelSwitcher) instead and this renders nothing visible.
 *
 * It does what those two do (lib/context-switch): a channel swaps the first URL segment and keeps the
 * screen; an organization asks /api/org/select, then lands on that organization's first channel.
 * Renders nothing when there is one organization and one channel: nothing to choose.
 */
export function ContextSwitcher({
  orgs,
  currentOrgId,
  channels,
  selection,
}: {
  orgs: OrgSummary[];
  currentOrgId: string | null;
  channels: ChannelRow[];
  selection: ChannelSelection;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOverlay(open, { onClose: () => setOpen(false), container: sheetRef, opener: openerRef });

  const manyOrgs = orgs.length >= 2;
  const manyChannels = channels.length >= 2;
  if (!manyOrgs && !manyChannels) return null;

  const org = orgs.find((o) => o.id === currentOrgId) ?? null;
  const channel = channels.find((c) => c.channel_id === selection) ?? null;
  // The big line is the channel when there is a choice of channels, else the organization.
  const main = manyChannels ? (channel?.name ?? t.channels.allChannels) : (org?.name ?? t.ownerShell.ctxOrg);
  const small = manyChannels && manyOrgs ? (org?.name ?? null) : null;

  function pickChannel(id: string) {
    setOpen(false);
    rememberChannel(selectionSlug(id, channels));
    router.push(channelSwitchHref(id, channels, pathname));
  }

  async function pickOrg(id: string) {
    if (id === currentOrgId) {
      setOpen(false);
      return;
    }
    if (busy) return;
    setBusy(true);
    setFailed(false);
    if (await switchOrganization(id)) {
      setOpen(false);
      router.push(`/${ALL_CHANNELS_SLUG}`);
      router.refresh();
    } else {
      setFailed(true);
    }
    setBusy(false);
  }

  return (
    <div className="min-w-0 flex-1 sm:hidden">
      <button
        ref={openerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t.ownerShell.ctxLabel}: ${small ? small + ", " : ""}${main}`}
        data-context-switcher=""
        className="btn-sky is-quiet pill h-11 w-full min-w-0 max-w-[16rem] justify-start gap-2 px-3 text-left"
      >
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ background: !manyChannels || channel?.status === "ACTIVE" ? "var(--color-ok)" : channel ? "var(--color-idle)" : "var(--color-primary)" }}
        />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          {small && <span className="truncate text-xs text-[var(--color-muted)]">{small}</span>}
          <span className="truncate text-sm font-medium text-[var(--color-fg)]">{main}</span>
        </span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-[var(--color-muted)]" />
      </button>

      {/* In <body>, not here: the header's backdrop blur makes it the containing block of anything fixed inside it. */}
      {open &&
        createPortal(
        <div className="fixed inset-0 z-50 sm:hidden">
          <div aria-hidden="true" className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="sheet-enter absolute inset-x-0 bottom-0 flex max-h-[80dvh] flex-col gap-4 overflow-y-auto rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[var(--shadow-elevated)] outline-none"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 id={titleId} className="min-w-0 text-base font-semibold text-[var(--color-fg)]">
                {t.ownerShell.ctxLabel}
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t.ownerShell.ctxClose}
                className="btn-sky is-quiet pill inline-flex size-11 shrink-0 items-center justify-center p-0"
              >
                <X aria-hidden className="size-4" />
              </button>
            </div>
            {failed && (
              <p role="alert" className="text-sm text-[var(--color-fail)]">
                {t.ownerShell.ctxFailed}
              </p>
            )}
            {manyOrgs && (
              <PickList
                title={t.ownerShell.ctxOrg}
                items={orgs.map((o) => ({
                  id: o.id,
                  name: o.name,
                  sub: `${o.slug}${o.is_default ? ` · ${t.org.defaultBadge}` : ""}`,
                  active: o.id === currentOrgId,
                }))}
                onPick={pickOrg}
                disabled={busy}
              />
            )}
            {manyChannels && (
              <PickList
                title={t.ownerShell.ctxChannel}
                items={channels.map((c) => ({
                  id: c.channel_id,
                  name: c.name || c.channel_id,
                  sub: c.niche || c.channel_id,
                  active: c.channel_id === selection,
                  tone: c.status === "ACTIVE" ? ("ok" as const) : ("idle" as const),
                }))}
                onPick={pickChannel}
              />
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function PickList({
  title,
  items,
  onPick,
  disabled = false,
}: {
  title: string;
  items: { id: string; name: string; sub: string; active: boolean; tone?: "ok" | "idle" }[];
  onPick: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-1 text-xs font-semibold text-[var(--color-muted)]">{title}</h3>
      <ul className="flex flex-col gap-1">
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              disabled={disabled}
              aria-current={it.active ? "true" : undefined}
              onClick={() => onPick(it.id)}
              className="btn-sky is-quiet pill min-h-11 w-full justify-start gap-3 border-transparent px-3 py-2 text-left disabled:opacity-60"
              style={{ background: it.active ? "var(--color-panel-2)" : "transparent" }}
            >
              {it.tone && (
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: it.tone === "ok" ? "var(--color-ok)" : "var(--color-idle)" }} />
              )}
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-medium" style={{ color: it.active ? "var(--color-primary)" : "var(--color-fg)" }}>
                  {it.name}
                </span>
                <span className="tnum block break-words text-xs text-[var(--color-muted)]">{it.sub}</span>
              </span>
              {it.active && <Check aria-hidden className="size-4 shrink-0 text-[var(--color-primary)]" />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
