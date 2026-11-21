"use client";

import { useId, useState } from "react";
import { X } from "lucide-react";
import { fmt } from "@/lib/i18n";
import type { FilmStudioDictionary } from "@/lib/i18n/film-studio";
import { lengthText as lengthFor } from "@/components/films/lengthText";
import {
  FILM_ASPECTS,
  FILM_LANGUAGES,
  REF_KINDS,
  TARGET_SECONDS,
  type Film,
  type FilmAspect,
  type FilmLanguage,
  type FilmLimits,
  type Problem,
  type RefDraft,
  type RefKind,
  type SettingsDraft,
} from "@/lib/films";
import type { LibraryPicture } from "@/components/films/SceneDetail";

export interface LibraryCharacter {
  id: string;
  name: string;
}

/**
 * The project's own settings (title, target length, the video's language, format) and its film-wide references (characters, style
 * and location pictures, up to the database's limit). The source it was started from is shown, not edited here.
 */
export function ProjectPanel({
  t,
  film,
  settings,
  refs,
  limits,
  problems,
  readOnly,
  pictures,
  characters,
  onSettings,
  onRefs,
}: {
  t: FilmStudioDictionary;
  film: Film;
  settings: SettingsDraft;
  refs: readonly RefDraft[];
  limits: FilmLimits;
  problems: Problem[];
  readOnly: boolean;
  pictures: readonly LibraryPicture[];
  characters: readonly LibraryCharacter[];
  onSettings: (patch: Partial<SettingsDraft>, field: string) => void;
  onRefs: (next: RefDraft[]) => void;
}) {
  const id = useId();
  const has = (code: Problem["code"]) => problems.some((p) => p.code === code);
  // A saved target that is not one of the offered lengths (another client set it) stays selectable as itself.
  const lengths = [...new Set<number>([...TARGET_SECONDS, settings.targetSeconds])].sort((a, b) => a - b);

  return (
    <>
      <section className="fs-section" aria-labelledby={`${id}-h`}>
        <h2 id={`${id}-h`} className="fs-h2">
          {t.canvas.settings}
        </h2>
        <div className="fs-field" data-bad={has("title_required") || has("title_too_long") ? "true" : undefined}>
          <label htmlFor={`${id}-title`}>{t.create.titleLabel}</label>
          <input
            id={`${id}-title`}
            className="ns-field"
            value={settings.title}
            disabled={readOnly}
            onChange={(e) => onSettings({ title: e.target.value }, "title")}
            aria-invalid={has("title_required") || has("title_too_long") ? true : undefined}
          />
          {(has("title_required") || has("title_too_long")) && (
            <p className="fs-bad">{has("title_required") ? t.problems.title_required : fmt(t.problems.title_too_long, { n: limits.max_title_chars })}</p>
          )}
        </div>
        <div className="fs-fields">
          <div className="fs-field">
            <label htmlFor={`${id}-len`}>{t.create.lengthLabel}</label>
            <select
              id={`${id}-len`}
              className="ns-field"
              value={settings.targetSeconds}
              disabled={readOnly}
              onChange={(e) => onSettings({ targetSeconds: Number(e.target.value) }, "target")}
            >
              {lengths.map((s) => (
                <option key={s} value={s}>
                  {lengthFor(t, s)}
                </option>
              ))}
            </select>
          </div>
          <div className="fs-field">
            <label htmlFor={`${id}-lang`}>{t.create.languageLabel}</label>
            <select
              id={`${id}-lang`}
              className="ns-field"
              value={settings.language}
              disabled={readOnly}
              onChange={(e) => onSettings({ language: e.target.value as FilmLanguage }, "language")}
            >
              {FILM_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {t.languages[l]}
                </option>
              ))}
            </select>
          </div>
          <div className="fs-field">
            <label htmlFor={`${id}-aspect`}>{t.create.formatLabel}</label>
            <select
              id={`${id}-aspect`}
              className="ns-field"
              value={settings.aspect}
              disabled={readOnly}
              onChange={(e) => onSettings({ aspect: e.target.value as FilmAspect }, "aspect")}
            >
              {FILM_ASPECTS.map((a) => (
                <option key={a} value={a}>
                  {t.create.aspects[a]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {film.sourceText.trim() && (
          <details>
            <summary className="fs-small" style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center" }}>
              {film.sourceKind === "script" ? t.canvas.sourceScript : t.canvas.sourceTopic}
            </summary>
            <p className="fs-small" style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto" }}>
              {film.sourceText}
            </p>
          </details>
        )}
      </section>

      <RefsSection t={t} refs={refs} limits={limits} readOnly={readOnly} pictures={pictures} characters={characters} onRefs={onRefs} tooMany={has("too_many_refs")} />
    </>
  );
}

function RefsSection({
  t,
  refs,
  limits,
  readOnly,
  pictures,
  characters,
  onRefs,
  tooMany,
}: {
  t: FilmStudioDictionary;
  refs: readonly RefDraft[];
  limits: FilmLimits;
  readOnly: boolean;
  pictures: readonly LibraryPicture[];
  characters: readonly LibraryCharacter[];
  onRefs: (next: RefDraft[]) => void;
  tooMany: boolean;
}) {
  const id = useId();
  const [kind, setKind] = useState<RefKind>("character");
  const full = refs.length >= limits.max_film_refs;
  const used = new Set(refs.map((r) => r.characterId ?? r.assetId));
  const nameOf = (r: RefDraft, i: number) =>
    r.characterId
      ? characters.find((c) => c.id === r.characterId)?.name ?? t.refs.kinds.character
      : pictures.find((p) => p.id === r.assetId)?.name ?? fmt(t.refs.unnamedPicture, { n: i + 1 });
  const thumbOf = (r: RefDraft) => (r.assetId ? pictures.find((p) => p.id === r.assetId)?.thumbUrl ?? null : null);
  const add = (r: RefDraft) => onRefs([...refs, r]);

  return (
    <section className="fs-section" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="fs-h2">
        {t.refs.heading}
      </h2>
      <p className="fs-small">{fmt(t.refs.hint, { max: limits.max_film_refs })}</p>
      {refs.length === 0 ? (
        <p className="fs-small">{t.refs.none}</p>
      ) : (
        <ul className="fs-refs">
          {refs.map((r, i) => {
            const name = nameOf(r, i);
            const thumb = thumbOf(r);
            return (
              <li key={`${r.characterId ?? r.assetId}`} className="fs-ref" data-missing={r.missing ? "true" : undefined}>
                {thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="fs-ref-thumb" src={thumb} alt="" loading="lazy" />
                ) : (
                  <span className="fs-ref-thumb" aria-hidden="true" />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{name}</span>
                  <span className="fs-ref-kind">{r.missing ? t.refs.missing : t.refs.kinds[r.kind]}</span>
                </span>
                {!readOnly && (
                  <button type="button" className="fs-icon-key" aria-label={fmt(t.refs.remove, { name })} onClick={() => onRefs(refs.filter((_, j) => j !== i))}>
                    <X aria-hidden className="size-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {tooMany && <p className="fs-bad">{fmt(t.problems.too_many_refs, { n: limits.max_film_refs })}</p>}
      {!readOnly &&
        (full ? (
          <p className="fs-small">{fmt(t.refs.full, { max: limits.max_film_refs })}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="fs-field">
              <label htmlFor={`${id}-kind`}>{t.refs.add}</label>
              <select id={`${id}-kind`} className="ns-field" value={kind} onChange={(e) => setKind(e.target.value as RefKind)}>
                {REF_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t.refs.kinds[k]}
                  </option>
                ))}
              </select>
            </div>
            {kind === "character" ? (
              characters.length === 0 ? (
                <p className="fs-small">{t.refs.noCharacters}</p>
              ) : (
                <div className="fs-field">
                  <label htmlFor={`${id}-char`}>{t.refs.chooseCharacter}</label>
                  <select
                    id={`${id}-char`}
                    className="ns-field"
                    value=""
                    onChange={(e) => e.target.value && add({ kind: "character", characterId: e.target.value, assetId: null, missing: false })}
                  >
                    <option value="">{t.refs.chooseCharacter}</option>
                    {characters
                      .filter((c) => !used.has(c.id))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </div>
              )
            ) : pictures.length === 0 ? (
              <p className="fs-small">{t.refs.noPictures}</p>
            ) : (
              <>
                <span className="fs-small">{t.refs.choosePicture}</span>
                <ul className="fs-pics">
                  {pictures
                    .filter((p) => !used.has(p.id))
                    .map((p, i) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className="fs-pic"
                          aria-label={`${t.refs.addButton}: ${p.name ?? fmt(t.refs.unnamedPicture, { n: i + 1 })}`}
                          onClick={() => add({ kind, characterId: null, assetId: p.id, missing: false })}
                        >
                          {p.thumbUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={p.thumbUrl} alt="" loading="lazy" />
                          ) : (
                            <span aria-hidden="true">{i + 1}</span>
                          )}
                        </button>
                      </li>
                    ))}
                </ul>
              </>
            )}
          </div>
        ))}
    </section>
  );
}
