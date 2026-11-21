/**
 * The create form's unfinished draft: the topic and the three choices (length,
 * voice, look), kept for this tab so a reload does not lose them.
 *
 * Kept deliberately small and cold:
 *   - sessionStorage, not localStorage: it dies with the tab, and a shared
 *     computer's next person does not find it;
 *   - keyed by user, organization AND channel, and each record repeats them: a
 *     record that does not match the current ones is ignored and removed, so
 *     switching organization or channel (or sign-in as someone else) never
 *     shows another tenant's text;
 *   - versioned, 24 hours old at most, and size-capped;
 *   - nothing else is stored — no credentials, no ids beyond the scope, no
 *     price — and nothing here is sent anywhere: no request, no URL, no log.
 *
 * Cleared on a successful create, on "discard", on sign-out and on the sign-in
 * page (clearAllDrafts: every key with the prefix, whatever scope or version).
 */
import { RUN_DURATIONS_S } from "@/lib/home";
import { VOICES } from "@/lib/ttsModels";

export const DRAFT_PREFIX = "nightshift.create.draft.";
export const DRAFT_VERSION = 1;
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
/** The longest record that is written: two 300-character fields and a little over. */
export const DRAFT_MAX_BYTES = 2048;
const FIELD_MAX = 300;

export interface DraftScope {
  userId: string;
  orgId: string;
  channelId: string;
}

/** What the form holds: strings, because that is what its controls hold. */
export interface Draft {
  topic: string;
  /** Seconds as the length control holds them, or "" for the channel's usual. */
  duration: string;
  /** A voice id from the list, or "" for the channel's own. */
  voice: string;
  look: string;
}

interface Stored extends Draft, DraftScope {
  v: number;
  savedAt: number;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** This tab's sessionStorage, or null where it is blocked (private windows, previews). */
export function draftStore(): Store | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

// "." is the separator and encodeURIComponent leaves it alone, so it is escaped too: two scopes never share a key.
const enc = (s: string) => encodeURIComponent(s).replace(/\./g, "%2E");

export function draftKey(scope: DraftScope): string {
  return `${DRAFT_PREFIX}v${DRAFT_VERSION}.${enc(scope.userId)}.${enc(scope.orgId)}.${enc(scope.channelId)}`;
}

const DURATIONS: readonly string[] = ["", ...RUN_DURATIONS_S.map(String)];
const VOICE_IDS: readonly string[] = ["", ...VOICES.map((v) => v.id)];

/** The draft in a stored record, only if every part of it is something the form could have held. */
function valid(raw: unknown, scope: DraftScope, now: number): Draft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Record<keyof Stored, unknown>>;
  if (r.v !== DRAFT_VERSION) return null;
  if (r.userId !== scope.userId || r.orgId !== scope.orgId || r.channelId !== scope.channelId) return null;
  if (typeof r.savedAt !== "number" || !Number.isFinite(r.savedAt) || now - r.savedAt > DRAFT_TTL_MS || r.savedAt > now + 60_000) return null;
  const { topic, duration, voice, look } = r;
  if (typeof topic !== "string" || typeof look !== "string" || typeof duration !== "string" || typeof voice !== "string") return null;
  if (topic.length > FIELD_MAX || look.length > FIELD_MAX) return null;
  if (!DURATIONS.includes(duration) || !VOICE_IDS.includes(voice)) return null;
  return { topic, duration, voice, look };
}

function prefixedKeys(store: Store): string[] {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith(DRAFT_PREFIX)) keys.push(k);
  }
  return keys;
}

/**
 * This scope's draft, or null. Every OTHER draft in the tab — another user's,
 * organization's or channel's, an older version, an expired or malformed one —
 * is removed on the way, so a draft never outlives the context it was typed in.
 */
export function readDraft(store: Store | null, scope: DraftScope, now = Date.now()): Draft | null {
  if (!store) return null;
  try {
    const mine = draftKey(scope);
    let found: Draft | null = null;
    for (const k of prefixedKeys(store)) {
      let ok: Draft | null = null;
      if (k === mine) {
        try {
          ok = valid(JSON.parse(store.getItem(k) ?? "null"), scope, now);
        } catch {
          ok = null;
        }
      }
      if (ok) found = ok;
      else store.removeItem(k);
    }
    return found;
  } catch {
    return null;
  }
}

/** Save the draft, or remove it when it is empty (or would not fit the cap). */
export function writeDraft(store: Store | null, scope: DraftScope, draft: Draft, now = Date.now()): void {
  if (!store) return;
  try {
    const rec: Stored = {
      v: DRAFT_VERSION,
      userId: scope.userId,
      orgId: scope.orgId,
      channelId: scope.channelId,
      savedAt: now,
      topic: draft.topic.slice(0, FIELD_MAX),
      duration: draft.duration,
      voice: draft.voice,
      look: draft.look.slice(0, FIELD_MAX),
    };
    const json = JSON.stringify(rec);
    if (json.length > DRAFT_MAX_BYTES) store.removeItem(draftKey(scope));
    else store.setItem(draftKey(scope), json);
  } catch {
    // Storage full or blocked: the draft lives for this visit only.
  }
}

export function clearDraft(store: Store | null, scope: DraftScope): void {
  try {
    store?.removeItem(draftKey(scope));
  } catch {
    /* nothing to clear */
  }
}

/** Sign-out and the sign-in page: every draft in this tab, whoever's it was. */
export function clearAllDrafts(store: Store | null = draftStore()): void {
  if (!store) return;
  try {
    for (const k of prefixedKeys(store)) store.removeItem(k);
  } catch {
    /* nothing to clear */
  }
}
