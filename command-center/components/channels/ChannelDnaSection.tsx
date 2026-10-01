"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dna } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { VOICES } from "@/lib/ttsModels";
import {
  DNA_ASPECTS,
  DNA_FORMATS,
  DNA_LANGUAGES,
  DNA_LIMITS,
  dnaAnchor,
  dnaAspect,
  isDnaError,
  knownVoice,
  languageLabel,
  type ChannelDna,
  type DnaAspect,
  type DnaError,
  type DnaFormat,
  type DnaLanguage,
} from "@/lib/channel-dna";

/** A kit or a character as the pickers need it. */
export interface DnaChoice {
  id: string;
  name: string;
}

/**
 * One channel's DNA: its look and voice in one place (migration 0056).
 *
 * It shows what new work on the channel starts from, and — for someone who
 * may edit the channel — lets them change it. Saving calls POST
 * /api/channels/dna, which is set_channel_dna under their own session; the
 * database checks the kit and characters are this organization's. Nothing
 * here generates, prices or publishes: the Studio panel and the Run now form
 * only start from these values.
 */
export function ChannelDnaSection({
  channelId,
  dna,
  kits,
  characters,
  styleState,
  available,
  failed = false,
  canEdit,
  standardVoice,
  studioHref,
}: {
  channelId: string;
  dna: ChannelDna;
  kits: DnaChoice[];
  characters: DnaChoice[];
  /** The organization's kits and characters (0047): read, not applied here, or failed. */
  styleState: "ready" | "unavailable" | "failed";
  /** 0056 is applied (set_channel_dna exists, its character rows are readable). */
  available: boolean;
  /** Its character rows could not be read: shown as unknown, and not editable
   *  (a save replaces the characters, and it must not replace them with "none"). */
  failed?: boolean;
  /** May edit this channel (presentation only: the database decides). */
  canEdit: boolean;
  /** The channel's runs read with the standard voice, not the picked narrator voice. */
  standardVoice: boolean;
  studioHref: string;
}) {
  const { t, fmt } = useI18n();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" } | { kind: "error"; code: DnaError }>({ kind: "idle" });

  const [kit, setKit] = useState<string | null>(dna.styleKitId);
  const [chars, setChars] = useState<string[]>(dna.characterIds);
  // "" keeps the voice as it is (a custom id the list cannot show, or none).
  const [voice, setVoice] = useState<string>(knownVoice(dna.voiceId)?.id ?? "");
  const [language, setLanguage] = useState<DnaLanguage | null>(dna.language);
  const [format, setFormat] = useState<DnaFormat | null>(dna.format);
  const [aspect, setAspect] = useState<DnaAspect | null>(dna.aspect);
  const [tone, setTone] = useState(dna.tone);

  const kitName = (id: string | null) => (id ? (kits.find((k) => k.id === id)?.name ?? t.dna.unavailableItem) : t.dna.none);
  const charName = (id: string) => {
    const c = characters.find((x) => x.id === id);
    return c ? `@${c.name}` : t.dna.unavailableItem;
  };
  const voiceName = knownVoice(dna.voiceId)?.name ?? (dna.voiceId ? t.dna.customVoice : t.dna.notSet);
  const languageText = dna.language ? languageLabel(dna.language) : dna.languageRaw || t.dna.notSet;
  const shownAspect = dnaAspect(dna);
  const styleReady = styleState === "ready";

  function reset() {
    setKit(dna.styleKitId);
    setChars(dna.characterIds);
    setVoice(knownVoice(dna.voiceId)?.id ?? "");
    setLanguage(dna.language);
    setFormat(dna.format);
    setAspect(dna.aspect);
    setTone(dna.tone);
  }

  async function save() {
    if (state.kind === "saving") return;
    setState({ kind: "saving" });
    try {
      const res = await fetch("/api/channels/dna", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel_id: channelId,
          // Kits and characters not loaded (failed read): keep what is stored.
          style_kit_id: styleReady ? kit : dna.styleKitId,
          character_ids: styleReady ? chars : dna.characterIds,
          voice_id: voice || null,
          language,
          format,
          aspect,
          tone,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        setState({ kind: "error", code: isDnaError(body.error) ? body.error : "failed" });
        return;
      }
      setState({ kind: "saved" });
      setEditing(false);
      startTransition(() => router.refresh());
    } catch {
      setState({ kind: "error", code: "failed" });
    }
  }

  const toggleChar = (id: string) => {
    setChars((cur) => (cur.includes(id) ? cur.filter((c) => c !== id) : cur.length >= DNA_LIMITS.maxCharacters ? cur : [...cur, id]));
  };

  const legend = "text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]";
  const status =
    state.kind === "saved" ? (
      <span className="text-[var(--color-ok)]">{t.dna.saved}</span>
    ) : state.kind === "error" ? (
      <span className="text-[var(--color-fail)]">{t.dna.errors[state.code]}</span>
    ) : null;

  return (
    <section
      id={dnaAnchor(channelId)}
      aria-labelledby={`${uid}-title`}
      className="scroll-mt-24 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${uid}-title`} className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
          <Dna aria-hidden className="size-3.5 text-[var(--color-primary)]" />
          {t.dna.title}
        </h3>
        {available && !failed && canEdit && !editing && (
          <button
            type="button"
            onClick={() => {
              reset();
              setState({ kind: "idle" });
              setEditing(true);
            }}
            className="btn-sky ghost pill min-h-[36px] px-4 py-1.5 text-[12px]"
          >
            {t.dna.edit}
          </button>
        )}
      </div>
      <p className="mt-1 max-w-[72ch] text-[11px] leading-relaxed text-[var(--color-muted)]">{t.dna.hint}</p>

      {!available ? (
        <p className="mt-2 text-[12px] text-[var(--color-muted)]">{t.dna.notEnabled}</p>
      ) : failed ? (
        <p className="mt-2 text-[12px] text-[var(--color-warn)]">{t.dna.readFailed}</p>
      ) : !editing ? (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <Field label={t.dna.style} value={kitName(dna.styleKitId)} />
            <Field
              label={t.dna.characters}
              value={dna.characterIds.length ? dna.characterIds.map(charName).join(" ") : t.dna.none}
            />
            <Field label={t.dna.voice} value={voiceName} />
            <Field label={t.dna.language} value={languageText} />
            <Field label={t.dna.format} value={dna.format ? t.dna.formats[dna.format] : t.dna.notSet} />
            <Field label={t.dna.aspect} value={shownAspect ?? t.dna.notSet} mono={Boolean(shownAspect)} />
            <div className="col-span-2 min-w-0 sm:col-span-3">
              <dt className={legend}>{t.dna.tone}</dt>
              <dd className="text-[12px] text-[var(--color-fg)] [overflow-wrap:anywhere]">{dna.tone || t.dna.notSet}</dd>
            </div>
          </dl>
          {!canEdit && <p className="mt-2 text-[11px] text-[var(--color-muted)]">{t.dna.readOnly}</p>}
          {status && (
            <p className="mt-2 text-[12px]" role="status">
              {status}
            </p>
          )}
        </>
      ) : (
        <form
          className="mt-3 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {styleState === "failed" && <p className="text-[12px] text-[var(--color-warn)]">{t.dna.readFailed}</p>}

          {styleReady && (
            <fieldset className="flex flex-col gap-2">
              <legend className={legend}>{t.dna.style}</legend>
              <div className="flex flex-wrap gap-2">
                <button type="button" aria-pressed={kit === null} onClick={() => setKit(null)} className="studio-chip">
                  {t.dna.none}
                </button>
                {kits.map((k) => (
                  <button key={k.id} type="button" aria-pressed={kit === k.id} onClick={() => setKit(k.id)} className="studio-chip">
                    <span className="truncate">{k.name}</span>
                  </button>
                ))}
              </div>
              {kits.length === 0 && <EmptyHint text={t.dna.noKits} link={t.dna.makeInStudio} href={studioHref} />}
            </fieldset>
          )}

          {styleReady && (
            <fieldset className="flex flex-col gap-2">
              <legend className={legend}>
                {t.dna.characters} · {fmt(t.dna.charactersMax, { n: DNA_LIMITS.maxCharacters })}
              </legend>
              <div className="flex flex-wrap gap-2">
                {characters.map((c) => {
                  const on = chars.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      disabled={!on && chars.length >= DNA_LIMITS.maxCharacters}
                      onClick={() => toggleChar(c.id)}
                      className="studio-chip disabled:opacity-50"
                    >
                      <span className="truncate">@{c.name}</span>
                    </button>
                  );
                })}
              </div>
              {characters.length === 0 && <EmptyHint text={t.dna.noCharacters} link={t.dna.makeInStudio} href={studioHref} />}
            </fieldset>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${uid}-voice`} className={legend}>
              {t.dna.voice}
            </label>
            <select
              id={`${uid}-voice`}
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              className="studio-field w-full px-3 py-2.5 text-[16px] text-[var(--color-fg)] outline-none sm:text-[13px]"
              aria-describedby={standardVoice ? `${uid}-voice-note` : undefined}
            >
              <option value="">{dna.voiceId ? t.dna.keepVoice : t.dna.notSet}</option>
              {VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {v.style}
                </option>
              ))}
            </select>
            {standardVoice && (
              <span id={`${uid}-voice-note`} className="text-[11px] leading-relaxed text-[var(--color-muted)]">
                {t.dna.standardVoiceNote}
              </span>
            )}
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className={legend}>{t.dna.language}</legend>
            <div className="flex flex-wrap gap-2">
              {!dna.language && dna.languageRaw && (
                <button type="button" aria-pressed={language === null} onClick={() => setLanguage(null)} className="studio-chip">
                  {fmt(t.dna.keepLanguage, { value: dna.languageRaw })}
                </button>
              )}
              {DNA_LANGUAGES.map((l) => (
                <button key={l} type="button" lang={l} aria-pressed={language === l} onClick={() => setLanguage(l)} className="studio-chip">
                  {languageLabel(l)}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className={legend}>{t.dna.format}</legend>
            <div className="flex flex-wrap gap-2">
              <button type="button" aria-pressed={format === null} onClick={() => setFormat(null)} className="studio-chip">
                {t.dna.notSet}
              </button>
              {DNA_FORMATS.map((f) => (
                <button key={f} type="button" aria-pressed={format === f} onClick={() => setFormat(f)} className="studio-chip">
                  {t.dna.formats[f]}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className={legend}>{t.dna.aspect}</legend>
            <div className="flex flex-wrap gap-2">
              <button type="button" aria-pressed={aspect === null} onClick={() => setAspect(null)} className="studio-chip">
                {t.dna.aspectFromFormat}
              </button>
              {DNA_ASPECTS.map((a) => (
                <button key={a} type="button" aria-pressed={aspect === a} onClick={() => setAspect(a)} className="studio-chip mono">
                  {a}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${uid}-tone`} className={legend}>
              {t.dna.tone}
            </label>
            <input
              id={`${uid}-tone`}
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              maxLength={DNA_LIMITS.toneMax}
              placeholder={t.dna.tonePlaceholder}
              aria-describedby={`${uid}-tone-hint`}
              className="studio-field w-full px-3 py-2.5 text-[16px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)] sm:text-[13px]"
            />
            <span id={`${uid}-tone-hint`} className="text-[11px] text-[var(--color-muted)]">
              {t.dna.toneHint}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={state.kind === "saving"}
              aria-busy={state.kind === "saving"}
              className="btn-sky pill min-h-[40px] px-5 py-2 text-[13px] disabled:opacity-50"
            >
              {state.kind === "saving" ? t.dna.saving : t.dna.save}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setState({ kind: "idle" });
              }}
              className="btn-sky is-quiet pill min-h-[40px] px-4 py-2 text-[13px]"
            >
              {t.dna.cancel}
            </button>
          </div>
          <p className="min-h-[18px] text-[12px]" role="status" aria-live="polite">
            {status}
          </p>
        </form>
      )}
    </section>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">{label}</dt>
      <dd className={`truncate text-[12px] text-[var(--color-fg)]${mono ? " mono" : ""}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

function EmptyHint({ text, link, href }: { text: string; link: string; href: string }) {
  return (
    <span className="text-[12px] text-[var(--color-muted)]">
      {text}{" "}
      <Link href={href} className="tap-link text-[var(--color-primary)] underline">
        {link}
      </Link>
    </span>
  );
}
