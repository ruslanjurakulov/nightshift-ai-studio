"use client";

import { useCallback, useState } from "react";
import { ImageOff, Palette, Plus, UserRound } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
import { StyleEditorSheet, type EditorTarget } from "@/components/studio/StyleEditorSheet";
import {
  CHARACTER_LIMITS,
  KIT_LIMITS,
  coverOf,
  missingCount,
  type Character,
  type StyleKit,
  type StyleReference,
} from "@/lib/style-kits";

/**
 * The Studio's two library-built sections (migration 0047): style kits and
 * characters, each a grid of cards with a create / edit sheet and a confirmed
 * delete. With one channel in view, a kit can be made that channel's default
 * look.
 *
 * Everything goes through /api/style-kits and /api/characters under the
 * member's session. Nothing here generates, renders, spends or publishes, and
 * nothing reads a kit during a run yet.
 */
export function StyleSections({
  orgId,
  initialKits,
  initialCharacters,
  channelId,
  channelKitId,
  libraryHref,
}: {
  orgId: string;
  initialKits: StyleKit[];
  initialCharacters: Character[];
  /** The scoped channel, or null with "All channels" in view. */
  channelId: string | null;
  /** That channel's default kit, when it has one. */
  channelKitId: string | null;
  libraryHref: string;
}) {
  const { t } = useI18n();
  const ts = t.styleKits;
  const [kits, setKits] = useState(initialKits);
  const [characters, setCharacters] = useState(initialCharacters);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [attached, setAttached] = useState<string | null>(channelKitId);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ section: "kit" | "character"; text: string } | null>(null);
  const { confirm, dialog } = useConfirm();

  const refreshKits = useCallback(async () => {
    try {
      const res = await fetch(`/api/style-kits?org=${encodeURIComponent(orgId)}`, { cache: "no-store" });
      if (!res.ok) throw new Error("read");
      setKits(((await res.json()) as { kits: StyleKit[] }).kits ?? []);
    } catch {
      setNotice({ section: "kit", text: ts.readFailed });
    }
  }, [orgId, ts.readFailed]);

  const refreshCharacters = useCallback(async () => {
    try {
      const res = await fetch(`/api/characters?org=${encodeURIComponent(orgId)}`, { cache: "no-store" });
      if (!res.ok) throw new Error("read");
      setCharacters(((await res.json()) as { characters: Character[] }).characters ?? []);
    } catch {
      setNotice({ section: "character", text: ts.readFailed });
    }
  }, [orgId, ts.readFailed]);

  async function remove(target: { mode: "kit"; item: StyleKit } | { mode: "character"; item: Character }) {
    const isKit = target.mode === "kit";
    const ok = await confirm({
      title: isKit ? ts.deleteKitTitle : ts.deleteCharTitle,
      message: fmt(isKit ? ts.deleteKitMessage : ts.deleteCharMessage, { name: target.item.name }),
      confirmLabel: ts.delete,
      cancelLabel: ts.cancel,
    });
    if (!ok) return;
    setBusy(target.item.id);
    setNotice(null);
    try {
      const res = await fetch(`${isKit ? "/api/style-kits" : "/api/characters"}/${target.item.id}`, { method: "DELETE" });
      // Already gone is the outcome that was asked for.
      if (!res.ok && res.status !== 404) throw new Error("delete");
      if (isKit) {
        setKits((k) => k.filter((x) => x.id !== target.item.id));
        if (attached === target.item.id) setAttached(null);
      } else {
        setCharacters((c) => c.filter((x) => x.id !== target.item.id));
      }
    } catch {
      setNotice({ section: target.mode, text: ts.deleteFailed });
    } finally {
      setBusy(null);
    }
  }

  async function attach(kitId: string | null) {
    if (!channelId) return;
    setBusy(kitId ?? attached);
    setNotice(null);
    try {
      const res = await fetch("/api/style-kits/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: channelId, kit_id: kitId }),
      });
      if (!res.ok) throw new Error("attach");
      setAttached(kitId);
    } catch {
      setNotice({ section: "kit", text: ts.attachFailed });
    } finally {
      setBusy(null);
    }
  }

  function onSaved() {
    const mode = editor?.mode;
    setEditor(null);
    setNotice(null);
    if (mode === "kit") void refreshKits();
    else void refreshCharacters();
  }

  return (
    <>
      {/* Style kits */}
      <section className="flex flex-col gap-3" aria-labelledby="style-kits-title">
        <SectionHead
          id="style-kits-title"
          title={ts.kitsTitle}
          hint={fmt(ts.kitsHint, { min: KIT_LIMITS.minRefs, max: KIT_LIMITS.maxRefs })}
          action={ts.newKit}
          onAction={() => setEditor({ mode: "kit", item: null })}
          disabled={kits.length >= KIT_LIMITS.perOrg}
        />
        {!channelId && kits.length > 0 && <p className="text-[12px] text-[var(--color-muted)]">{ts.pickChannelForKit}</p>}
        {notice?.section === "kit" && <Notice text={notice.text} />}
        {kits.length === 0 ? (
          <EmptyCard icon="kit" text={ts.emptyKits} action={ts.newKit} onAction={() => setEditor({ mode: "kit", item: null })} />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {kits.map((k) => {
              const isDefault = attached === k.id;
              return (
                <li key={k.id}>
                  <Card
                    references={k.references}
                    title={k.name}
                    subtitle={k.description}
                    badge={isDefault ? ts.channelDefault : null}
                    busy={busy === k.id}
                    onEdit={() => setEditor({ mode: "kit", item: k })}
                    onDelete={() => void remove({ mode: "kit", item: k })}
                    extra={
                      channelId ? (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void attach(isDefault ? null : k.id)}
                          aria-pressed={isDefault}
                          className={`disabled:opacity-50 w-full ${isDefault ? "btn-quiet" : "btn-primary"}`}
                        >
                          {isDefault ? ts.removeFromChannel : ts.useForChannel}
                        </button>
                      ) : null
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Characters */}
      <section className="flex flex-col gap-3" aria-labelledby="characters-title">
        <SectionHead
          id="characters-title"
          title={ts.charsTitle}
          hint={fmt(ts.charsHint, { min: CHARACTER_LIMITS.minRefs, max: CHARACTER_LIMITS.maxRefs })}
          action={ts.newChar}
          onAction={() => setEditor({ mode: "character", item: null })}
          disabled={characters.length >= CHARACTER_LIMITS.perOrg}
        />
        {notice?.section === "character" && <Notice text={notice.text} />}
        {characters.length === 0 ? (
          <EmptyCard
            icon="character"
            text={ts.emptyChars}
            action={ts.newChar}
            onAction={() => setEditor({ mode: "character", item: null })}
          />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {characters.map((c) => (
              <li key={c.id}>
                <Card
                  references={c.references}
                  title={`@${c.name}`}
                  mono
                  subtitle={c.description}
                  badge={c.kind === "product" ? ts.kindProduct : ts.kindCharacter}
                  quietBadge
                  busy={busy === c.id}
                  onEdit={() => setEditor({ mode: "character", item: c })}
                  onDelete={() => void remove({ mode: "character", item: c })}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {editor && (
        <StyleEditorSheet
          key={`${editor.mode}:${editor.item?.id ?? "new"}`}
          target={editor}
          orgId={orgId}
          libraryHref={libraryHref}
          onClose={() => setEditor(null)}
          onSaved={onSaved}
        />
      )}
      {dialog}
    </>
  );
}

function SectionHead({
  id,
  title,
  hint,
  action,
  onAction,
  disabled,
}: {
  id: string;
  title: string;
  hint: string;
  action: string;
  onAction: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 flex-1 basis-64">
        <h2 id={id} className="t-section">
          {title}
        </h2>
        <p className="t-lead mt-2 text-[13px]">{hint}</p>
      </div>
      <button
        type="button"
        onClick={onAction}
        disabled={disabled}
        className="disabled:opacity-50 btn-primary inline-flex items-center gap-1.5 text-[13px]"
      >
        <Plus aria-hidden className="size-4" />
        {action}
      </button>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <p role="alert" className="text-[13px]" style={{ color: "var(--color-fail)" }}>
      {text}
    </p>
  );
}

function EmptyCard({
  icon,
  text,
  action,
  onAction,
}: {
  icon: "kit" | "character";
  text: string;
  action: string;
  onAction: () => void;
}) {
  const Icon = icon === "kit" ? Palette : UserRound;
  return (
    <div className="panel flex flex-col items-center gap-3 px-6 py-10 text-center">
      <span
        aria-hidden
        className="grid size-12 place-items-center rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-muted)]"
      >
        <Icon className="size-5" strokeWidth={1.5} />
      </span>
      <p className="m-0 max-w-[46ch] text-[13px] text-[var(--color-muted)]">{text}</p>
      <button type="button" onClick={onAction} className="disabled:opacity-50 btn-quiet text-[13px]">
        {action}
      </button>
    </div>
  );
}

function Card({
  references,
  title,
  mono,
  subtitle,
  badge,
  quietBadge,
  busy,
  onEdit,
  onDelete,
  extra,
}: {
  references: StyleReference[];
  title: string;
  mono?: boolean;
  subtitle: string;
  badge: string | null;
  quietBadge?: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  extra?: React.ReactNode;
}) {
  const { t } = useI18n();
  const ts = t.styleKits;
  const cover = coverOf(references);
  const missing = missingCount(references);
  return (
    <article
      className="panel flex h-full flex-col overflow-hidden p-0"
      style={badge && !quietBadge ? { borderColor: "var(--color-primary)" } : undefined}
      aria-busy={busy}
    >
      <div className="relative aspect-[4/3] w-full bg-[var(--color-panel-2)]">
        {cover?.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <span className="grid h-full w-full place-items-center gap-1 text-[11px] text-[var(--color-muted)]">
            <ImageOff aria-hidden className="size-5" />
            {ts.noPreview}
          </span>
        )}
        {badge && (
          <span
            className="absolute left-2 top-2 rounded-[var(--ns-r-chip)] px-2 py-0.5 text-[10px] font-semibold"
            style={
              quietBadge
                ? { background: "rgba(0,0,0,0.55)", color: "#fff" }
                : { background: "var(--color-primary)", color: "var(--color-on-accent)" }
            }
          >
            {badge}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <h3 className={`truncate text-[14px] font-semibold text-[var(--color-fg)] ${mono ? "mono" : ""}`} title={title}>
          {title}
        </h3>
        {subtitle && <p className="line-clamp-2 text-[12px] text-[var(--color-muted)]">{subtitle}</p>}
        <p className="mono text-[11px] text-[var(--color-muted)]">
          {fmt(ts.imagesCount, { n: references.length - missing })}
          {missing > 0 && (
            <span style={{ color: "var(--color-warn)" }}> · {fmt(ts.missingRefs, { n: missing })}</span>
          )}
        </p>
        <div className="mt-auto flex flex-col gap-2 pt-2">
          {extra}
          <div className="flex gap-2">
            <button type="button" onClick={onEdit} disabled={busy} className="disabled:opacity-50 btn-quiet flex-1 text-[12px]">
              {ts.edit}
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="disabled:opacity-50 btn-quiet flex-1 text-[12px]"
              style={{ color: "var(--color-fail)" }}
            >
              {ts.delete}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
