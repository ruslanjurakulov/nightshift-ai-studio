"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import type { ChannelAgentConfig, ChannelElement } from "@/lib/types";

/**
 * Edit a channel's Character Bible (the "Cast") from the site.
 *
 * The bot already keeps recurring characters, locations and props consistent
 * across videos: for each scene it detects which of the channel's elements are
 * named and injects that element's description into the shot prompt so it stays
 * on-model (modules/elements.py, wired in main.py). What was missing was a way
 * to DEFINE that cast without editing JSON — this panel is it.
 *
 * It writes configuration only (nothing renders or publishes) and it edits just
 * the `elements` field of the channel's `agent_config`, merging into the config
 * loaded with the page so every other generator setting is preserved. Like the
 * schedule editor it needs a single channel: with "All channels" selected there
 * is no target, so the controls are disabled with a hint.
 *
 * Safety: these descriptions ride into image/video generation, so the same rule
 * the avatar layer enforces applies here — describe SYNTHETIC characters, never
 * a real, identifiable person. The note below says so; the Python avatar guard
 * is the hard stop when a presenter is actually generated.
 */
const KINDS = ["character", "location", "prop"] as const;
type Kind = (typeof KINDS)[number];
const MAX_ELEMENTS = 24;
const MAX_NAME = 80;
const MAX_DESC = 400;

type Row = { kind: Kind; name: string; description: string; aliases: string };

function toRows(elements: ChannelElement[] | undefined): Row[] {
  return (elements ?? []).map((e) => ({
    kind: (KINDS as readonly string[]).includes(e.kind ?? "") ? (e.kind as Kind) : "character",
    name: e.name ?? "",
    description: e.description ?? "",
    aliases: (e.aliases ?? []).join(", "),
  }));
}

/** Clean the editor rows into the stored shape: drop nameless rows, normalise
 * kind, split aliases, and cap lengths so a stray paste can't bloat the blob. */
function toElements(rows: Row[]): ChannelElement[] {
  const out: ChannelElement[] = [];
  for (const r of rows) {
    const name = r.name.trim().slice(0, MAX_NAME);
    if (!name) continue;
    const aliases = r.aliases
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean)
      .slice(0, 12);
    const el: ChannelElement = { kind: r.kind, name };
    const description = r.description.trim().slice(0, MAX_DESC);
    if (description) el.description = description;
    if (aliases.length) el.aliases = aliases;
    out.push(el);
    if (out.length >= MAX_ELEMENTS) break;
  }
  return out;
}

export function CastEditor({
  channelId,
  agentConfig,
}: {
  /** The scoped channel's id, or null when "All channels" is selected. */
  channelId: string | null;
  /** The channel's current agent_config (its `elements` seed this editor). */
  agentConfig: ChannelAgentConfig | null;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[]>(() => toRows(agentConfig?.elements));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const disabled = !channelId;

  function touch() {
    if (state !== "idle") setState("idle");
  }
  function update(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    touch();
  }
  function addRow() {
    setRows((prev) =>
      prev.length >= MAX_ELEMENTS
        ? prev
        : [...prev, { kind: "character", name: "", description: "", aliases: "" }],
    );
    touch();
  }
  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, j) => j !== i));
    touch();
  }

  async function save() {
    if (!channelId || state === "saving") return;
    const supabase = createClient();
    if (!supabase) return;
    setState("saving");
    // Merge into the config loaded with the page so no other generator setting
    // is lost — only `elements` changes.
    const nextConfig: ChannelAgentConfig = { ...(agentConfig ?? {}), elements: toElements(rows) };
    const { error } = await supabase
      .from("channels")
      .update({ agent_config: nextConfig, updated_at: new Date().toISOString() })
      .eq("channel_id", channelId);
    setState(error ? "error" : "saved");
  }

  const kindLabel: Record<Kind, string> = {
    character: t.cast.kindCharacter,
    location: t.cast.kindLocation,
    prop: t.cast.kindProp,
  };
  const inputClass =
    "pill border border-[var(--color-border)] bg-transparent px-3 py-2 text-[13px] outline-none transition-colors focus:border-[var(--color-primary)]";

  return (
    <div className="panel flex flex-col gap-4 p-4">
      <div>
        <h2 className="t-section">{t.cast.title}</h2>
        <p className="mt-1 max-w-[72ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
          {t.cast.hint}
        </p>
        <p className="mt-1 max-w-[72ch] text-[11px] leading-relaxed text-[var(--color-warn)]">
          {t.cast.syntheticNote}
        </p>
      </div>

      {disabled && <p className="text-[13px] text-[var(--color-warn)]">{t.cast.pickChannel}</p>}

      {!disabled && rows.length === 0 && (
        <p className="text-[13px] text-[var(--color-muted)]">{t.cast.empty}</p>
      )}

      {!disabled && rows.length > 0 && (
        <ul className="flex flex-col gap-3">
          {rows.map((r, i) => (
            <li
              key={i}
              className="flex flex-col gap-2 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3"
            >
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr]">
                <label className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-muted)]">
                    {t.cast.kindLabel}
                  </span>
                  <select
                    value={r.kind}
                    onChange={(e) => update(i, { kind: e.target.value as Kind })}
                    className={inputClass}
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {kindLabel[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-muted)]">
                    {t.cast.name}
                  </span>
                  <input
                    type="text"
                    value={r.name}
                    maxLength={MAX_NAME}
                    onChange={(e) => update(i, { name: e.target.value })}
                    className={inputClass}
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-muted)]">
                  {t.cast.desc}
                </span>
                <textarea
                  value={r.description}
                  maxLength={MAX_DESC}
                  onChange={(e) => update(i, { description: e.target.value })}
                  rows={2}
                  placeholder={t.cast.descPlaceholder}
                  className="rounded-[14px] border border-[var(--color-border)] bg-transparent px-3 py-2 text-[13px] leading-relaxed outline-none transition-colors focus:border-[var(--color-primary)]"
                />
              </label>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-muted)]">
                    {t.cast.aliases}
                  </span>
                  <input
                    type="text"
                    value={r.aliases}
                    onChange={(e) => update(i, { aliases: e.target.value })}
                    placeholder={t.cast.aliasesPlaceholder}
                    className={inputClass}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="btn-sky is-quiet pill px-3 py-2 text-[12px]"
                >
                  {t.cast.remove}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={addRow}
          disabled={disabled || rows.length >= MAX_ELEMENTS}
          className="btn-sky is-quiet pill px-4 py-2 text-[13px] disabled:opacity-40"
        >
          {t.cast.add}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={disabled || state === "saving"}
          className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
        >
          {state === "saving" ? t.cast.saving : t.cast.save}
        </button>
        <span className="mono text-[11px]" aria-live="polite">
          {state === "saved" ? (
            <span className="text-[var(--color-ok)]">{t.cast.saved}</span>
          ) : state === "error" ? (
            <span className="text-[var(--color-fail)]">{t.cast.failed}</span>
          ) : null}
        </span>
      </div>
    </div>
  );
}
