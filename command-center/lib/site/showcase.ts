/**
 * The public site's model samples: real generations made in the operator's Studio, each shown with the model that made it.
 *
 * The ONE data file is lib/site/showcase.json. Nobody edits it by hand: tools/export_showcase.py (run by the "Showcase asset"
 * workflow, docs/SHOWCASE.md) appends an entry only after the database said the job belongs to the operator's organization, it
 * completed, its input picture is ours, and the file it downloaded is the exact file the job stored (its sha256). It also writes
 * the web copies under components/site/showcase/<job id>/ and regenerates components/site/showcase-assets.ts, which imports them.
 * The owner merges the PR it opens; nothing reaches the site before that.
 *
 * Why a model may be named here when the rest of the public site names none (tests/helpers/brands.ts): an entry IS a generation by
 * that model, made through our own adapter, so naming it is a fact and not a promise. The name is allowed only inside an entry's own
 * card; tests/site-showcase.test.tsx pins that, and that every entry names a model in schemas/model_registry.json with the
 * registry's attribution.
 *
 * The public site shows the AI-generated label and the model name only: no "Powered by" line and no link to a model's maker
 * (owner decision 2026-11-13). The maker's required credit (Runway API Terms §1, Ideogram Developer API Agreement 2.3.1) is shown
 * in the Studio, where the models are used (components/studio/ModelAttribution.tsx). `attribution` stays in the data so the
 * export and the registry keep agreeing; no public surface renders it, and tests/site-showcase.test.tsx pins that.
 *
 * Kept free of file imports (those are components/site/showcase-assets.ts), so the tests and the footer can read it.
 */
import data from "@/lib/site/showcase.json";

/** Where the job's input picture came from. A stock photograph or someone's upload is never one (the export refuses it). */
export type ShowcaseInput =
  /** A text-only tool (t2v, t2i): there was no input picture. */
  | { kind: "none" }
  /** One of the site's own AI-generated pictures (components/site/art/), byte for byte (its sha256 matched). */
  | { kind: "site_art"; file: string; sha256: string }
  /** The output of another completed job of the operator's organization (checked the same way, back to its first picture). */
  | { kind: "operator_job"; jobId: string; assetId: string };

export interface ShowcaseCost {
  /**
   * The provider cost in US dollars as creative_job_costs recorded it (migration 0037), summed over the job's rows. null = unknown:
   * no row, or a row without a priced figure. Never 0 for "not known" (CLAUDE.md #5).
   */
  usdEstimate: number | null;
  /** Where the dollar figure's price came from (0037 requires it beside a figure); null with no figure. */
  priceSource: string | null;
  /** How many cost rows the job had (0 = nothing recorded, which is why the figure is unknown). */
  rows: number;
  /** The vendor's own measure, as recorded (for example Runway credits): unit and quantity, or null where the row had none. */
  vendor: { provider: string; vendorModel: string | null; unit: string | null; quantity: number | null }[];
}

export interface ShowcaseEntry {
  /** The creative job (creative_jobs.id) that made it. */
  jobId: string;
  /** The output's library asset (media_assets.id), whose sha256 the downloaded file matched. */
  assetId: string;
  sha256: string;
  /** The registry id of the model that made it (the routed model when the job ran on Auto). */
  modelId: string;
  /** The registry's display name, as it was at export. */
  modelName: string;
  /** The registry's provider slug. */
  provider: string;
  /**
   * The registry's `operator_preview`: the operator may try the model, customers cannot buy it yet. The card then says the model is
   * coming to the Studio, and "Try this prompt" opens the tool without naming it (never a claim that it is on sale).
   * tests/site-showcase.test.tsx fails when this and the registry disagree, so a model that goes on sale gets its link back.
   */
  operatorPreview: boolean;
  /**
   * The vendor's announced shutdown of the model (registry `shutdown.on`, YYYY-MM-DD), or null. From that day the card says the
   * model is no longer in the Studio and its link stops naming it; the export refuses a model already past it.
   */
  shutdownOn: string | null;
  /** The credit line the maker requires (the registry's `attribution`), or null where it asks for none. Kept as data only: the
   *  public site never renders it; the Studio shows the maker's credit where the model is used (see the header). */
  attribution: { text: string; url: string } | null;
  /** The Studio tool it was made with (i2v, t2v, t2i …). */
  capability: string;
  kind: "video" | "image";
  /** The words the job was given, as stored on the job (empty when the tool took none). */
  prompt: string;
  /** When the job was created (ISO 8601): the date the sample shows. */
  createdAt: string;
  input: ShowcaseInput;
  /** An animation's end frame, checked like the input; null when it had none. */
  endFrame: ShowcaseInput | null;
  cost: ShowcaseCost;
  /** The 1280-wide derivative's size. */
  width: number;
  height: number;
  /** The slot it was exported for (components/site/slots.ts SLOTS), or null; it fills that slot while the slot's `ai` is null. */
  slot: string | null;
  /** The owner's note from the workflow's input. Not shown on the site (it is one language). */
  caption: string | null;
  exportedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
// The registry's id shape (lib/models-admin MODEL_ID_RE), repeated so this module stays free of the admin code.
const MODEL = /^[a-z0-9][a-z0-9.-]{1,39}$/;
const CAP = /^[a-z][a-z0-9_]{0,31}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 16384;
const nullableNum = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

function input(v: unknown): ShowcaseInput | null {
  if (!isObj(v)) return null;
  if (v.kind === "none") return { kind: "none" };
  if (v.kind === "site_art" && str(v.file, 80) && /^[a-z0-9-]+\.webp$/.test(v.file) && typeof v.sha256 === "string" && SHA.test(v.sha256))
    return { kind: "site_art", file: v.file, sha256: v.sha256 };
  if (v.kind === "operator_job" && typeof v.jobId === "string" && UUID.test(v.jobId) && typeof v.assetId === "string" && UUID.test(v.assetId))
    return { kind: "operator_job", jobId: v.jobId, assetId: v.assetId };
  return null;
}

function cost(v: unknown): ShowcaseCost | null {
  if (!isObj(v) || !nullableNum(v.usdEstimate) || !Number.isInteger(v.rows) || (v.rows as number) < 0 || !Array.isArray(v.vendor)) return null;
  // A figure says where its price came from, and an unknown says nothing about one (0037's own rule).
  if ((v.usdEstimate === null) !== (v.priceSource === null)) return null;
  if (v.priceSource !== null && !str(v.priceSource, 300)) return null;
  // No row recorded means the cost is unknown, never zero.
  if (v.rows === 0 && v.usdEstimate !== null) return null;
  const vendor: ShowcaseCost["vendor"] = [];
  for (const r of v.vendor) {
    if (!isObj(r) || !str(r.provider, 40)) return null;
    if (!(r.vendorModel === null || str(r.vendorModel, 200)) || !(r.unit === null || str(r.unit, 40)) || !nullableNum(r.quantity)) return null;
    vendor.push({ provider: r.provider, vendorModel: r.vendorModel as string | null, unit: r.unit as string | null, quantity: r.quantity as number | null });
  }
  return { usdEstimate: v.usdEstimate, priceSource: v.priceSource as string | null, rows: v.rows as number, vendor };
}

/** One entry as the data file holds it, or null when any field is missing or malformed (it is then not shown at all). */
export function parseShowcaseEntry(v: unknown): ShowcaseEntry | null {
  if (!isObj(v)) return null;
  const { jobId, assetId, sha256, modelId, modelName, provider, operatorPreview, capability, kind, prompt, createdAt, width, height, exportedAt } = v;
  if (typeof operatorPreview !== "boolean") return null;
  const shutdownOn = v.shutdownOn;
  if (!(shutdownOn === null || (typeof shutdownOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(shutdownOn)))) return null;
  if (typeof jobId !== "string" || !UUID.test(jobId) || typeof assetId !== "string" || !UUID.test(assetId)) return null;
  if (typeof sha256 !== "string" || !SHA.test(sha256)) return null;
  if (typeof modelId !== "string" || !MODEL.test(modelId) || !str(modelName, 80) || typeof provider !== "string" || !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(provider)) return null;
  if (typeof capability !== "string" || !CAP.test(capability) || (kind !== "video" && kind !== "image")) return null;
  if (typeof prompt !== "string" || prompt.length > 4000) return null;
  if (!isoDate(createdAt) || !isoDate(exportedAt) || !posInt(width) || !posInt(height)) return null;
  let attribution: ShowcaseEntry["attribution"] = null;
  if (v.attribution !== null) {
    const a = v.attribution;
    // Only an https link is ever an href (the registry's schema allows nothing else).
    if (!isObj(a) || !str(a.text, 80) || typeof a.url !== "string" || !a.url.startsWith("https://")) return null;
    attribution = { text: a.text, url: a.url };
  }
  const inp = input(v.input);
  const end = v.endFrame === null ? null : input(v.endFrame);
  const c = cost(v.cost);
  if (!inp || (v.endFrame !== null && !end) || !c) return null;
  if (!(v.slot === null || (typeof v.slot === "string" && /^[a-z][a-z0-9.-]{0,40}$/.test(v.slot)))) return null;
  if (!(v.caption === null || str(v.caption, 200))) return null;
  return {
    jobId, assetId, sha256, modelId, modelName: modelName as string, provider, operatorPreview, shutdownOn, attribution, capability, kind, prompt, createdAt, input: inp, endFrame: end, cost: c,
    width, height, slot: v.slot as string | null, caption: v.caption as string | null, exportedAt,
  };
}

/**
 * Why a card must not name its model in "Try this prompt", or null when it may: the model is an operator preview (not in the
 * Studio yet), or the vendor's announced shutdown day has come (no longer in the Studio). `today` is UTC, as the dates are.
 */
export function modelLeftOut(e: { operatorPreview?: boolean; shutdownOn?: string | null }, now: Date = new Date()): "preview" | "shut_down" | null {
  if (e.shutdownOn && e.shutdownOn <= now.toISOString().slice(0, 10)) return "shut_down";
  if (e.operatorPreview) return "preview";
  return null;
}

/**
 * The pictures that are only an animation's starting frame: a picture entry that is the `operator_job` input of some i2v entry.
 * Atlas/owner decision 22 Nov: a starting frame is not its own sample. The grids leave these out (components/site/ShowcaseGallery
 * showcaseItems); the clip's dialog ("made from this picture"), picture → video and the slots still show them, beside their clip or
 * where a slot names them. Derived, so a future export's source is hidden without anyone listing it.
 */
export function sourceOnlyJobs(entries: readonly ShowcaseEntry[]): Set<string> {
  const images = new Set(entries.filter((e) => e.kind === "image").map((e) => e.jobId));
  const out = new Set<string>();
  for (const e of entries) if (e.capability === "i2v" && e.input.kind === "operator_job" && images.has(e.input.jobId)) out.add(e.input.jobId);
  return out;
}

/** Every well-formed entry, newest first, each job once. */
export function parseShowcase(raw: unknown): ShowcaseEntry[] {
  const list = isObj(raw) && Array.isArray(raw.entries) ? raw.entries : [];
  const seen = new Set<string>();
  const out: ShowcaseEntry[] = [];
  for (const e of list) {
    const entry = parseShowcaseEntry(e);
    if (!entry || seen.has(entry.jobId)) continue;
    seen.add(entry.jobId);
    out.push(entry);
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The data file's entries. Empty until the owner merges the first export: the gallery then renders nothing. */
export const SHOWCASE_ENTRIES: readonly ShowcaseEntry[] = parseShowcase(data);

/** The models the site's samples name, each once, for the footer's credits. */
export function showcaseModels(entries: readonly ShowcaseEntry[]): { modelId: string; modelName: string; attribution: ShowcaseEntry["attribution"] }[] {
  const out = new Map<string, { modelId: string; modelName: string; attribution: ShowcaseEntry["attribution"] }>();
  for (const e of entries) if (!out.has(e.modelId)) out.set(e.modelId, { modelId: e.modelId, modelName: e.modelName, attribution: e.attribution });
  return [...out.values()];
}

/** The files one entry plays (components/site/showcase-assets.ts, generated with the data file). */
export interface ShowcaseFiles {
  poster: string;
  posterSm: string;
  /** null for a picture. */
  clip: { mp4: string; webm: string; smMp4: string; smWebm: string } | null;
  /**
   * A larger rendition than the 1280 one, only when the model's own output is larger (never an upscale): its still, its
   * real width, and its clip for a video. No entry has one today (the site's clips are 720p to 768p); the pages already offer
   * it to a wide screen when it is there (lib/site/renditions.ts) and fall back to the 1280 files when it is not.
   */
  lg?: { poster: string; width: number; clip: { mp4: string; webm: string } | null };
}
