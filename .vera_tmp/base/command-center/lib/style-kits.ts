/**
 * Style kits and characters (migration 0047) — the pure, client-safe half.
 *
 * A style kit is 3–12 reference images from the organization's library plus a
 * short description the person writes; a character (or product) is 1–8
 * reference images, a description and an @name. The database is the authority
 * on every rule here (save_style_kit / save_character check membership, that
 * each reference is a live image of the same organization, and the limits);
 * this file checks the same limits first so a form can say what is wrong
 * before a round trip, shapes rows for the page, and maps the database's
 * refusals to words. Unit-tested in tests/style-kits.test.ts.
 */

export const KIT_LIMITS = { minRefs: 3, maxRefs: 12, nameMax: 60, descriptionMax: 2000, perOrg: 50 } as const;
export const CHARACTER_LIMITS = { minRefs: 1, maxRefs: 8, nameMin: 2, nameMax: 32, descriptionMax: 2000, perOrg: 100 } as const;

/** The @name rule, verbatim from 0047's check constraint. */
export const CHARACTER_NAME_RE = /^[a-z0-9_]{2,32}$/;

export type CharacterKind = "character" | "product";
export const CHARACTER_KINDS: readonly CharacterKind[] = ["character", "product"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A canonical lower-case uuid, or null. */
export function parseStyleId(raw: unknown): string | null {
  return typeof raw === "string" && UUID_RE.test(raw) ? raw : null;
}

/** Length in characters as Postgres counts them (code points, not UTF-16 units). */
export function charLength(s: string): number {
  return [...s].length;
}

/** A kit name: control characters removed, trimmed (0047 style_clean_text, single line). */
export function cleanKitName(raw: unknown): string {
  return (typeof raw === "string" ? raw : "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

/** A description: line breaks and tabs kept, other control characters removed, trimmed. */
export function cleanDescription(raw: unknown): string {
  return (typeof raw === "string" ? raw : "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
}

/** "@Hero " -> "hero": what save_character stores. Validity is a separate question. */
export function normalizeCharacterName(raw: unknown): string {
  return (typeof raw === "string" ? raw : "").trim().toLowerCase().replace(/^@/, "");
}

export function isCharacterName(name: string): boolean {
  return CHARACTER_NAME_RE.test(name);
}

// ── input ───────────────────────────────────────────────────────────────────

export type StyleInputError =
  | "bad_request"
  | "invalid_name"
  | "invalid_description"
  | "invalid_kind"
  | "too_few_references"
  | "too_many_references"
  | "duplicate_reference"
  | "invalid_reference";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: StyleInputError };

export interface KitInput {
  name: string;
  description: string;
  assetIds: string[];
}

export interface CharacterInput {
  name: string;
  kind: CharacterKind;
  description: string;
  assetIds: string[];
}

/** An ordered list of distinct asset ids within [min, max]. */
export function parseAssetIds(raw: unknown, min: number, max: number): Parsed<string[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "bad_request" };
  if (raw.length < min) return { ok: false, error: "too_few_references" };
  if (raw.length > max) return { ok: false, error: "too_many_references" };
  const ids: string[] = [];
  for (const v of raw) {
    const id = parseStyleId(v);
    if (!id) return { ok: false, error: "invalid_reference" };
    if (ids.includes(id)) return { ok: false, error: "duplicate_reference" };
    ids.push(id);
  }
  return { ok: true, value: ids };
}

function body(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function description(raw: unknown, max: number): Parsed<string> {
  if (raw !== undefined && raw !== null && typeof raw !== "string") return { ok: false, error: "bad_request" };
  const d = cleanDescription(raw);
  return charLength(d) > max ? { ok: false, error: "invalid_description" } : { ok: true, value: d };
}

/** `{ name, description?, asset_ids }` for POST /api/style-kits and PATCH /api/style-kits/<id>. */
export function parseKitInput(raw: unknown): Parsed<KitInput> {
  const b = body(raw);
  if (!b || typeof b.name !== "string") return { ok: false, error: b ? "invalid_name" : "bad_request" };
  const name = cleanKitName(b.name);
  const n = charLength(name);
  if (n < 1 || n > KIT_LIMITS.nameMax) return { ok: false, error: "invalid_name" };
  const d = description(b.description, KIT_LIMITS.descriptionMax);
  if (!d.ok) return d;
  const ids = parseAssetIds(b.asset_ids, KIT_LIMITS.minRefs, KIT_LIMITS.maxRefs);
  if (!ids.ok) return ids;
  return { ok: true, value: { name, description: d.value, assetIds: ids.value } };
}

/** `{ name, kind?, description?, asset_ids }` for POST /api/characters and PATCH /api/characters/<id>. */
export function parseCharacterInput(raw: unknown): Parsed<CharacterInput> {
  const b = body(raw);
  if (!b || typeof b.name !== "string") return { ok: false, error: b ? "invalid_name" : "bad_request" };
  const name = normalizeCharacterName(b.name);
  if (!isCharacterName(name)) return { ok: false, error: "invalid_name" };
  const kind = b.kind === undefined || b.kind === null ? "character" : b.kind;
  if (!CHARACTER_KINDS.includes(kind as CharacterKind)) return { ok: false, error: "invalid_kind" };
  const d = description(b.description, CHARACTER_LIMITS.descriptionMax);
  if (!d.ok) return d;
  const ids = parseAssetIds(b.asset_ids, CHARACTER_LIMITS.minRefs, CHARACTER_LIMITS.maxRefs);
  if (!ids.ok) return ids;
  return { ok: true, value: { name, kind: kind as CharacterKind, description: d.value, assetIds: ids.value } };
}

/** A channel id as a request may name one; the database decides whether it exists and is the caller's. */
export function parseChannelRef(raw: unknown): string | null {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
}

// ── rows ────────────────────────────────────────────────────────────────────

/** One reference image. `live` is false once the image was deleted from the
 *  library: the row stays (the person sees the gap) but nothing may use it. */
export interface StyleReference {
  assetId: string;
  position: number;
  live: boolean;
  mime: string | null;
  width: number | null;
  height: number | null;
  /** Signed, short-lived; null when this host cannot serve it or the caller asked for none. */
  thumbUrl: string | null;
}

export interface StyleKit {
  id: string;
  name: string;
  description: string;
  createdAt: string | null;
  updatedAt: string | null;
  references: StyleReference[];
}

export interface Character {
  id: string;
  name: string;
  kind: CharacterKind;
  description: string;
  createdAt: string | null;
  updatedAt: string | null;
  references: StyleReference[];
}

/** What the Studio page and a later generation step read (lib/server/style-kits.ts). */
export interface StyleContext {
  /** 0047 applied and readable. */
  available: boolean;
  kits: StyleKit[];
  characters: Character[];
  error?: "read_failed";
}

export const STYLE_KIT_COLUMNS = "id, name, description, created_at, updated_at";
export const CHARACTER_COLUMNS = "id, name, kind, description, created_at, updated_at";

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export interface ReferenceRow {
  owner: string;
  assetId: string;
  position: number;
}

/** style_kit_references / character_references rows -> (owner, asset, position). */
export function coerceReferenceRows(data: unknown, ownerColumn: "kit_id" | "character_id"): ReferenceRow[] {
  if (!Array.isArray(data)) return [];
  const out: ReferenceRow[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const owner = parseStyleId(r[ownerColumn]);
    const assetId = parseStyleId(r.asset_id);
    const position = num(r.position);
    if (!owner || !assetId || position === null) continue;
    out.push({ owner, assetId, position });
  }
  return out;
}

export interface ReferenceAsset {
  mime: string | null;
  width: number | null;
  height: number | null;
  thumbUrl: string | null;
}

/** The references of one owner, in order, each marked live or not by whether its asset is still readable. */
export function referencesFor(owner: string, rows: ReferenceRow[], assets: ReadonlyMap<string, ReferenceAsset>): StyleReference[] {
  return rows
    .filter((r) => r.owner === owner)
    .sort((a, b) => a.position - b.position)
    .map((r) => {
      const a = assets.get(r.assetId);
      return {
        assetId: r.assetId,
        position: r.position,
        live: Boolean(a),
        mime: a?.mime ?? null,
        width: a?.width ?? null,
        height: a?.height ?? null,
        thumbUrl: a?.thumbUrl ?? null,
      };
    });
}

export function coerceKits(data: unknown, refs: ReferenceRow[], assets: ReadonlyMap<string, ReferenceAsset>): StyleKit[] {
  if (!Array.isArray(data)) return [];
  const out: StyleKit[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = parseStyleId(r.id);
    if (!id || typeof r.name !== "string") continue;
    out.push({
      id,
      name: r.name,
      description: typeof r.description === "string" ? r.description : "",
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
      references: referencesFor(id, refs, assets),
    });
  }
  return out;
}

export function coerceCharacters(data: unknown, refs: ReferenceRow[], assets: ReadonlyMap<string, ReferenceAsset>): Character[] {
  if (!Array.isArray(data)) return [];
  const out: Character[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = parseStyleId(r.id);
    if (!id || typeof r.name !== "string") continue;
    out.push({
      id,
      name: r.name,
      kind: r.kind === "product" ? "product" : "character",
      description: typeof r.description === "string" ? r.description : "",
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
      references: referencesFor(id, refs, assets),
    });
  }
  return out;
}

/** The first reference that can still be shown: a card's cover. */
export function coverOf(refs: StyleReference[]): StyleReference | null {
  return refs.find((r) => r.live) ?? null;
}

/** References whose image was deleted from the library since the kit was saved. */
export function missingCount(refs: StyleReference[]): number {
  return refs.filter((r) => !r.live).length;
}

// ── errors ──────────────────────────────────────────────────────────────────

export type StyleError =
  | StyleInputError
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "name_taken"
  | "limit_reached"
  | "org_required"
  | "not_available"
  | "not_configured"
  | "read_failed"
  | "failed";

const INPUT_WORDS: readonly StyleInputError[] = [
  "invalid_name",
  "invalid_description",
  "invalid_kind",
  "too_few_references",
  "too_many_references",
  "duplicate_reference",
  "invalid_reference",
];

/** A refusal from 0047's functions, policies or triggers -> a word and an HTTP status. */
export function mapStyleError(error: { code?: string; message?: string; details?: string } | null | undefined): {
  error: StyleError;
  status: number;
} {
  const word = (error?.message ?? "").trim();
  switch (error?.code) {
    case "NS400":
      return { error: (INPUT_WORDS as readonly string[]).includes(word) ? (word as StyleInputError) : "bad_request", status: 400 };
    case "NS409":
    case "23505":
      return { error: "name_taken", status: 409 };
    case "NS429":
      return { error: "limit_reached", status: 409 };
    case "42501":
      return { error: "forbidden", status: 403 };
    case "P0002":
      return { error: "not_found", status: 404 };
    case "PGRST202":
    case "PGRST205":
    case "42883":
    case "42P01":
    case "42703":
      return { error: "not_available", status: 503 };
  }
  if (/could not find the (function|table)|does not exist/i.test(error?.message ?? "")) return { error: "not_available", status: 503 };
  return { error: "failed", status: 502 };
}

/** Is this read failure "0047 is not applied" (degrade honestly) rather than a failed read? */
export function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    error.code === "42703" ||
    /does not exist|could not find the table/i.test(error.message ?? "")
  );
}
