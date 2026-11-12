"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { characterStudioStrings, type CharacterStudioDictionary } from "@/lib/i18n/character-studio";
import { TemplateCard } from "@/components/character-studio/TemplateCard";
import {
  DECLARATIONS,
  MODEL_FACTS,
  MODEL_IDS,
  PROMPT_MAX,
  RESOLUTIONS,
  namedPictures,
  namesACharacter,
  type Declaration,
  type ModelId,
  type ModelQuote,
  type Resolution,
  type StudioState,
  type SwapError,
  type SwapJob,
  type SwapQuote,
} from "@/lib/characterStudio/model";

/**
 * Character Studio ("Qahramon studiyasi", docs/CHARACTER_STUDIO.md; migration 0135). Drawn only with NIGHTSHIFT_CHARACTER_STUDIO on: the
 * page decides on the server, and `enabled` is passed down so the component draws nothing if it is ever mounted with the switch off.
 *
 * Layout, the owner's: the COST of the chosen model for the person's clip at the top, the MODEL picker below it; switching the model
 * changes the cost at once (one quote holds every model's price). Then the inputs, the consent and the button.
 *
 * What a button here does: it writes a row through /api/character-studio/* and stops (CLAUDE.md rule 3). The worker calls the vendor.
 * Every number shown is the database's quote for this clip on this model; a model without one reads "not on sale yet". The swap is
 * requested with the shown charge as its ceiling: a different charge is refused by the database and said in words, never charged.
 */

type Failure = { error: SwapError; charge?: number; hold?: number };
type Result<T> = { ok: true; data: T } | ({ ok: false } & Failure);

async function call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !json) {
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      return { ok: false, error: typeof json?.error === "string" ? (json.error as SwapError) : "failed", charge: num(json?.charge), hold: num(json?.hold) };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/** A refusal in the reader's language, with a number only when the database gave one (rule 5). */
export function swapErrorText(t: CharacterStudioDictionary, f: Failure): string {
  if (f.error === "price_changed" && typeof f.charge === "number") return fmt(t.errors.price_changed, { charge: f.charge });
  if (f.error === "swap_hold_unavailable" && typeof f.hold === "number") return fmt(t.errors.swap_hold_unavailable, { hold: f.hold });
  if (f.error === "price_changed" || f.error === "swap_hold_unavailable") return t.errors.failed;
  return (t.errors as Record<string, string>)[f.error] ?? t.errors.failed;
}

/** The cost line of one model for this clip: the database's numbers or the reason there is none. */
export function costText(t: CharacterStudioDictionary, q: ModelQuote | undefined, exempt: boolean): { main: string; detail: string | null; sellable: boolean } {
  if (!q) return { main: t.cost.failed, detail: null, sellable: false };
  const name = MODEL_FACTS[q.model].name;
  if (q.problem) return { main: (t.errors as Record<string, string>)[q.problem] ?? t.errors.failed, detail: null, sellable: false };
  if (!q.onSale || q.credits === null || q.hold === null) return { main: fmt(t.cost.notOnSale, { model: name }), detail: null, sellable: false };
  if (exempt) return { main: t.cost.exempt, detail: null, sellable: true };
  if (q.credits === 0) return { main: t.cost.free, detail: null, sellable: true };
  const detail = q.hold > q.credits ? fmt(t.cost.hold, { hold: q.hold, credits: q.credits }) : fmt(t.cost.holdSame, { credits: q.credits });
  return { main: fmt(t.cost.credits, { credits: q.credits }), detail, sellable: true };
}

function newPressKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `cs-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A library thumbnail (a signed same-origin link the server made), or a plain placeholder. */
function Thumb({ url }: { url: string | null }) {
  if (!url) {
    return (
      <span className="cs-thumb">
        <ImageOff aria-hidden="true" size={18} />
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="cs-thumb" src={url} alt="" loading="lazy" />;
}

const NO_DECLARATIONS = Object.fromEntries(DECLARATIONS.map((k) => [k, false])) as Record<Declaration, boolean>;

export function CharacterStudio({
  enabled,
  orgId,
  canEdit,
  initial,
  libraryHref,
}: {
  enabled: boolean;
  orgId: string;
  canEdit: boolean;
  initial: StudioState;
  libraryHref: string;
}) {
  const { locale } = useI18n();
  const t = characterStudioStrings(locale);
  const ids = useId();
  const [state, setState] = useState<StudioState>(initial);
  const [open, setOpen] = useState(false);
  const [video, setVideo] = useState<string | null>(null);
  const [refs, setRefs] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<ModelId>(MODEL_IDS[0]);
  const [resolution, setResolution] = useState<Resolution>("720p");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoting, setQuoting] = useState<"idle" | "loading" | "error">("idle");
  const [declared, setDeclared] = useState<Record<Declaration, boolean>>(NO_DECLARATIONS);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const press = useRef<string | null>(null);
  const studioRef = useRef<HTMLDivElement | null>(null);

  // A press key belongs to one set of inputs: change anything and the next press is a new request, not a replay of the old one.
  useEffect(() => {
    press.current = null;
    setFailure(null);
  }, [video, refs, prompt, model, resolution]);

  useEffect(() => {
    if (!video) {
      setQuote(null);
      setQuoting("idle");
      return;
    }
    let live = true;
    setQuoting("loading");
    const q = new URLSearchParams({ org: orgId, input: video, resolution });
    void call<{ quote: SwapQuote }>("GET", `/api/character-studio/quote?${q.toString()}`).then((r) => {
      if (!live) return;
      if (r.ok) {
        setQuote(r.data.quote);
        setQuoting("idle");
      } else {
        setQuote(null);
        setQuoting("error");
      }
    });
    return () => {
      live = false;
    };
  }, [orgId, video, resolution]);

  const refresh = useCallback(async () => {
    const r = await call<StudioState>("GET", `/api/character-studio?org=${encodeURIComponent(orgId)}`);
    if (r.ok) setState(r.data);
  }, [orgId]);

  const chosen = quote?.models.find((m) => m.model === model);
  const cost = video && quote ? costText(t, chosen, quote.exempt) : null;
  const named = useMemo(() => namedPictures(prompt), [prompt]);
  const facts = MODEL_FACTS[model];
  const allDeclared = DECLARATIONS.every((k) => declared[k]);
  const ready =
    canEdit &&
    !busy &&
    Boolean(video) &&
    refs.length >= 1 &&
    refs.length <= facts.maxPictures &&
    namesACharacter(prompt) &&
    named.every((n) => n >= 1 && n <= refs.length) &&
    allDeclared &&
    Boolean(cost?.sellable) &&
    chosen?.credits !== null &&
    chosen?.credits !== undefined;

  if (!enabled) return null;

  function tryTemplate(text: string) {
    setPrompt(text.slice(0, PROMPT_MAX));
    setOpen(true);
    requestAnimationFrame(() => studioRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
  }

  function togglePicture(id: string) {
    setRefs((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= facts.maxPictures ? cur : [...cur, id]));
  }

  async function start() {
    if (!ready || !video || chosen?.credits === null || chosen?.credits === undefined) return;
    setBusy(true);
    setFailure(null);
    const consent = await call<{ consent_id: string }>("POST", "/api/character-studio/consent", {
      org_id: orgId,
      model,
      input: video,
      references: refs,
      declarations: Object.fromEntries(DECLARATIONS.map((k) => [k, true])),
    });
    if (!consent.ok) {
      setFailure(consent);
      setBusy(false);
      return;
    }
    press.current = press.current ?? newPressKey();
    const out = await call<{ id: string }>("POST", "/api/character-studio/swaps", {
      org_id: orgId,
      input: video,
      references: refs,
      prompt,
      model,
      resolution,
      consent_id: consent.data.consent_id,
      max_credits: chosen.credits,
      idem: press.current,
    });
    setBusy(false);
    if (!out.ok) {
      setFailure(out);
      return;
    }
    setDeclared(NO_DECLARATIONS);
    press.current = null;
    await refresh();
  }

  async function cancel(job: SwapJob) {
    setBusy(true);
    const r = await call<{ status: string }>("POST", `/api/character-studio/swaps/${job.id}/cancel`, {});
    setBusy(false);
    if (!r.ok) setFailure(r);
    await refresh();
  }

  if (!initial.available) return <p className="cs-note">{t.notAvailable}</p>;

  return (
    <div className="cs" aria-busy={busy}>
      {state.error ? (
        <div className="cs-note" role="alert">
          <p className="cs-fail">{t.loadFailed}</p>
          <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={() => void refresh()}>
            {t.retry}
          </button>
        </div>
      ) : null}

      <section className="cs-section" aria-labelledby={`${ids}-gallery`}>
        <h2 id={`${ids}-gallery`} className="cs-h2">
          {t.gallery.heading}
        </h2>
        <ul className="cs-cards">
          {state.templates.map((tpl) => (
            <TemplateCard key={tpl.id} template={tpl} locale={locale} t={t} onTry={(text) => tryTemplate(text)} />
          ))}
        </ul>
      </section>

      <section className="cs-section" ref={studioRef} aria-labelledby={`${ids}-studio`} data-open={open ? "true" : undefined}>
        <div className="cs-head">
          <h2 id={`${ids}-studio`} className="cs-h2">
            {t.title}
          </h2>
          {!open ? (
            <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={() => setOpen(true)}>
              {t.gallery.try}
            </button>
          ) : null}
        </div>
        {!canEdit ? <p className="cs-small">{t.readOnly}</p> : null}

        {open ? (
          <div className="cs-studio">
            {/* 1. The cost of the chosen model, at the top (the owner's layout). */}
            <div className="cs-cost" data-testid="cs-cost" aria-live="polite">
              <h3 className="cs-h3">{t.cost.heading}</h3>
              {!video ? (
                <p className="cs-small">{t.cost.pickVideo}</p>
              ) : quoting === "loading" ? (
                <p className="cs-small">{t.cost.loading}</p>
              ) : quoting === "error" || !quote ? (
                <p className="cs-fail">{t.cost.failed}</p>
              ) : (
                <>
                  <p className={cost?.sellable ? "cs-price" : "cs-fail"} data-testid="cs-cost-main">
                    {cost?.main}
                  </p>
                  {cost?.detail ? <p className="cs-small">{cost.detail}</p> : null}
                  <p className="cs-small">{fmt(t.cost.seconds, { seconds: quote.billedSeconds, resolution: quote.resolution })}</p>
                </>
              )}
            </div>

            {/* 2. The model picker, below the cost: each with its own price for this clip. */}
            <fieldset className="cs-models" data-testid="cs-models">
              <legend className="cs-h3">{t.model.heading}</legend>
              <p className="cs-small">{t.model.hint}</p>
              {MODEL_IDS.map((m) => {
                const f = MODEL_FACTS[m];
                const q = quote?.models.find((x) => x.model === m);
                const line = video && quote ? costText(t, q, quote.exempt).main : null;
                return (
                  <label key={m} className="cs-model" data-model={m}>
                    <input type="radio" name={`${ids}-model`} value={m} checked={model === m} onChange={() => setModel(m)} />
                    <span className="cs-model-body">
                      <span className="cs-model-name">
                        {f.name} <span className="cs-small">({f.maker})</span>
                      </span>
                      {line ? <span className="cs-small" data-testid={`cs-price-${m}`}>{line}</span> : null}
                      <span className="cs-small">{f.keepsSound ? t.model.keepsSound : t.model.soundPutBack}</span>
                      {f.ownClipsOnly ? <span className="cs-small">{t.model.ownClipsOnly}</span> : null}
                      <span className="cs-small">{fmt(t.model.pictures, { n: f.maxPictures })}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>

            <div className="cs-field">
              <span className="cs-h3">{t.inputs.resolution}</span>
              <div className="cs-actions" role="radiogroup" aria-label={t.inputs.resolution}>
                {RESOLUTIONS.map((r) => (
                  <button key={r} type="button" role="radio" aria-checked={resolution === r} className={resolution === r ? "btn-primary min-h-11 px-4 text-sm" : "btn-quiet min-h-11 px-4 text-sm"} onClick={() => setResolution(r)}>
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <fieldset className="cs-field">
              <legend className="cs-h3">{t.inputs.video}</legend>
              <p className="cs-small">
                {t.inputs.videoHint} <a href={libraryHref}>{t.inputs.openLibrary}</a>
              </p>
              {state.videos.length === 0 ? <p className="cs-small">{t.inputs.noVideos}</p> : null}
              <ul className="cs-picks">
                {state.videos.map((v) => (
                  <li key={v.id}>
                    <label className="cs-pick" data-selected={video === v.id ? "true" : undefined}>
                      <input type="radio" name={`${ids}-video`} value={v.id} checked={video === v.id} onChange={() => setVideo(v.id)} />
                      <Thumb url={v.thumbUrl} />
                      <span className="cs-small">{v.name ?? v.id.slice(0, 8)}{v.durationS ? ` · ${fmt(t.inputs.seconds, { seconds: Math.round(v.durationS * 10) / 10 })}` : ""}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>

            <fieldset className="cs-field">
              <legend className="cs-h3">{t.inputs.pictures}</legend>
              <p className="cs-small">{t.inputs.picturesHint}</p>
              {state.pictures.length === 0 ? <p className="cs-small">{t.inputs.noPictures}</p> : null}
              <ul className="cs-picks">
                {state.pictures.map((p) => {
                  const n = refs.indexOf(p.id) + 1;
                  return (
                    <li key={p.id}>
                      <label className="cs-pick" data-selected={n ? "true" : undefined}>
                        <input type="checkbox" checked={n > 0} onChange={() => togglePicture(p.id)} />
                        <Thumb url={p.thumbUrl} />
                        <span className="cs-small">{n ? fmt(t.inputs.pictureN, { n }) : p.name ?? p.id.slice(0, 8)}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>

            <div className="cs-field">
              <label className="cs-h3" htmlFor={`${ids}-prompt`}>
                {t.inputs.prompt}
              </label>
              <p className="cs-small">{t.inputs.promptHint}</p>
              <textarea
                id={`${ids}-prompt`}
                className="ns-field"
                rows={4}
                maxLength={PROMPT_MAX}
                value={prompt}
                placeholder={t.inputs.promptPlaceholder}
                onChange={(e) => setPrompt(e.target.value)}
                data-testid="cs-prompt"
              />
              {prompt && !namesACharacter(prompt) ? <p className="cs-fail">{t.inputs.needsCharacter}</p> : null}
              {named.filter((n) => n > refs.length).map((n) => (
                <p key={`m${n}`} className="cs-fail">{fmt(t.inputs.missing, { n })}</p>
              ))}
              {refs.map((_, i) => i + 1).filter((n) => prompt && !named.includes(n)).map((n) => (
                <p key={`u${n}`} className="cs-small">{fmt(t.inputs.unnamed, { n })}</p>
              ))}
            </div>

            <fieldset className="cs-field" data-testid="cs-consent">
              <legend className="cs-h3">{t.consent.heading}</legend>
              <p className="cs-small">{fmt(t.consent.intro, { maker: facts.maker })}</p>
              {DECLARATIONS.map((k) => (
                <label key={k} className="cs-check">
                  <input type="checkbox" checked={declared[k]} onChange={(e) => setDeclared((d) => ({ ...d, [k]: e.target.checked }))} disabled={!canEdit} />
                  <span>{fmt((t.consent as Record<string, string>)[k], { maker: facts.maker })}</span>
                </label>
              ))}
              <p className="cs-small">{t.consent.label}</p>
            </fieldset>

            {failure ? (
              <p className="cs-fail" role="alert">
                {swapErrorText(t, failure)}
              </p>
            ) : null}
            <div className="cs-actions">
              <button type="button" className="btn-primary min-h-11 px-4 text-sm" disabled={!ready} onClick={() => void start()}>
                {busy ? t.consent.working : t.consent.submit}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="cs-section" aria-labelledby={`${ids}-jobs`}>
        <h2 id={`${ids}-jobs`} className="cs-h2">
          {t.jobs.heading}
        </h2>
        {state.jobs.length === 0 ? <p className="cs-small">{t.jobs.empty}</p> : null}
        <ul className="cs-jobs">
          {state.jobs.map((j) => (
            <li key={j.id} className="cs-job" data-status={j.status}>
              <span className="cs-model-name">{MODEL_FACTS[j.model].name}</span>
              <span className="cs-small">{t.jobs[j.status]}</span>
              {j.status === "ready" && j.charged !== null ? <span className="cs-small">{fmt(t.jobs.charged, { credits: j.charged })}</span> : null}
              {j.status === "ready" ? (
                <>
                  <span className="cs-badge">{t.jobs.aiLabel}</span>
                  <a href={libraryHref}>{t.jobs.open}</a>
                </>
              ) : null}
              {j.status === "requested" && canEdit ? (
                <button type="button" className="btn-quiet min-h-11 px-4 text-sm" disabled={busy} onClick={() => void cancel(j)}>
                  {t.jobs.cancel}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
