"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Loader2, Lock, RotateCw, Search, TriangleAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { VoicePreviewButton } from "@/components/create/VoicePreviewButton";
import { VOICE_ID_RE } from "@/lib/creative/operations";
import { voiceRetirement } from "@/lib/voiceRetirement";
import {
  VOICE_FACETS,
  facetValues,
  filterVoices,
  isFiltered,
  sortVoices,
  traitText,
  type CatalogVoice,
  type VoiceFacet,
  type VoiceFilter,
} from "@/lib/creative/voiceCatalog";
import type { VoiceTraits } from "@/lib/elevenlabsVoices";

/**
 * Speech's voice, picked by character from the platform ElevenLabs account's own list (GET /api/creative/voices).
 *
 * A person picks a voice; nobody types one. The only text box here searches names and descriptions, and what is
 * typed into it never becomes `voice_id` (CLAUDE.md ceiling: a typed number is not a voice id).
 *
 * Until the account's list is in hand (loading, not connected on this server, ElevenLabs unreachable, an error, an
 * empty account) the panel's own list of ElevenLabs premade voices (`builtIn`) is shown under the reason, so a
 * person can still choose — and is told that this is the standard list, not the account's. Nothing is picked on
 * the person's behalf in any state.
 *
 * The account's plan decides the library voices: on ElevenLabs' free plan they are shown, marked "needs a paid plan",
 * and cannot be picked (the API refuses them with 402 paid_plan_required); when the plan could not be read they stay
 * pickable, marked "may need a paid plan" (rule 5: unknown is neither yes nor no). Premade voices are always pickable.
 */

type Failure = "not_configured" | "unreachable" | "key_rejected" | "rate_limited" | "signed_out" | "no_workspace" | "failed";
/** The account's plan as the server read it (lib/elevenlabsVoices.ts readAccountPlan); anything else is "unknown". */
type Plan = "free" | "paid" | "unknown";
type State =
  | { kind: "loading" }
  | { kind: "failed"; why: Failure }
  | { kind: "ok"; voices: CatalogVoice[]; truncated: boolean; plan: Plan };

const PAGE = 40;
const FAILURE_COPY = {
  not_configured: "notConfigured",
  unreachable: "unreachable",
  key_rejected: "keyRejected",
  rate_limited: "rateLimited",
  signed_out: "signedOut",
  no_workspace: "noWorkspace",
  failed: "failed",
} as const satisfies Record<Failure, string>;
const RETRYABLE: readonly Failure[] = ["unreachable", "rate_limited", "failed"];

function failureOf(status: number, error: unknown): Failure {
  if (status === 401) return "signed_out";
  if (status === 403 && error === "org_required") return "no_workspace";
  if (status === 429) return "rate_limited";
  if (error === "voices_not_configured") return "not_configured";
  if (error === "elevenlabs_unreachable") return "unreachable";
  if (error === "elevenlabs_key_rejected") return "key_rejected";
  return "failed";
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** Only what the picker can show honestly: a voice with a real id and a name; a trait that is not text is dropped. */
function coerceVoices(raw: unknown): CatalogVoice[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CatalogVoice[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const v = r as Record<string, unknown>;
    const voiceId = str(v.voiceId);
    const name = str(v.name);
    if (!voiceId || !VOICE_ID_RE.test(voiceId) || !name) continue;
    const tr = v.traits && typeof v.traits === "object" ? (v.traits as Record<string, unknown>) : {};
    const traits: VoiceTraits = {};
    for (const k of ["gender", "age", "accent", "useCase", "description"] as const) {
      const value = str(tr[k]);
      if (value) traits[k] = value;
    }
    const preview = str(v.previewUrl);
    out.push({
      voiceId,
      name,
      category: str(v.category) ?? "",
      previewUrl: preview && preview.startsWith("https://") ? preview : "",
      labels: "",
      traits,
      library: v.library === true,
    });
  }
  return out;
}

export function VoiceCatalog({
  value,
  onPick,
  label,
  builtIn,
}: {
  value: string | null;
  onPick: (id: string) => void;
  label: string;
  builtIn: ReactNode;
}) {
  const { t, fmt } = useI18n();
  const c = t.voiceCatalog;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<VoiceFilter>({});
  const [limit, setLimit] = useState(PAGE);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    (async () => {
      try {
        const res = await fetch("/api/creative/voices", { cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { voices?: unknown; truncated?: unknown; plan?: unknown; error?: unknown };
        if (!live) return;
        const voices = res.ok ? coerceVoices(body.voices) : null;
        if (!voices) return setState({ kind: "failed", why: failureOf(res.status, body.error) });
        const plan: Plan = body.plan === "free" || body.plan === "paid" ? body.plan : "unknown";
        setState({ kind: "ok", voices: sortVoices(voices), truncated: body.truncated === true, plan });
      } catch {
        if (live) setState({ kind: "failed", why: "failed" });
      }
    })();
    return () => {
      live = false;
    };
  }, [attempt]);

  const voices = state.kind === "ok" ? state.voices : null;
  const facets = useMemo(() => (voices ? facetValues(voices) : null), [voices]);
  const matching = useMemo(() => (voices ? filterVoices(voices, filter) : []), [voices, filter]);
  const shown = matching.slice(0, limit);

  const setFacet = (f: VoiceFacet | "query", v: string) => {
    setFilter((cur) => ({ ...cur, [f]: v }));
    setLimit(PAGE);
  };

  const retry = (
    <button type="button" onClick={() => setAttempt((n) => n + 1)} className="studio-chip inline-flex items-center gap-1.5">
      <RotateCw aria-hidden className="size-3.5" />
      {c.retry}
    </button>
  );

  // Not (yet) the account's list: the reason, then the standard voices to choose from.
  if (state.kind !== "ok" || state.voices.length === 0) {
    const message = state.kind === "loading" ? c.loading : state.kind === "failed" ? c[FAILURE_COPY[state.why]] : c.empty;
    return (
      <div className="flex flex-col gap-2" data-testid="voice-catalog" data-state={state.kind === "ok" ? "empty" : state.kind === "failed" ? state.why : "loading"}>
        <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
          {state.kind === "loading" ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <TriangleAlert aria-hidden className="size-3.5" />
          )}
          <span>{message}</span>
          {state.kind === "failed" && RETRYABLE.includes(state.why) && retry}
        </div>
        {state.kind !== "loading" && (
          <p className="text-xs text-[var(--color-muted)]">
            <span className="font-semibold text-[var(--color-fg)]">{c.builtInTitle}.</span> {c.builtInNote}
          </p>
        )}
        {builtIn}
      </div>
    );
  }

  const all = state.voices;
  const pickedMissing = Boolean(value) && !state.truncated && !all.some((v) => v.voiceId === value);
  // On the free plan ElevenLabs refuses a library voice through the API (402 paid_plan_required): it is shown, so the
  // person sees why it is missing, but it cannot be picked. An unknown plan blocks nothing and says it does not know.
  const now = new Date();
  // A retired ElevenLabs Default voice is shown but not pickable: the TTS adapter refuses it (modules/voice_retirement).
  const needsPaid = (v: CatalogVoice) => v.library && state.plan === "free";
  const blocked = (v: CatalogVoice) => needsPaid(v) || voiceRetirement(v.voiceId, now) === "retired";
  // Each refusal says its own remedy: "needs a paid plan" for a retired voice would send the person to buy the wrong thing.
  const pickedBlocked = all.some((v) => v.voiceId === value && needsPaid(v));
  const pickedRetired = all.find((v) => v.voiceId === value && voiceRetirement(v.voiceId, now) === "retired");
  const pickedShown = shown.some((v) => v.voiceId === value && !blocked(v));
  const firstOpen = shown.findIndex((v) => !blocked(v));

  function onRowKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const n = shown.length;
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    let to = -1;
    if (step) {
      for (let k = 1; k <= n; k++) {
        const j = (i + step * k + n * k) % n;
        if (!blocked(shown[j])) {
          to = j;
          break;
        }
      }
    } else if (e.key === "Home") to = firstOpen;
    else if (e.key === "End") to = n - 1 - [...shown].reverse().findIndex((v) => !blocked(v));
    if (to < 0 || to >= n || blocked(shown[to])) return;
    e.preventDefault();
    onPick(shown[to].voiceId);
    rowRefs.current[to]?.focus();
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="voice-catalog" data-state="ok">
      <span className="studio-label" id="gen-voice-catalog-label">
        {label}
      </span>

      <div className="flex min-w-0 flex-col gap-2">
        <label className="studio-field flex items-center gap-2 px-3 py-2">
          <Search aria-hidden className="size-3.5 shrink-0 text-[var(--color-muted)]" />
          <span className="sr-only">{c.search}</span>
          <input
            type="search"
            value={filter.query ?? ""}
            onChange={(e) => setFacet("query", e.target.value)}
            placeholder={c.searchPh}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-base text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)] sm:text-[14px]"
          />
        </label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {VOICE_FACETS.filter((f) => (facets?.[f].length ?? 0) > 0).map((f) => (
            <label key={f} className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-muted)]">
              {c.facets[f]}
              <select
                value={filter[f] ?? ""}
                onChange={(e) => setFacet(f, e.target.value)}
                className="studio-field w-full min-w-0 px-2 py-2 text-sm text-[var(--color-fg)] outline-none"
              >
                <option value="">{c.facetAny}</option>
                {facets![f].map((v) => (
                  <option key={v} value={v}>
                    {traitText(v)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>

      {state.truncated && <p className="text-xs text-[var(--color-muted)]">{c.truncated}</p>}
      {state.plan === "free" && <p className="text-xs text-[var(--color-muted)]">{c.planFree}</p>}
      {state.plan === "unknown" && <p className="text-xs text-[var(--color-muted)]">{c.planUnknown}</p>}
      {pickedBlocked && (
        <p role="alert" className="text-xs text-[var(--color-danger,#dc2626)]">
          {c.pickedNeedsPaid}
        </p>
      )}
      {pickedRetired && (
        <p role="alert" className="text-xs text-[var(--color-danger,#dc2626)]">
          {fmt(t.create.flow.voiceRetired, { name: pickedRetired.name })}
        </p>
      )}
      {pickedMissing && (
        <p role="alert" className="text-xs text-[var(--color-danger,#dc2626)]">
          {c.pickedMissing}
        </p>
      )}

      {matching.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
          <span>{c.noMatch}</span>
          {isFiltered(filter) && (
            <button type="button" className="studio-chip" onClick={() => (setFilter({}), setLimit(PAGE))}>
              {c.clearFilters}
            </button>
          )}
        </div>
      ) : (
        <div
          role="radiogroup"
          aria-labelledby="gen-voice-catalog-label"
          className="flex max-h-[26rem] flex-col gap-1 overflow-y-auto"
          data-testid="voice-catalog-list"
        >
          {shown.map((v, i) => {
            const off = blocked(v);
            const on = v.voiceId === value && !off;
            const stop = on || (!pickedShown && i === firstOpen);
            const traits = VOICE_FACETS.map((f) => v.traits[f as keyof VoiceTraits]).filter((x): x is string => Boolean(x));
            const category = (c.categories as Record<string, string>)[v.category] ?? (v.category ? traitText(v.category) : "");
            return (
              <div key={v.voiceId} data-checked={on} data-blocked={off || undefined} className={`desk-cast-row flex flex-wrap items-center gap-2${off ? " opacity-60" : ""}`}>
                <button
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={off}
                  tabIndex={stop ? 0 : -1}
                  onClick={() => !off && onPick(v.voiceId)}
                  onKeyDown={(e) => onRowKey(e, i)}
                  className="flex min-w-0 flex-1 items-start gap-2 text-left"
                >
                  <span aria-hidden className="ns-lamp mt-1.5" data-tone={on ? "run" : "off"} />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex flex-wrap items-center gap-x-2 font-semibold text-[var(--color-fg)]">
                      <span className="truncate">{v.name}</span>
                      {category && <span className="text-[11px] font-normal text-[var(--color-muted)]">{category}</span>}
                      {voiceRetirement(v.voiceId, now) === "leaving" && (
                        <span className="text-[11px] font-normal text-[var(--color-warn,#b45309)]">{t.create.flow.voiceLeavingTag}</span>
                      )}
                    </span>
                    {traits.length > 0 && (
                      <span className="truncate text-xs text-[var(--color-muted)]">{traits.map(traitText).join(" · ")}</span>
                    )}
                    {v.traits.description && (
                      <span className="line-clamp-2 text-xs text-[var(--color-muted)]">{v.traits.description}</span>
                    )}
                    {v.library && (
                      <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-[var(--color-warn,#b45309)]">
                        <TriangleAlert aria-hidden className="size-3" />
                        {c.library}
                      </span>
                    )}
                    {v.library && state.plan !== "paid" && (
                      <span className="inline-flex items-center gap-1 text-xs text-[var(--color-warn,#b45309)]">
                        <Lock aria-hidden className="size-3" />
                        {state.plan === "free" ? c.libraryNeedsPaid : c.libraryMayNeedPaid}
                      </span>
                    )}
                  </span>
                </button>
                <div className="shrink-0">
                  {v.previewUrl ? (
                    <VoicePreviewButton voiceId={v.voiceId} channelId={null} previewUrl={v.previewUrl} name={v.name} />
                  ) : (
                    <span className="text-xs text-[var(--color-muted)]">{c.noPreview}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {matching.length > shown.length && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
          <span>{c.showing.replace("{shown}", String(shown.length)).replace("{total}", String(matching.length))}</span>
          <button type="button" className="studio-chip" onClick={() => setLimit((n) => n + PAGE)}>
            {c.showMore}
          </button>
        </div>
      )}
    </div>
  );
}
