"use client";

import { useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { LibraryDialog } from "@/components/media/LibraryDialog";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { AdsPicturePicker } from "@/components/ads/AdsPicturePicker";
import { adsErrorText, adsRequest, type AdsResult } from "@/components/ads/api";
import {
  ADS_LIMITS,
  AD_DIRECTIONS,
  AD_FORMAT_IDS,
  AD_LANGUAGES,
  AD_OBJECTIVES,
  parseCampaignInput,
  parseConceptEdit,
  parseKitInput,
  parseProductInput,
  type AdCampaign,
  type AdConcept,
  type AdDirection,
  type AdFormat,
  type AdLanguage,
  type AdObjective,
  type AdsError,
  type BrandKit,
  type BrandProduct,
  type StoryboardBeat,
} from "@/lib/adsFactory/model";

/**
 * The Ads workspace's forms, each in the library's dialog (a bottom sheet on a phone, a card from `sm` up; focus moves in, Tab stays
 * inside, Escape closes, focus returns to the control that opened it).
 *
 * Every form checks its input with the same pure rules the route uses (lib/adsFactory/model) so a mistake is named before a round
 * trip, then sends it; the route and the database check it all again. A refusal is shown in the form, in the reader's language, and
 * the form stays as it was typed: nothing is a dead end. While a request runs the buttons are disabled, so a second press cannot
 * send it twice.
 */

type Failure = { error: AdsError; max?: number };

/** The shell every form shares: the dialog, the form element, the error line, Cancel and Save. */
function FormDialog({
  title,
  opener,
  onClose,
  onSubmit,
  failure,
  busy,
  wide = true,
  submitLabel,
  danger = false,
  children,
}: {
  title: string;
  opener?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: () => void;
  failure: Failure | null;
  busy: boolean;
  wide?: boolean;
  submitLabel?: string;
  danger?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const ta = t.adsFactory;
  const formId = useId();
  const first = useRef<HTMLFormElement>(null);
  return (
    <LibraryDialog
      title={title}
      onClose={onClose}
      opener={opener}
      closeLabel={ta.close}
      wide={wide}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={onClose} disabled={busy}>
            {ta.cancel}
          </button>
          <button type="submit" form={formId} className={`${danger ? "btn-danger" : "btn-primary"} min-h-11 px-4 text-sm disabled:opacity-50`} disabled={busy}>
            {busy ? ta.saving : (submitLabel ?? ta.save)}
          </button>
        </>
      }
    >
      <form
        id={formId}
        ref={first}
        className="ads-form"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!busy) onSubmit();
        }}
      >
        {children}
        {failure && (
          <p className="ads-fail" role="alert">
            {adsErrorText(ta, failure)}
          </p>
        )}
      </form>
    </LibraryDialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: (ids: { id: string; hintId: string | undefined }) => ReactNode }) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="ads-field">
      <label htmlFor={id} className="t-label">
        {label}
      </label>
      {children({ id, hintId: hint ? hintId : undefined })}
      {hint && (
        <p id={hintId} className="ads-small">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Run one save: client check, request, then either hand the result to the page or show the refusal in the form. */
function useSave(onSaved: () => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  async function run(check: { ok: true } | { ok: false; error: AdsError }, send: () => Promise<AdsResult<unknown>>) {
    if (busy) return;
    if (!check.ok) {
      setFailure({ error: check.error });
      return;
    }
    setBusy(true);
    setFailure(null);
    const out = await send();
    setBusy(false);
    if (out.ok) onSaved();
    else setFailure(out);
  }
  return { busy, failure, run };
}

const NEXT_COLOURS = ["#1a1a1a", "#ffffff", "#d9aa61", "#2f6fed", "#1f9d55", "#d64545", "#7a5af8", "#f59e0b"];

// ── brand kit ────────────────────────────────────────────────────────────────

export function KitDialog({
  orgId,
  kit,
  libraryHref,
  opener,
  onClose,
  onSaved,
}: {
  orgId: string;
  kit: BrandKit | null;
  libraryHref: string;
  opener?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const ta = t.adsFactory;
  const tk = ta.kits;
  const [name, setName] = useState(kit?.name ?? "");
  const [site, setSite] = useState(kit?.siteUrl ?? "");
  const [logo, setLogo] = useState<string[]>(kit?.logo ? [kit.logo.assetId] : []);
  const [palette, setPalette] = useState<string[]>(kit?.palette ?? []);
  const [fonts, setFonts] = useState((kit?.fonts ?? []).join(", "));
  const [voice, setVoice] = useState(kit?.voice ?? "");
  const { busy, failure, run } = useSave(onSaved);

  function submit() {
    const body = {
      org_id: orgId,
      name,
      site_url: site,
      logo_asset_id: logo[0] ?? null,
      palette,
      fonts: fonts.split(",").map((f) => f.trim()).filter(Boolean),
      voice,
    };
    void run(parseKitInput(body), () => (kit ? adsRequest("PATCH", `/api/ads/kits/${kit.id}`, body) : adsRequest("POST", "/api/ads/kits", body)));
  }

  return (
    <FormDialog title={kit ? tk.editTitle : tk.createTitle} opener={opener} onClose={onClose} onSubmit={submit} failure={failure} busy={busy}>
      <Field label={tk.name}>
        {({ id }) => <input id={id} className="ns-field" value={name} onChange={(e) => setName(e.target.value)} placeholder={tk.namePh} autoComplete="off" required />}
      </Field>
      <Field label={`${tk.site} (${ta.optional})`} hint={tk.siteHint}>
        {({ id, hintId }) => (
          <input id={id} className="ns-field" type="url" inputMode="url" value={site} onChange={(e) => setSite(e.target.value)} placeholder={tk.sitePh} autoComplete="off" spellCheck={false} aria-describedby={hintId} />
        )}
      </Field>
      <fieldset className="ads-fieldset">
        <legend className="t-label">{`${tk.logo} (${ta.optional})`}</legend>
        <p className="ads-small">{tk.logoHint}</p>
        <AdsPicturePicker orgId={orgId} selected={logo} onChange={setLogo} max={1} label={tk.logo} libraryHref={libraryHref} />
      </fieldset>
      <fieldset className="ads-fieldset">
        <legend className="t-label">{`${tk.palette} (${ta.optional})`}</legend>
        <p className="ads-small">{fmt(tk.paletteHint, { max: ADS_LIMITS.palette })}</p>
        <div className="ads-row">
          {palette.map((colour, i) => (
            <span key={i} className="ads-colour">
              <input
                type="color"
                value={colour}
                aria-label={fmt(tk.colourN, { n: i + 1 })}
                onChange={(e) => setPalette(palette.map((c, j) => (j === i ? e.target.value.toLowerCase() : c)))}
              />
              <button type="button" className="btn-quiet min-h-11 px-3 text-sm" aria-label={fmt(tk.removeColour, { n: i + 1 })} onClick={() => setPalette(palette.filter((_, j) => j !== i))}>
                {ta.delete}
              </button>
            </span>
          ))}
          <button
            type="button"
            className="btn-quiet min-h-11 px-3 text-sm disabled:opacity-40"
            disabled={palette.length >= ADS_LIMITS.palette}
            onClick={() => setPalette([...palette, NEXT_COLOURS.find((c) => !palette.includes(c)) ?? "#808080"])}
          >
            {tk.addColour}
          </button>
        </div>
      </fieldset>
      <Field label={`${tk.fonts} (${ta.optional})`} hint={fmt(tk.fontsHint, { max: ADS_LIMITS.fonts })}>
        {({ id, hintId }) => <input id={id} className="ns-field" value={fonts} onChange={(e) => setFonts(e.target.value)} placeholder={tk.fontsPh} autoComplete="off" aria-describedby={hintId} />}
      </Field>
      <Field label={`${tk.voice} (${ta.optional})`} hint={tk.voiceHint}>
        {({ id, hintId }) => <textarea id={id} className="ns-field" value={voice} onChange={(e) => setVoice(e.target.value)} placeholder={tk.voicePh} rows={3} aria-describedby={hintId} />}
      </Field>
    </FormDialog>
  );
}

// ── product ──────────────────────────────────────────────────────────────────

export function ProductDialog({
  orgId,
  kitId,
  product,
  libraryHref,
  opener,
  onClose,
  onSaved,
}: {
  orgId: string;
  kitId: string;
  product: BrandProduct | null;
  libraryHref: string;
  opener?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const ta = t.adsFactory;
  const tp = ta.products;
  const [title, setTitle] = useState(product?.title ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [price, setPrice] = useState(product?.price ?? "");
  // A picture deleted from the library is dropped from the selection: the database would refuse the save because of it.
  const [images, setImages] = useState<string[]>((product?.images ?? []).filter((i) => i.live).map((i) => i.assetId));
  const { busy, failure, run } = useSave(onSaved);

  function submit() {
    const body = { title, description, price, image_ids: images };
    void run(parseProductInput(body), () =>
      product ? adsRequest("PATCH", `/api/ads/products/${product.id}`, body) : adsRequest("POST", `/api/ads/kits/${kitId}/products`, body),
    );
  }

  return (
    <FormDialog title={product ? tp.editTitle : tp.createTitle} opener={opener} onClose={onClose} onSubmit={submit} failure={failure} busy={busy}>
      <Field label={tp.title}>
        {({ id }) => <input id={id} className="ns-field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tp.titlePh} autoComplete="off" required />}
      </Field>
      <Field label={`${tp.description} (${ta.optional})`}>
        {({ id }) => <textarea id={id} className="ns-field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tp.descriptionPh} rows={3} />}
      </Field>
      <Field label={`${tp.price} (${ta.optional})`} hint={tp.priceHint}>
        {({ id, hintId }) => <input id={id} className="ns-field" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={tp.pricePh} autoComplete="off" aria-describedby={hintId} />}
      </Field>
      <fieldset className="ads-fieldset">
        <legend className="t-label">{`${tp.images} (${ta.optional})`}</legend>
        <p className="ads-small">{fmt(tp.imagesHint, { max: ADS_LIMITS.productImages })}</p>
        <AdsPicturePicker orgId={orgId} selected={images} onChange={setImages} max={ADS_LIMITS.productImages} label={tp.images} libraryHref={libraryHref} />
      </fieldset>
    </FormDialog>
  );
}

// ── campaign ─────────────────────────────────────────────────────────────────

function toggleIn<T>(list: T[], value: T, max: number): T[] {
  if (list.includes(value)) return list.filter((v) => v !== value);
  return list.length >= max ? list : [...list, value];
}

export function CampaignDialog({
  kits,
  campaign,
  opener,
  onClose,
  onSaved,
}: {
  /** The kits a campaign can be made for: those with at least one product. An existing campaign keeps its own kit. */
  kits: BrandKit[];
  campaign: AdCampaign | null;
  opener?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const ta = t.adsFactory;
  const tc = ta.campaigns;
  const [kitId, setKitId] = useState(campaign?.kitId ?? kits[0]?.id ?? "");
  const [name, setName] = useState(campaign?.name ?? "");
  const [objective, setObjective] = useState<AdObjective>(campaign?.objective ?? "sales");
  const [language, setLanguage] = useState<AdLanguage>(campaign?.language ?? "en");
  const [formats, setFormats] = useState<AdFormat[]>(campaign?.formats ?? ["1:1"]);
  const [directions, setDirections] = useState<AdDirection[]>(campaign?.directions ?? ["spotlight"]);
  const kit = kits.find((k) => k.id === kitId) ?? null;
  const [productIds, setProductIds] = useState<string[]>(() => {
    const own = new Set((kit?.products ?? []).map((p) => p.id));
    return campaign ? campaign.productIds.filter((id) => own.has(id)) : [...own].slice(0, ADS_LIMITS.campaignProducts);
  });
  const { busy, failure, run } = useSave(onSaved);
  const kitFieldId = useId();

  function submit() {
    const body = { kit_id: kitId, name, objective, language, formats, directions, product_ids: productIds };
    void run(parseCampaignInput(body), () =>
      campaign ? adsRequest("PATCH", `/api/ads/campaigns/${campaign.id}`, body) : adsRequest("POST", "/api/ads/campaigns", body),
    );
  }

  return (
    <FormDialog title={campaign ? tc.editTitle : tc.createTitle} opener={opener} onClose={onClose} onSubmit={submit} failure={failure} busy={busy}>
      <div className="ads-field">
        <label htmlFor={kitFieldId} className="t-label">
          {tc.kit}
        </label>
        <select
          id={kitFieldId}
          className="ns-field"
          value={kitId}
          // A campaign's kit is fixed once it exists (the database refuses a change); only a new campaign chooses.
          disabled={Boolean(campaign)}
          onChange={(e) => {
            setKitId(e.target.value);
            setProductIds((kits.find((k) => k.id === e.target.value)?.products ?? []).map((p) => p.id).slice(0, ADS_LIMITS.campaignProducts));
          }}
        >
          {kits.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      </div>
      <Field label={tc.name}>
        {({ id }) => <input id={id} className="ns-field" value={name} onChange={(e) => setName(e.target.value)} placeholder={tc.namePh} autoComplete="off" required />}
      </Field>
      <Field label={tc.objective}>
        {({ id }) => (
          <select id={id} className="ns-field" value={objective} onChange={(e) => setObjective(e.target.value as AdObjective)}>
            {AD_OBJECTIVES.map((o) => (
              <option key={o} value={o}>
                {ta.objective[o]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={tc.language}>
        {({ id }) => (
          <select id={id} className="ns-field" value={language} onChange={(e) => setLanguage(e.target.value as AdLanguage)}>
            {AD_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {ta.language[l]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <fieldset className="ads-fieldset">
        <legend className="t-label">{tc.formats}</legend>
        <p className="ads-small">{tc.formatsHint}</p>
        <ChipRow label={tc.formats} wrap>
          {AD_FORMAT_IDS.map((f) => (
            <Chip key={f} pressed={formats.includes(f)} onClick={() => setFormats(toggleIn(formats, f, AD_FORMAT_IDS.length))}>
              {ta.format[f]}
            </Chip>
          ))}
        </ChipRow>
      </fieldset>
      <fieldset className="ads-fieldset">
        <legend className="t-label">{tc.directions}</legend>
        <p className="ads-small">{fmt(tc.directionsHint, { max: ADS_LIMITS.campaignDirections })}</p>
        <ChipRow label={tc.directions} wrap>
          {AD_DIRECTIONS.map((d) => (
            <Chip
              key={d}
              pressed={directions.includes(d)}
              disabled={!directions.includes(d) && directions.length >= ADS_LIMITS.campaignDirections}
              onClick={() => setDirections(toggleIn(directions, d, ADS_LIMITS.campaignDirections))}
            >
              {ta.direction[d]}
            </Chip>
          ))}
        </ChipRow>
      </fieldset>
      <fieldset className="ads-fieldset">
        <legend className="t-label">{tc.products}</legend>
        <p className="ads-small">{fmt(tc.productsHint, { max: ADS_LIMITS.campaignProducts })}</p>
        {kit && kit.products.length > 0 ? (
          <ul className="ads-checks">
            {kit.products.map((p) => (
              <li key={p.id}>
                <label className="ads-check">
                  <input
                    type="checkbox"
                    checked={productIds.includes(p.id)}
                    disabled={!productIds.includes(p.id) && productIds.length >= ADS_LIMITS.campaignProducts}
                    onChange={() => setProductIds(toggleIn(productIds, p.id, ADS_LIMITS.campaignProducts))}
                  />
                  <span>{p.title}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ads-small">{tc.noProductsInKit}</p>
        )}
      </fieldset>
    </FormDialog>
  );
}

// ── concept ──────────────────────────────────────────────────────────────────

export function ConceptDialog({
  concept,
  opener,
  onClose,
  onSaved,
}: {
  concept: AdConcept;
  opener?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const ta = t.adsFactory;
  const tc = ta.concepts;
  const [headline, setHeadline] = useState(concept.headline);
  const [body, setBody] = useState(concept.body);
  const [cta, setCta] = useState(concept.cta);
  const [brief, setBrief] = useState(concept.visualBrief);
  const [beats, setBeats] = useState<StoryboardBeat[]>(concept.storyboard ?? []);
  const { busy, failure, run } = useSave(onSaved);
  const video = concept.kind === "video";

  function submit() {
    const payload = { headline, body, cta, visual_brief: brief, storyboard: video ? beats : null };
    void run(parseConceptEdit(payload), () => adsRequest("PATCH", `/api/ads/concepts/${concept.id}`, payload));
  }

  return (
    <FormDialog title={tc.editTitle} opener={opener} onClose={onClose} onSubmit={submit} failure={failure} busy={busy}>
      <Field label={tc.headline}>
        {({ id }) => <input id={id} className="ns-field" value={headline} onChange={(e) => setHeadline(e.target.value)} autoComplete="off" required />}
      </Field>
      <Field label={tc.body}>{({ id }) => <textarea id={id} className="ns-field" value={body} onChange={(e) => setBody(e.target.value)} rows={3} />}</Field>
      <Field label={tc.cta}>{({ id }) => <input id={id} className="ns-field" value={cta} onChange={(e) => setCta(e.target.value)} autoComplete="off" />}</Field>
      <Field label={tc.brief} hint={tc.briefHint}>
        {({ id, hintId }) => <textarea id={id} className="ns-field" value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} aria-describedby={hintId} />}
      </Field>
      {video && (
        <fieldset className="ads-fieldset">
          <legend className="t-label">{tc.storyboard}</legend>
          {beats.map((beat, i) => (
            <fieldset key={i} className="ads-fieldset">
              <legend className="ads-small">{fmt(tc.beat, { n: i + 1 })}</legend>
              <Field label={tc.beatVisual}>
                {({ id }) => (
                  <input id={id} className="ns-field" value={beat.visual} onChange={(e) => setBeats(beats.map((b, j) => (j === i ? { ...b, visual: e.target.value } : b)))} autoComplete="off" />
                )}
              </Field>
              <Field label={tc.beatLine}>
                {({ id }) => (
                  <input id={id} className="ns-field" value={beat.line} onChange={(e) => setBeats(beats.map((b, j) => (j === i ? { ...b, line: e.target.value } : b)))} autoComplete="off" />
                )}
              </Field>
              <button
                type="button"
                className="btn-quiet min-h-11 w-fit px-3 text-sm disabled:opacity-40"
                disabled={beats.length <= 1}
                aria-label={fmt(tc.removeBeat, { n: i + 1 })}
                onClick={() => setBeats(beats.filter((_, j) => j !== i))}
              >
                {ta.delete}
              </button>
            </fieldset>
          ))}
          <button type="button" className="btn-quiet min-h-11 w-fit px-3 text-sm disabled:opacity-40" disabled={beats.length >= ADS_LIMITS.beats} onClick={() => setBeats([...beats, { visual: "", line: "" }])}>
            {tc.addBeat}
          </button>
        </fieldset>
      )}
    </FormDialog>
  );
}

// ── delete ───────────────────────────────────────────────────────────────────

/** "Delete this?" with what goes with it said in words. The request runs once; a refusal (a kit still in use) is shown here. */
export function DeleteDialog({
  title,
  body,
  url,
  opener,
  onClose,
  onDone,
}: {
  title: string;
  body: string;
  url: string;
  opener?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const { busy, failure, run } = useSave(onDone);
  return (
    <FormDialog
      title={title}
      opener={opener}
      onClose={onClose}
      onSubmit={() => void run({ ok: true }, () => adsRequest("DELETE", url))}
      failure={failure}
      busy={busy}
      wide={false}
      submitLabel={t.adsFactory.confirmDelete}
      danger
    >
      <p className="ads-text">{body}</p>
    </FormDialog>
  );
}
