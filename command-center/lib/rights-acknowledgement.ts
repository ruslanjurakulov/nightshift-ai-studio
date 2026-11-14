/**
 * Rights acknowledgement (migration 0174, docs/RIGHTS_ACKNOWLEDGEMENT.md): the "I take responsibility" step in front of a
 * model whose provider (or the law) makes the person confirm their rights to an input before it is sent.
 *
 * The database decides (CLAUDE.md rule 3): create_creative_job refuses `acknowledgement_required` until THIS person
 * acknowledged THIS input at the CURRENT text version, before anything is priced or held. The browser only shows the words,
 * records the answer through `acknowledge_rights`, and asks again. Nothing here can open a job the database would refuse.
 *
 * Pure: no React, no fetch. The Studio's dialog (components/studio/RightsAcknowledgementDialog.tsx) and the route
 * (app/api/creative/acknowledgements) both read it.
 */

/** The closed list, in the order the database's CHECK names them (0174 rights_acknowledgement_kinds). */
export const RIGHTS_KINDS = ["likeness_photo", "voice_clone", "third_party_content"] as const;
export type RightsKind = (typeof RIGHTS_KINDS)[number];

/**
 * The text version whose words this build carries (lib/i18n/rights-acknowledgement/*). It MUST equal the version 0174 seeds
 * (tests/rights-acknowledgement.test.ts reads the migration): a change of the words is a new version in a new migration AND
 * here, in the same pull request. When the database names another version, this page's words are not the ones in force, so
 * the dialog does not show them (it asks for a reload): the person never acknowledges words they were not shown.
 */
export const RIGHTS_TEXT_VERSIONS: Readonly<Record<RightsKind, string>> = {
  likeness_photo: "likeness_photo.v1",
  voice_clone: "voice_clone.v1",
  third_party_content: "third_party_content.v1",
};

/** Our Terms §6.2 sits in the "acceptable-use" section (lib/legal-docs/*.ts). */
export const RIGHTS_TERMS_HREF = "/terms#acceptable-use";

/**
 * The media inputs a generation takes (creative_params_problem, 0156), in the order the database checks them. The same two
 * keys 0174's rights_acknowledgement_missing reads; tests pin that the lists agree.
 */
export const RIGHTS_SUBJECT_KEYS = ["source_asset_id", "end_asset_id"] as const;
export type RightsSubjectKey = (typeof RIGHTS_SUBJECT_KEYS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRightsKind(v: unknown): v is RightsKind {
  return typeof v === "string" && (RIGHTS_KINDS as readonly string[]).includes(v);
}

/** One (kind, subject) the person has not acknowledged yet, as the database names it. `textVersion` null = no current version. */
export interface MissingAcknowledgement {
  kind: string;
  textVersion: string | null;
  subject: string;
}

/** The inputs of a request, in order, each once: what the database would ask about. */
export function inputSubjects(params: Record<string, unknown>): { key: RightsSubjectKey; id: string }[] {
  const out: { key: RightsSubjectKey; id: string }[] = [];
  for (const key of RIGHTS_SUBJECT_KEYS) {
    const v = params[key];
    if (typeof v === "string" && UUID_RE.test(v) && !out.some((s) => s.id === v)) out.push({ key, id: v });
  }
  return out;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function missingOf(v: unknown): MissingAcknowledgement | null {
  const o = obj(v);
  if (!o || typeof o.kind !== "string" || typeof o.subject !== "string") return null;
  const tv = o.text_version ?? o.textVersion;
  return { kind: o.kind, textVersion: typeof tv === "string" && tv !== "" ? tv : null, subject: o.subject };
}

/**
 * rights_acknowledgement_status()'s answer, or null when it is not that shape. A malformed answer is not read as "nothing
 * missing": the caller treats null as a failed check.
 */
export function parseStatus(raw: unknown): { required: { kind: string; textVersion: string | null }[]; missing: MissingAcknowledgement[] } | null {
  const o = obj(raw);
  if (!o || !Array.isArray(o.required) || !Array.isArray(o.missing)) return null;
  const required: { kind: string; textVersion: string | null }[] = [];
  for (const r of o.required) {
    const ro = obj(r);
    if (!ro || typeof ro.kind !== "string") return null;
    const tv = ro.text_version ?? ro.textVersion;
    required.push({ kind: ro.kind, textVersion: typeof tv === "string" && tv !== "" ? tv : null });
  }
  const missing: MissingAcknowledgement[] = [];
  for (const m of o.missing) {
    const mm = missingOf(m);
    if (!mm) return null;
    missing.push(mm);
  }
  return { required, missing };
}

/** create_creative_job's refusal detail, `kind=… version=… subject=…` (0174), or null. */
export function parseRefusalDetail(detail: unknown): MissingAcknowledgement | null {
  if (typeof detail !== "string") return null;
  const m = /^kind=([a-z_]{1,40}) version=(\S{1,60}) subject=(\S{1,80})$/.exec(detail.trim());
  if (!m) return null;
  return { kind: m[1], textVersion: m[2] === "none" ? null : m[2], subject: m[3] };
}

/**
 * Can this page show the words the database asks about? Only for a kind it knows, at the very version it carries. Anything
 * else (a newer version, a kind this build does not know) is `stale`: the dialog says to reload, and records nothing.
 */
export function wordsFor(m: MissingAcknowledgement): { ok: true; kind: RightsKind; textVersion: string } | { ok: false; reason: "stale" } {
  if (!isRightsKind(m.kind) || m.textVersion === null || RIGHTS_TEXT_VERSIONS[m.kind] !== m.textVersion) return { ok: false, reason: "stale" };
  return { ok: true, kind: m.kind, textVersion: m.textVersion };
}

/** The missing pairs of one dialog: the first kind asked about, with every subject of it. The rest wait for the next dialog. */
export function nextGroup(missing: readonly MissingAcknowledgement[]): { kind: string; textVersion: string | null; subjects: string[] } | null {
  const first = missing[0];
  if (!first) return null;
  const subjects = missing.filter((m) => m.kind === first.kind && m.textVersion === first.textVersion).map((m) => m.subject);
  return { kind: first.kind, textVersion: first.textVersion, subjects: [...new Set(subjects)] };
}

/** The outcome of recording one acknowledgement, as the route answers it. */
export type AcknowledgeProblem = "version_changed" | "source_unavailable" | "unavailable" | "forbidden" | "failed";

export function acknowledgeProblem(status: number, error: unknown): AcknowledgeProblem {
  if (error === "acknowledgement_version_changed") return "version_changed";
  if (error === "source_unavailable") return "source_unavailable";
  if (error === "acknowledgement_unavailable" || status === 503) return "unavailable";
  if (status === 401 || status === 403) return "forbidden";
  return "failed";
}
