"use client";

import { useId, useState } from "react";
import { ChevronDown, Clapperboard } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { DIRECTOR_PRESETS, directorGroupsFor, directorText, type CreateKind, type DirectorGroup, type DirectorPicks } from "@/lib/customer/create";

/**
 * The Director: camera, motion, lighting and palette presets, collapsed and on Auto. Honest about what it is: prompt
 * guidance — "Add to prompt" appends the presets' words to the prompt (where the person sees and can edit them), and
 * nothing else changes. No setting, model or price is touched; the quote follows the new words as for any typing.
 */
export function Director({
  kind,
  onApply,
  note: panelNote = null,
}: {
  kind: CreateKind;
  onApply: (text: string) => void;
  /** What the composer said about the last words handed to it: added, or not (they would not fit). Null until then. */
  note?: string | null;
}) {
  const { t } = useI18n();
  const d = t.customerApp.create.director;
  const groups = directorGroupsFor(kind);
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [picks, setPicks] = useState<DirectorPicks>({});
  // Only this panel's own hint (pick a preset first); whether words went in is the composer's to say (panelNote).
  const [hint, setHint] = useState<string | null>(null);
  const note = hint ?? panelNote;
  const bodyId = useId();
  if (groups.length === 0) return null;

  const pick = (g: DirectorGroup, key: string) => {
    setHint(null);
    setPicks((p) => ({ ...p, [g]: p[g] === key ? undefined : key }));
  };
  const text = directorText(Object.fromEntries(groups.map((g) => [g, picks[g]])) as DirectorPicks);

  return (
    <section className="cs-director" data-open={open ? "true" : "false"} data-testid="director">
      <button type="button" className="cs-director-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <Clapperboard aria-hidden className="size-4" strokeWidth={2} />
        <span className="flex-1 text-left font-medium">{d.title}</span>
        <span className="cs-director-mode">{manual ? d.manual : d.auto}</span>
        <ChevronDown aria-hidden className="cs-director-chev size-4" />
      </button>
      {open && (
        <div id={bodyId} className="cs-director-body">
          <div role="radiogroup" aria-label={d.modeLabel} className="cs-seg">
            {[false, true].map((m) => (
              <button
                key={String(m)}
                type="button"
                role="radio"
                id={`${bodyId}-${m ? "manual" : "auto"}`}
                aria-checked={manual === m}
                tabIndex={manual === m ? 0 : -1}
                onClick={() => setManual(m)}
                onKeyDown={(e) => {
                  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
                  e.preventDefault();
                  const next = e.key === "Home" ? false : e.key === "End" ? true : !manual;
                  setManual(next);
                  document.getElementById(`${bodyId}-${next ? "manual" : "auto"}`)?.focus();
                }}
                className="cs-seg-btn"
              >
                {m ? d.manual : d.auto}
              </button>
            ))}
          </div>
          <p className="m-0 text-xs text-[var(--color-muted)]">{manual ? d.honest : d.autoHint}</p>
          {manual && (
            <>
              {groups.map((g) => (
                <fieldset key={g} className="cs-director-group">
                  <legend className="text-xs font-medium text-[var(--color-muted)]">{d.groups[g]}</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.keys(DIRECTOR_PRESETS[g]).map((key) => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={picks[g] === key}
                        onClick={() => pick(g, key)}
                        className="cs-chip"
                      >
                        {(d.presets[g] as Record<string, string>)[key] ?? key}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ))}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="btn-sky is-quiet pill h-10 px-3.5 text-sm"
                  onClick={() => {
                    if (!text) return setHint(d.none);
                    setHint(null);
                    onApply(text);
                  }}
                >
                  {d.apply}
                </button>
                <span role="status" className="text-xs text-[var(--color-muted)]">
                  {note}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
