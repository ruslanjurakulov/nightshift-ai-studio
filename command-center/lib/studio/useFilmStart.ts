import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filmErrorFromResponse, filmsApi, newIdempotencyKey, type FilmError } from "@/lib/films";
import { coerceQuote, startOnce, type FilmQuote, type QuoteBlock } from "@/lib/studio/timeline";

/**
 * The money call of a project, as a state machine any surface can drive (the Brain's Create, later the canvas): the person confirms
 * the server's quote, the start route holds it (0171 start_film), and every answer becomes a state that names its remedy.
 *
 * The browser never prices. The only numbers here are quote_film's total and the balance it read (`available`); the one subtraction
 * is the difference between two server totals, shown so a person can see by how much a re-quoted price moved before confirming it.
 */

/** Why the key cannot start right now. Every reason is listed, never only the first. */
export type BlockReason =
  | { kind: "block"; block: QuoteBlock }
  /** quote_film answered, but a line has no price: its own word (model_not_set, model_not_available…), not "pricing is not live". */
  | { kind: "unpriced"; word: string | null }
  | { kind: "not_admin" }
  | { kind: "no_quote" };

export type PriceChange = { from: number; to: number; delta: number };

export type FilmStartState =
  | { at: "idle"; quote: FilmQuote }
  | { at: "blocked"; quote: FilmQuote | null; reasons: BlockReason[] }
  | { at: "confirming"; quote: FilmQuote; change: PriceChange | null }
  | { at: "starting"; quote: FilmQuote }
  | { at: "started"; replayed: boolean }
  /** A refusal that counted (start_film's `ok: false`) or a route's refused answer. The quote it refused is spent. */
  | { at: "refused"; word: string; remedy: StartRemedy; quote: FilmQuote }
  | { at: "requoting"; from: FilmQuote }
  | { at: "requote_failed"; from: FilmQuote }
  /** No answer: the start may have gone through, so the key is kept and a retry replays the same start. */
  | { at: "network_error"; quote: FilmQuote }
  /** A 401. After signing in (in another tab), the key resumes what was interrupted: the same start, or the re-quote. */
  | { at: "session_expired"; resume: { kind: "start"; quote: FilmQuote } | { kind: "requote"; from: FilmQuote } };

/**
 * What the person can do about a refusal. `requote`: ask for a new price (the old quote is spent). `fix_and_requote`: change the
 * project first. `wait`: the server's state, try again later. `support`: not the person's to fix. `none`: nothing on this screen helps.
 */
export type StartRemedy = "add_credits" | "plans" | "requote" | "fix_and_requote" | "wait" | "support" | "sign_in" | "none";

/**
 * Every word the start and quote paths can answer (start_film, quote_film, film_price, film_precheck, film_check_model, creative_price
 * and the routes' own), with its remedy. tests/film-create-button.test.tsx reads the migrations and fails when a word they can answer
 * has no entry here or no sentence in en/ru/uz. An unknown word is `support`, never a guess at a nearby one.
 */
export const START_REMEDIES: Readonly<Record<string, StartRemedy>> = {
  insufficient_credits: "add_credits",
  entitlement_required: "plans",
  price_changed: "requote",
  quote_expired: "requote",
  film_changed: "requote",
  idempotency_conflict: "requote",
  invalid_idempotency_key: "requote",
  bad_request: "requote",
  reference_missing: "fix_and_requote",
  asset_not_usable: "fix_and_requote",
  acknowledgement_required: "fix_and_requote",
  adult_attestation_required: "fix_and_requote",
  cap_exceeded: "fix_and_requote",
  invalid_params: "fix_and_requote",
  model_not_set: "fix_and_requote",
  prompt_missing: "fix_and_requote",
  refs_not_supported: "fix_and_requote",
  source_unavailable: "fix_and_requote",
  scene_too_long_for_model: "fix_and_requote",
  voice_not_set: "fix_and_requote",
  channel_voice_not_priced: "fix_and_requote",
  no_scenes: "fix_and_requote",
  style_unavailable: "fix_and_requote",
  capability_not_supported: "fix_and_requote",
  unpriced: "fix_and_requote",
  run_slots_full: "wait",
  limit_reached: "wait",
  rate_limited: "wait",
  rate_limit_unavailable: "wait",
  film_studio_disabled: "wait",
  model_not_available: "wait",
  model_not_offered: "wait",
  model_temporarily_off: "wait",
  model_not_sellable: "wait",
  network: "wait",
  hold_refused: "support",
  failed: "support",
  registry_missing: "support",
  not_configured: "support",
  session_expired: "sign_in",
  film_not_startable: "none",
  film_not_editable: "none",
  forbidden: "none",
  not_found: "none",
  org_required: "none",
  not_available: "none",
  scene_has_takes: "none",
  adult_only_service: "none",
};

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function startRemedy(word: string): StartRemedy {
  return own(START_REMEDIES, word) ? START_REMEDIES[word] : "support";
}

/** The model is down or off sale: said as such, because the run will not substitute another one (rule 4). */
export const PROVIDER_DOWN_WORDS = ["model_not_available", "model_not_offered", "model_temporarily_off", "model_not_sellable"] as const;

type Words = Record<string, string>;
/** The dictionaries a reason is looked up in, most specific first. */
export interface ReasonDictionaries {
  create: { errors: Words; unpriced: Words; providerDown: string };
  startFailed: Words;
  creativeErrors: Words;
  filmErrors: Words;
}

/** The sentence for a word, or null when no dictionary has one (the caller then says the generic refusal and offers support). */
export function startReasonText(word: string | null, d: ReasonDictionaries): string | null {
  if (!word) return null;
  if ((PROVIDER_DOWN_WORDS as readonly string[]).includes(word)) return d.create.providerDown;
  for (const dict of [d.create.errors, d.startFailed, d.create.unpriced, d.creativeErrors, d.filmErrors]) {
    if (word !== "other" && own(dict, word)) return dict[word];
  }
  return null;
}

const WORD_RE = /^[a-z0-9_]{1,64}$/;

/** What the quote allows, before anyone presses anything. */
export function stateOfQuote(q: FilmQuote | null): Extract<FilmStartState, { at: "idle" | "blocked" }> {
  if (!q) return { at: "blocked", quote: null, reasons: [{ kind: "no_quote" }] };
  const reasons: BlockReason[] = q.blockedBy.map((block) => ({ kind: "block", block }));
  if (!q.priced) reasons.push({ kind: "unpriced", word: q.refusal });
  else if (!q.mayStart) reasons.push({ kind: "not_admin" });
  if (q.startable && q.quoteId && q.total !== null && reasons.length === 0) return { at: "idle", quote: q };
  if (reasons.length === 0) reasons.push({ kind: "block", block: "other" });
  return { at: "blocked", quote: q, reasons };
}

/** The identity of a quote as far as the screen is concerned: a parent passing a new object for the same answer changes nothing. */
function quoteKey(q: FilmQuote | null) {
  return q ? [q.quoteId, q.total, q.priced, q.startable, q.mayStart, q.blockedBy.join(","), q.refusal, q.available, q.exempt].join("|") : "none";
}

type Sent = { kind: "outcome"; ok: true; replayed: boolean } | { kind: "outcome"; ok: false; word: string } | { kind: "http"; error: FilmError } | { kind: "network" };

/** One POST to the start route. Never throws: no answer is `network`, which is the one case the key must survive. */
async function postStart(filmId: string, quoteId: string, idem: string): Promise<Sent> {
  let res: Response;
  try {
    res = await fetch(`/api/films/${encodeURIComponent(filmId)}/start`, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote_id: quoteId, idem }),
    });
  } catch {
    return { kind: "network" };
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) return { kind: "http", error: filmErrorFromResponse(res.status, json).error };
  const s = (json as { start?: unknown } | null)?.start;
  const r = s && typeof s === "object" ? (s as Record<string, unknown>) : null;
  if (!r) return { kind: "http", error: "failed" };
  if (r.ok === true) return { kind: "outcome", ok: true, replayed: r.replayed === true };
  // The raw word, not coerceStart's narrowed one: start_film also answers a line's own unpriced word (film_price's refusal), and
  // narrowing it to "other" is the "will not start right now" with no remedy that Pixel found.
  return { kind: "outcome", ok: false, word: typeof r.reason === "string" && WORD_RE.test(r.reason) ? r.reason : "unknown" };
}

/** A thrown requote whose message is a FilmError word, so a 401 can be told from a failed read. */
class RequoteError extends Error {}

/**
 * The default re-quote: the project's current version (an edit after the quote is also answered `price_changed`, so the version in
 * the old quote id may be stale), then quote_film at it. Spends nothing.
 */
export async function requoteFilm(filmId: string): Promise<FilmQuote | null> {
  const film = await filmsApi().get(filmId);
  if (!film.ok) throw new RequoteError(film.error);
  let res: Response;
  try {
    res = await fetch(`/api/films/${encodeURIComponent(filmId)}/quote`, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: film.data.film.version }),
    });
  } catch {
    throw new RequoteError("network");
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new RequoteError(filmErrorFromResponse(res.status, json).error);
  return coerceQuote((json as { quote?: unknown } | null)?.quote);
}

export interface UseFilmStart {
  state: FilmStartState;
  /** True once a start or a re-quote has waited 10 s: the screen says "Still working…" instead of looking frozen. */
  slow: boolean;
  /** The main key: opens the confirmation, asks for a new price after a refusal, or retries a start that got no answer. */
  press: () => void;
  confirm: () => void;
  cancel: () => void;
}

export const SLOW_MS = 10_000;

/**
 * `quote`: the server's FilmQuote (coerceQuote of quote_film's answer), or null. `requote`: returns a fresh quote; it defaults to
 * {@link requoteFilm}. `onStarted`: called once per start that went through (a replay included).
 *
 * The idempotency key is minted once per confirmed press and forgotten only after a terminal answer (started, or a refusal): a retry
 * after no answer sends the same key, so it replays the first start instead of holding twice. A second press while one is in flight
 * sends nothing.
 */
export function useFilmStart({
  filmId,
  quote,
  requote,
  onStarted,
}: {
  filmId: string;
  quote: FilmQuote | null;
  requote?: () => Promise<FilmQuote | null>;
  onStarted?: (result: { replayed: boolean }) => void;
}): UseFilmStart {
  const [state, setStateRaw] = useState<FilmStartState>(() => stateOfQuote(quote));
  const stateRef = useRef(state);
  const setState = useCallback((s: FilmStartState) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);
  const [slow, setSlow] = useState(false);

  // The quote a start is sent for. Read inside the starter, so a retry sends the quote of the press it repeats.
  const sending = useRef<FilmQuote | null>(null);
  const starter = useMemo(
    () =>
      startOnce((idem: string) => {
        const q = sending.current;
        if (!q?.quoteId) return Promise.resolve<Sent>({ kind: "http", error: "bad_request" });
        return postStart(filmId, q.quoteId, idem);
      }, newIdempotencyKey),
    [filmId],
  );
  const requoting = useRef(false);
  const requoteRef = useRef(requote);
  requoteRef.current = requote;
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;

  // A new quote from the parent replaces whatever the key showed, unless a start or a re-quote is waiting for its answer (a start
  // that may go through keeps its key) or the start already went through.
  const key = quoteKey(quote);
  const seenKey = useRef(key);
  const latestQuote = useRef(quote);
  latestQuote.current = quote;
  useEffect(() => {
    if (seenKey.current === key) return;
    seenKey.current = key;
    const at = stateRef.current.at;
    if (starter.busy || requoting.current || at === "started" || at === "starting" || at === "network_error") return;
    starter.reset();
    setState(stateOfQuote(latestQuote.current));
  }, [key, starter, setState]);

  // Another project is another press: never carry a key across.
  useEffect(() => () => starter.reset(), [starter]);

  useEffect(() => {
    if (state.at !== "starting" && state.at !== "requoting") return;
    const h = setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      clearTimeout(h);
      setSlow(false);
    };
  }, [state.at]);

  const askAgain = useCallback(
    async (from: FilmQuote) => {
      if (requoting.current || starter.busy) return;
      requoting.current = true;
      setState({ at: "requoting", from });
      try {
        const q = await (requoteRef.current ?? (() => requoteFilm(filmId)))();
        if (!q) {
          setState({ at: "requote_failed", from });
          return;
        }
        const s = stateOfQuote(q);
        if (s.at === "blocked") {
          setState(s);
          return;
        }
        // A new total is never started on the old confirmation: the person confirms it, seeing what it was and how far it moved.
        const change = from.total !== null && q.total !== null ? { from: from.total, to: q.total, delta: q.total - from.total } : null;
        setState({ at: "confirming", quote: q, change });
      } catch (e) {
        if (e instanceof Error && e.message === "session_expired") setState({ at: "session_expired", resume: { kind: "requote", from } });
        else setState({ at: "requote_failed", from });
      } finally {
        requoting.current = false;
      }
    },
    [filmId, starter, setState],
  );

  const send = useCallback(
    async (q: FilmQuote) => {
      sending.current = q;
      setState({ at: "starting", quote: q });
      const out = await starter.run();
      if (out.kind === "network") {
        setState({ at: "network_error", quote: q });
        return;
      }
      if (out.kind === "http" && out.error === "session_expired") {
        // The route answered before the database was asked: nothing started. The key stays with this press for after sign-in.
        setState({ at: "session_expired", resume: { kind: "start", quote: q } });
        return;
      }
      // Every other answer is terminal for this press: the key is forgotten, so the next press can never be read as this one.
      starter.reset();
      if (out.kind === "outcome" && out.ok) {
        setState({ at: "started", replayed: out.replayed });
        onStartedRef.current?.({ replayed: out.replayed });
        return;
      }
      const word = out.kind === "http" ? out.error : out.word;
      if (word === "price_changed" || word === "quote_expired") {
        void askAgain(q);
        return;
      }
      setState({ at: "refused", word, remedy: startRemedy(word), quote: q });
    },
    [starter, askAgain, setState],
  );

  const press = useCallback(() => {
    const s = stateRef.current;
    if (starter.busy || requoting.current) return;
    if (s.at === "idle") setState({ at: "confirming", quote: s.quote, change: null });
    else if (s.at === "network_error") void send(s.quote);
    else if (s.at === "session_expired") void (s.resume.kind === "start" ? send(s.resume.quote) : askAgain(s.resume.from));
    else if (s.at === "refused" && s.remedy !== "none" && s.remedy !== "sign_in") void askAgain(s.quote);
    else if (s.at === "requote_failed") void askAgain(s.from);
  }, [starter, send, askAgain, setState]);

  const confirm = useCallback(() => {
    const s = stateRef.current;
    if (s.at !== "confirming" || starter.busy) return;
    void send(s.quote);
  }, [starter, send]);

  const cancel = useCallback(() => {
    const s = stateRef.current;
    if (s.at !== "confirming") return;
    setState(stateOfQuote(s.quote));
  }, [setState]);

  return { state, slow, press, confirm, cancel };
}
